import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import type { ConductorConfig } from "../config.js";
import type { ConcurrencyLimiter } from "../sdk/concurrency.js";
import type { Logger } from "../sdk/logger.js";
import type { Session, SessionEvent, SessionState } from "../types.js";
import type { EventBus } from "./events.js";
import { acceptTrustPrompt, hiveNew, hiveRecycle } from "./hive-client.js";
import { sessionEventsDir } from "./ipc.js";
import { type TransitionOpts, transition } from "./lifecycle.js";

// ── Hook injection helpers ────────────────────────────────────────────────────

// Returns the absolute command prefix for conductor signal invocations.
// When running from source via `bun run` (dev mode), process.argv[1] is the
// .ts entry point; we use `bun <script>` so the hook resolves without
// `conductor` on PATH. When running as a compiled binary, process.execPath
// is the binary itself.
export function resolveSignalInvocation(): string {
  if (process.argv[1]?.endsWith(".ts")) {
    return `${process.execPath} ${process.argv[1]}`;
  }
  return process.execPath;
}

// A single hook matcher entry as Claude Code stores it: a group of one or more
// command hooks. We only ever inject command hooks, so this narrow shape is enough.
type HookEntry = { hooks?: Array<{ type?: string; command?: string }> };

// Returns true if any command hook inside the entry matches `command`.
function entryHasCommand(entry: unknown, command: string): boolean {
  const hooks = (entry as HookEntry)?.hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h) => h?.command === command);
}

// Appends conductor's command hook to a pre-existing hook array without dropping
// the caller's entries. Deduplicates by command string so re-injection is idempotent.
function appendHook(existing: unknown, command: string): HookEntry[] {
  const arr = Array.isArray(existing) ? (existing as HookEntry[]) : [];
  if (arr.some((entry) => entryHasCommand(entry, command))) return arr;
  return [...arr, { hooks: [{ type: "command", command }] }];
}

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
  const invocation = resolveSignalInvocation();
  const stopCommand = `${invocation} signal stop --session ${sessionId}`;
  const activityCommand = `${invocation} signal activity --session ${sessionId}`;

  existing.hooks = {
    ...hooks,
    Stop: appendHook(hooks.Stop, stopCommand),
    PostToolUse: appendHook(hooks.PostToolUse, activityCommand),
  };

  const permissions = (existing.permissions as Record<string, unknown> | undefined) ?? {};
  const allow = (permissions.allow as string[] | undefined) ?? [];
  const allowEntries = [`Bash(${stopCommand})`, `Bash(${activityCommand})`];
  existing.permissions = {
    ...permissions,
    allow: [...allow, ...allowEntries.filter((entry) => !allow.includes(entry))],
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
  idleTimeoutMs?: number,
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
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
  };
}

/**
 * Returns a copy of `session` moved to `nextState` with active/idle timestamps
 * stamped. `activeSince` marks the start of the current active period;
 * `idleSince` marks the start of the current idle period. Each is stamped only
 * when the session *enters* the corresponding state, so a self-transition
 * (e.g. ACTIVE+PostToolUse) preserves the original start time. Entering ACTIVE
 * clears `idleSince`.
 */
export function applyStateTimestamps(session: Session, nextState: SessionState, now: Date): Session {
  if (nextState === session.state) {
    return { ...session, state: nextState };
  }
  if (nextState === "ACTIVE") {
    // Entering ACTIVE starts a fresh active period and clears any idle marker.
    const { idleSince, ...rest } = session;
    return { ...rest, state: nextState, activeSince: now };
  }
  if (nextState === "IDLE") {
    return { ...session, state: nextState, idleSince: now };
  }
  return { ...session, state: nextState };
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
        tags: ["conductor"],
      });

      // Ensure events dir exists
      mkdirSync(sessionEventsDir(id), { recursive: true });

      if (!existed) {
        await this.acceptTrustOrRecycle(id, workDir, opts);

        await injectHooks(workDir, id);

        if (preTemplate) {
          await injectPrePrompt(workDir, preTemplate);
        }
      }

      const session = buildSession(id, opts.name, opts.pluginId, workDir, false, opts.idleTimeoutMs);
      this.sessions.set(id, session);

      await this.eventBus.emit("sessionCreated", { session });
      return session;
    } finally {
      release();
    }
  }

  // Accepts Claude Code's first-run trust dialog for a freshly created session.
  // If the prompt cannot be cleared the session would hang on the dialog
  // forever, emitting no signals while looking healthy. In that case we emit
  // sessionError for observability, recycle the orphaned hive session so a
  // retry starts from a clean pane, and rethrow so the caller can back off.
  private async acceptTrustOrRecycle(id: string, workDir: string, opts: CreateSessionOptions): Promise<void> {
    try {
      await acceptTrustPrompt(opts.name, workDir, this.logger ? { logger: this.logger } : {});
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await this.eventBus.emit("sessionError", {
        session: buildSession(id, opts.name, opts.pluginId, workDir, false),
        error,
      });
      try {
        await hiveRecycle(id);
      } catch (recycleErr) {
        this.logger?.warn("failed to recycle session after trust failure", {
          sessionId: id,
          error: recycleErr instanceof Error ? recycleErr.message : String(recycleErr),
        });
      }
      try {
        rmSync(sessionEventsDir(id), { recursive: true, force: true });
      } catch {
        // best-effort — ignore unexpected errors
      }
      throw error;
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

    const idleTimeoutMs = session.idleTimeoutMs ?? this.config.idleTimeoutMs;

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

    // Update session state in place, stamping active/idle timestamps on entry.
    const updatedSession = applyStateTimestamps(session, result.nextState, new Date());
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
      // Delete only the events subdir so a reused session ID starts clean.
      // Runs in finally to guarantee cleanup even when hiveRecycle throws.
      try {
        rmSync(sessionEventsDir(session.id), { recursive: true, force: true });
      } catch {
        // best-effort — ignore unexpected errors
      }
    }
  }

  /** Cancel all idle timers — called on daemon shutdown. */
  shutdown(): void {
    for (const sessionId of this.idleTimers.keys()) {
      this.cancelIdleTimer(sessionId);
    }
  }
}
