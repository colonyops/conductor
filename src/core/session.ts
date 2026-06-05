import { mkdirSync, symlinkSync } from "node:fs";
import type { ConductorConfig } from "../config.js";
import type { ConcurrencyLimiter } from "../sdk/concurrency.js";
import type { Logger } from "../sdk/logger.js";
import type { Session, SessionEvent } from "../types.js";
import type { EventBus } from "./events.js";
import { hiveNew, hiveRecycle } from "./hive-client.js";
import { sessionEventsDir } from "./ipc.js";
import { type TransitionOpts, transition } from "./lifecycle.js";

// ── Hook injection helpers ────────────────────────────────────────────────────

export async function injectHooks(workDir: string, sessionId: string): Promise<void> {
  const claudeDir = `${workDir}/.claude`;
  const settingsPath = `${claudeDir}/settings.local.json`;
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

  const permissions = (existing.permissions as Record<string, unknown> | undefined) ?? {};
  const allow = (permissions.allow as string[] | undefined) ?? [];
  existing.permissions = {
    ...permissions,
    allow: [
      ...allow,
      `Bash(conductor signal stop --session ${sessionId})`,
      `Bash(conductor signal activity --session ${sessionId})`,
    ],
  };

  mkdirSync(claudeDir, { recursive: true });
  await Bun.write(settingsPath, `${JSON.stringify(existing, null, 2)}\n`);

  // Exclude from git to prevent agents from accidentally committing it.
  // .git/info/exclude works like .gitignore but is never tracked.
  const gitExcludePath = `${workDir}/.git/info/exclude`;
  const excludeEntry = ".claude/settings.local.json";
  try {
    const current = await Bun.file(gitExcludePath).text();
    if (!current.includes(excludeEntry)) {
      await Bun.write(gitExcludePath, `${current.trimEnd()}\n${excludeEntry}\n`);
    }
  } catch {
    // Not a git repo or .git/info/exclude doesn't exist — skip
  }
}

export async function injectPrePrompt(workDir: string, template: string): Promise<void> {
  const agentsPath = `${workDir}/agents.md`;
  await Bun.write(agentsPath, `${template}\n`);
  try {
    symlinkSync("agents.md", `${workDir}/CLAUDE.md`);
  } catch {
    // CLAUDE.md already exists
  }
}

export function buildPromptWithTemplates(
  context: string | undefined,
  preTemplate: string | undefined,
  postTemplate: string | undefined,
): string | undefined {
  if (!preTemplate && !postTemplate) return context;
  const parts: string[] = [];
  if (preTemplate) parts.push(preTemplate);
  if (context) parts.push(context);
  if (postTemplate) parts.push(postTemplate);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
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
  agent?: string;
  idleTimeoutMs?: number;
  prePromptOverride?: string;
  postPromptOverride?: string;
}

export interface SessionManagerDeps {
  config: ConductorConfig;
  eventBus: EventBus;
  globalLimiter: ConcurrencyLimiter;
  logger?: Logger;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly config: ConductorConfig;
  private readonly eventBus: EventBus;
  private readonly globalLimiter: ConcurrencyLimiter;
  private readonly logger: Logger | undefined;

  constructor(deps: SessionManagerDeps) {
    this.config = deps.config;
    this.eventBus = deps.eventBus;
    this.globalLimiter = deps.globalLimiter;
    this.logger = deps.logger;
  }

  async createSession(opts: CreateSessionOptions): Promise<Session> {
    const release = await this.globalLimiter.acquire();
    try {
      const preTemplate = opts.prePromptOverride ?? this.config.prePromptTemplate;
      const postTemplate = opts.postPromptOverride ?? this.config.postPromptTemplate;
      const prompt = buildPromptWithTemplates(opts.context, preTemplate, postTemplate);

      const { id, workDir, existed } = await hiveNew({
        name: opts.name,
        remote: opts.remote,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
      });

      // Ensure events dir exists
      mkdirSync(sessionEventsDir(id), { recursive: true });

      if (!existed) {
        await injectHooks(workDir, id);

        if (preTemplate) {
          await injectPrePrompt(workDir, preTemplate);
        }
      }

      const session = buildSession(id, opts.name, opts.pluginId, workDir, false);
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
      this.config.plugins.find((p) => p.path === session.pluginId)?.idleTimeoutMs ?? this.config.idleTimeoutMs;

    const transitionOpts: Parameters<typeof transition>[2] = { idleTimeoutMs };
    if (opts.isApprovalPending !== undefined) {
      transitionOpts.isApprovalPending = opts.isApprovalPending;
    }
    const result = transition(session, event, transitionOpts);

    if (result.nextState !== session.state) {
      this.logger?.info("session state transition", {
        sessionId,
        from: session.state,
        to: result.nextState,
        event,
      });
    }

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
