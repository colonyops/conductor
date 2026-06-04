import { mkdirSync } from "node:fs";
import type { ConductorConfig } from "../config.js";
import type { ConcurrencyLimiter } from "../sdk/concurrency.js";
import type { Session, SessionEvent } from "../types.js";
import type { EventBus } from "./events.js";
import { hiveNew, hiveRecycle } from "./hive-client.js";
import { CONDUCTOR_DATA_DIR, sessionEventsDir } from "./ipc.js";
import { type TransitionOpts, transition } from "./lifecycle.js";

// ── Hook / pre-prompt injection helpers ──────────────────────────────────────

const CONDUCTOR_MARKER_START = "<!-- conductor:start -->";
const CONDUCTOR_MARKER_END = "<!-- conductor:end -->";

export async function injectHooks(
  workDir: string,
  sessionId: string,
): Promise<void> {
  const settingsPath = `${workDir}/.claude/settings.json`;
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await Bun.file(settingsPath).text());
  } catch {
    // file doesn't exist yet — start fresh
  }

  const hooks = (existing.hooks as Record<string, unknown> | undefined) ?? {};

  existing.hooks = {
    ...hooks,
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: `conductor signal stop --session ${sessionId}`,
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          {
            type: "command",
            command: `conductor signal activity --session ${sessionId}`,
          },
        ],
      },
    ],
  };

  mkdirSync(`${workDir}/.claude`, { recursive: true });
  await Bun.write(settingsPath, `${JSON.stringify(existing, null, 2)}\n`);
}

export async function injectPrePrompt(
  workDir: string,
  template: string,
): Promise<void> {
  const claudeMdPath = `${workDir}/CLAUDE.md`;
  let content = "";
  try {
    content = await Bun.file(claudeMdPath).text();
  } catch {
    // file doesn't exist — will be created
  }

  const block = `${CONDUCTOR_MARKER_START}\n${template}\n${CONDUCTOR_MARKER_END}`;

  if (content.includes(CONDUCTOR_MARKER_START)) {
    const re = new RegExp(
      `${CONDUCTOR_MARKER_START}[\\s\\S]*?${CONDUCTOR_MARKER_END}`,
      "g",
    );
    content = content.replace(re, block);
  } else {
    content = block + (content ? `\n\n${content}` : "");
  }

  await Bun.write(claudeMdPath, content);
}

export function buildSession(
  id: string,
  name: string,
  pluginId: string,
  workDir: string,
  isEphemeral: boolean,
): Session {
  const eventsDir = sessionEventsDir(id);
  return {
    id,
    name,
    state: "CREATED",
    pluginId,
    createdAt: new Date(),
    eventsDir,
    workDir,
    isEphemeral,
  };
}

// ── SessionManager ────────────────────────────────────────────────────────────

export interface CreateSessionOptions {
  name: string;
  remote: string;
  pluginId: string;
  context?: string;
  cloneStrategy?: "full" | "worktree";
  agent?: string;
  idleTimeoutMs?: number;
  prePromptOverride?: string;
}

export interface SessionManagerDeps {
  config: ConductorConfig;
  eventBus: EventBus;
  globalLimiter: ConcurrencyLimiter;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly config: ConductorConfig;
  private readonly eventBus: EventBus;
  private readonly globalLimiter: ConcurrencyLimiter;

  constructor(deps: SessionManagerDeps) {
    this.config = deps.config;
    this.eventBus = deps.eventBus;
    this.globalLimiter = deps.globalLimiter;
  }

  async createSession(opts: CreateSessionOptions): Promise<Session> {
    const release = await this.globalLimiter.acquire();
    try {
      const hiveArgs: Parameters<typeof hiveNew>[0] = {
        name: opts.name,
        remote: opts.remote,
        background: true,
      };
      if (opts.cloneStrategy) hiveArgs.cloneStrategy = opts.cloneStrategy;
      if (opts.agent) hiveArgs.agent = opts.agent;
      const { id, workDir } = await hiveNew(hiveArgs);

      // Ensure events dir exists
      mkdirSync(sessionEventsDir(id), { recursive: true });

      await injectHooks(workDir, id);

      const template = opts.prePromptOverride ?? this.config.prePromptTemplate;
      if (template) {
        await injectPrePrompt(workDir, template);
      }

      const session = buildSession(
        id,
        opts.name,
        opts.pluginId,
        workDir,
        false,
      );
      this.sessions.set(id, session);

      await this.eventBus.emit("sessionCreated", { session });
      return session;
    } finally {
      release();
    }
  }

  listSessions(): Session[] {
    return [...this.sessions.values()];
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  async applyTransition(
    sessionId: string,
    event: SessionEvent,
    opts: Pick<TransitionOpts, "isApprovalPending"> = {},
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const idleTimeoutMs =
      this.config.plugins.find((p) => p.path === session.pluginId)
        ?.idleTimeoutMs ?? this.config.idleTimeoutMs;

    const transitionOpts: Parameters<typeof transition>[2] = { idleTimeoutMs };
    if (opts.isApprovalPending !== undefined) {
      transitionOpts.isApprovalPending = opts.isApprovalPending;
    }
    const result = transition(session, event, transitionOpts);

    // Update session state in place
    const updatedSession: Session = { ...session, state: result.nextState };
    this.sessions.set(sessionId, updatedSession);

    // Execute side effects in order
    for (const action of result.actions) {
      switch (action.type) {
        case "startIdleTimer": {
          this.cancelIdleTimer(action.sessionId);
          const timer = setTimeout(() => {
            void this.applyTransition(action.sessionId, "IdleTimeout");
          }, action.timeoutMs);
          this.idleTimers.set(action.sessionId, timer);
          break;
        }
        case "cancelIdleTimer": {
          this.cancelIdleTimer(action.sessionId);
          break;
        }
        case "emitSessionActive": {
          await this.eventBus.emit("sessionActive", {
            session: updatedSession,
          });
          break;
        }
        case "emitSessionIdle": {
          await this.eventBus.emit("sessionIdle", { session: updatedSession });
          break;
        }
        case "emitSessionComplete": {
          await this.eventBus.emit("sessionComplete", {
            session: updatedSession,
          });
          break;
        }
        case "emitSessionApproval": {
          await this.eventBus.emit("sessionApproval", {
            session: updatedSession,
          });
          break;
        }
        case "triggerCleanup": {
          await this.recycleSession(updatedSession);
          break;
        }
      }
    }
  }

  private cancelIdleTimer(sessionId: string): void {
    const timer = this.idleTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.idleTimers.delete(sessionId);
    }
  }

  private async recycleSession(session: Session): Promise<void> {
    try {
      await hiveRecycle(session.id);
      await this.eventBus.emit("sessionRecycled", { session });
    } catch (err) {
      await this.eventBus.emit("sessionError", {
        session,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    } finally {
      this.sessions.delete(session.id);
      this.cancelIdleTimer(session.id);
    }
  }

  /** Cancel all idle timers — called on daemon shutdown. */
  shutdown(): void {
    for (const sessionId of this.idleTimers.keys()) {
      this.cancelIdleTimer(sessionId);
    }
  }
}
