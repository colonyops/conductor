import type { HiveClient } from "./sdk/hive.js";
import type { HttpClient } from "./sdk/http.js";
import type { KVStore } from "./sdk/kv.js";
import type { Logger } from "./sdk/logger.js";
import type { Scheduler } from "./sdk/scheduler.js";
import type { SecretsClient } from "./sdk/secrets.js";

// ── Session ──────────────────────────────────────────────────────────────────

export type SessionState = "CREATED" | "ACTIVE" | "IDLE" | "APPROVAL" | "COMPLETE";

export type SessionEvent = "PostToolUse" | "Stop" | "IdleTimeout" | "ApprovalResolved";

export interface Session {
  id: string;
  name: string;
  state: SessionState;
  pluginId: string;
  createdAt: Date;
  activeSince?: Date;
  idleSince?: Date;
  eventsDir: string;
  workDir: string;
  isEphemeral: boolean;
  /**
   * Effective idle timeout for this session, resolved at creation from the
   * per-session override (NewSessionOptions) falling back to the owning
   * plugin's configured `idleTimeoutMs`. Undefined means use the global
   * `config.idleTimeoutMs`.
   */
  idleTimeoutMs?: number;
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export interface PluginMeta {
  id: string;
  name: string;
  version?: string;
  requiredSecrets?: string[];
}

export interface PluginModule {
  default: Plugin;
}

export interface Plugin extends PluginMeta {
  init(ctx: PluginContext): Promise<void>;
}

export interface PluginContext {
  kv: KVStore;
  hive: HiveClient;
  secrets: SecretsClient;
  scheduler: Scheduler;
  logger: Logger;
  http: HttpClient;
}

// ── IPC Events ───────────────────────────────────────────────────────────────

export type IpcSignal = "activity" | "stop" | "stop:approval";

export interface IpcEvent {
  signal: IpcSignal;
  sessionId: string;
  timestamp: string;
}

// ── Core Events ──────────────────────────────────────────────────────────────

export type CoreEventName =
  | "sessionCreated"
  | "sessionActive"
  | "sessionIdle"
  | "sessionComplete"
  | "sessionRecycled"
  | "sessionApproval"
  | "sessionError"
  | "conductorStart"
  | "conductorStop"
  | "pluginError";

export interface CoreEventPayloads {
  sessionCreated: { session: Session };
  sessionActive: { session: Session };
  sessionIdle: { session: Session };
  sessionComplete: { session: Session };
  sessionRecycled: { session: Session };
  sessionApproval: { session: Session };
  sessionError: { session: Session; error: Error };
  conductorStart: Record<string, never>;
  conductorStop: Record<string, never>;
  pluginError: { plugin: PluginMeta; error: Error };
}

export type CoreEventPayload<E extends CoreEventName> = CoreEventPayloads[E];
