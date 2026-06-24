import type { PluginMetrics } from "./core/observability.js";
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
  /**
   * Opaque plugin-supplied data attached at `newSession()`, carried on the
   * session and persisted to the `meta.json` sidecar so it survives daemon
   * restarts. Lets a plugin attribute a session (e.g. to a repo or issue)
   * without a separate KV side-table. Conductor never reads its contents.
   */
  metadata?: Record<string, unknown>;
}

// ── Plugin ───────────────────────────────────────────────────────────────────

/**
 * A required-secret declaration. A bare string is shorthand for keychain-only
 * resolution of that key. The object form carries the same resolution options
 * `ctx.secrets.get` accepts, so a secret sourced from an env var or a CLI
 * validates before `init` instead of being treated as missing.
 */
export interface RequiredSecret {
  key: string;
  /** Env var to try first (matches GetSecretOptions.env). */
  env?: string;
  /** Try `gh auth token` before the keychain (matches GetSecretOptions.ghCLI). */
  ghCLI?: boolean;
  /** Run this argv and take stdout as the token (matches GetSecretOptions.cliToken). */
  cliToken?: string[];
}

export interface PluginMeta {
  id: string;
  name: string;
  version?: string;
  requiredSecrets?: Array<string | RequiredSecret>;
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
  metrics: PluginMetrics;
  /**
   * Opaque per-plugin configuration from the plugin's config entry (`config`
   * field). Undefined when the entry declares none. The plugin owns its shape
   * and validation — Conductor passes it through untouched.
   */
  config?: unknown;
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
