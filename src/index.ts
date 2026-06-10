#!/usr/bin/env bun
import { Command } from "commander";
import { loadConfig, resolveConfigPath, resolvePath } from "./config.js";
import { EventBus } from "./core/events.js";
import { conductorDataDir, isApprovalSignal, watchIpcEvents, writeIpcEvent } from "./core/ipc.js";
import { createMetrics, startMetricsServer } from "./core/observability.js";
import { SessionManager, resolveSignalInvocation } from "./core/session.js";
import { loadPlugins, unloadPlugins } from "./plugins/loader.js";
import type { PluginRegistration } from "./plugins/loader.js";
import { createConcurrencyLimiter } from "./sdk/concurrency.js";
import { openKVDatabase } from "./sdk/kv.js";
import { createLogger } from "./sdk/logger.js";
import { createSecretsClient } from "./sdk/secrets.js";
import type { IpcSignal, SessionEvent } from "./types.js";

const PLUGIN_DOCS = `
# Conductor Plugin SDK Reference

Plugins are TypeScript files with a default export created via \`definePlugin\`.
Each plugin implements a single \`init(ctx)\` method; all work (polling, event
subscriptions) is set up inside \`init\` and persists for the daemon's lifetime.

## Minimal plugin skeleton

\`\`\`ts
import { definePlugin } from "@conductor/sdk";

export default definePlugin({
  id: "my-org.my-plugin",   // unique, stable identifier
  name: "My Plugin",
  version: "1.0.0",         // optional
  requiredSecrets: [],       // secret keys that must resolve before init runs

  async init(ctx) {
    // set up polling, event listeners, etc.
  },
});
\`\`\`

Register the file in conductor.config.json:

\`\`\`json
{
  "plugins": [
    {
      "path": "./plugins/my-plugin.ts",
      "enabled": true,
      "idleTimeoutMs": 300000,
      "concurrencyLimit": 3
    }
  ]
}
\`\`\`

On first load, Conductor computes a SHA-256 hash of the file and prompts for
approval **before importing the module** (importing runs its top-level code, so
trust is established from the file bytes first). Approved hashes are written back
to \`trustedPlugins\` in the config, keyed by the config-declared \`path\`. If the
file changes, the hash no longer matches and you are re-prompted on next startup.

---

## PluginMeta fields

| Field | Type | Required | Description |
|---|---|---|---|
| \`id\` | string | yes | Stable unique identifier, e.g. \`"acme.github-issues"\` |
| \`name\` | string | yes | Human-readable display name |
| \`version\` | string | no | Semver string |
| \`requiredSecrets\` | string[] | no | Keys that must resolve; plugin is skipped if any fail |

---

## PluginContext — services injected into init()

\`\`\`ts
interface PluginContext {
  kv:        KVStore;
  hive:      HiveClient;
  secrets:   SecretsClient;
  scheduler: Scheduler;
  logger:    Logger;
  http:      HttpClient;
  metrics:   PluginMetrics;   // register plugin-namespaced Prometheus metrics
}
\`\`\`

---

### ctx.kv — KVStore

Persistent key-value store backed by SQLite, scoped to this plugin. Keys are
arbitrary strings; values are JSON-serialisable.

\`\`\`ts
interface KVStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
  clear(): Promise<void>;
}
\`\`\`

Example:

\`\`\`ts
await ctx.kv.set("seen:42", { sessionId, createdAt: new Date().toISOString() });
const entry = await ctx.kv.get<{ sessionId: string }>("seen:42");
const allKeys = await ctx.kv.keys("seen:");
\`\`\`

---

### ctx.hive — HiveClient

Create and observe sessions. All \`onSession*\` methods return an unsubscribe
function; call it to remove the listener.

\`\`\`ts
interface NewSessionOptions {
  name:               string;
  remote:             string;          // git remote URL
  context?:           string;          // initial task prompt for the session
  agent?:             string;
  idleTimeoutMs?:     number;          // overrides config for this session only
  prePromptOverride?: string;          // replaces the global prePromptTemplate for this session
  postPromptOverride?: string;         // replaces the global postPromptTemplate for this session
}

interface HiveClient {
  newSession(opts: NewSessionOptions): Promise<Session>;
  listSessions(): Session[];

  onSessionCreated(handler: (p: { session: Session }) => Promise<void>): () => void;
  onSessionActive(handler:  (p: { session: Session }) => Promise<void>): () => void;
  onSessionIdle(handler:    (p: { session: Session }) => Promise<void>): () => void;
  onSessionComplete(handler:(p: { session: Session }) => Promise<void>): () => void;
  onSessionRecycled(handler:(p: { session: Session }) => Promise<void>): () => void;
  onSessionApproval(handler:(p: { session: Session }) => Promise<void>): () => void;
  onSessionError(handler:   (p: { session: Session; error: Error }) => Promise<void>): () => void;
}
\`\`\`

Session object shape:

\`\`\`ts
interface Session {
  id:           string;
  name:         string;
  state:        "CREATED" | "ACTIVE" | "IDLE" | "APPROVAL" | "COMPLETE";
  pluginId:     string;
  createdAt:    Date;
  activeSince?: Date;
  idleSince?:   Date;
  eventsDir:    string;
  workDir:      string;
  isEphemeral:  boolean;
}
\`\`\`

Example:

\`\`\`ts
const session = await ctx.hive.newSession({
  name: "issue-123",
  remote: "https://github.com/owner/repo",
  context: "Fix the bug described in issue #123",
});

ctx.hive.onSessionComplete(async ({ session }) => {
  ctx.logger.info("done", { id: session.id });
});
\`\`\`

---

### ctx.secrets — SecretsClient

Resolve secrets from environment variables, the \`gh\` CLI, the OS keychain
(macOS \`security\`, Linux \`secret-tool\`), or interactive stdin prompt.
Resolution order: env (if \`env\` set) → \`gh auth token\` (if \`ghCLI\`) →
OS keychain → interactive prompt (if \`promptIfMissing\`).

\`\`\`ts
interface GetSecretOptions {
  env?:             string;    // env var name to try first
  ghCLI?:           boolean;   // try \`gh auth token\` before the keychain
  promptIfMissing?: boolean;   // prompt the user interactively if not found
}

interface SecretsClient {
  get(key: string, opts?: GetSecretOptions): Promise<string>;
  set(key: string, value: string): Promise<void>;   // stores in OS keychain
}
\`\`\`

Example:

\`\`\`ts
// Tries GITHUB_TOKEN env var first, then OS keychain "github.token"
const token = await ctx.secrets.get("github.token", { env: "GITHUB_TOKEN" });
\`\`\`

Declare keys in \`requiredSecrets\` so Conductor validates they resolve before
calling \`init\`:

\`\`\`ts
export default definePlugin({
  id: "my-org.my-plugin",
  name: "My Plugin",
  requiredSecrets: ["my-api-key"],
  async init(ctx) {
    const key = await ctx.secrets.get("my-api-key"); // guaranteed to resolve
  },
});
\`\`\`

---

### ctx.scheduler — Scheduler

Register recurring jobs. All jobs are automatically cancelled on plugin teardown.

\`\`\`ts
interface SchedulerHandle {
  cancel(): void;
}

interface Scheduler {
  // Fire fn immediately (default), then every intervalMs milliseconds.
  // Pass { immediate: false } to skip the first fire.
  interval(
    intervalMs: number,
    fn: () => Promise<void>,
    opts?: { immediate?: boolean },
  ): SchedulerHandle;

  // Fire fn once per day at each "HH:MM" time (local, 24-hour clock).
  // Misses (daemon was stopped) are skipped.
  schedule(times: string[], fn: () => Promise<void>): SchedulerHandle;

  cancelAll(): void;
}
\`\`\`

Example:

\`\`\`ts
// Poll every 5 minutes
ctx.scheduler.interval(5 * 60 * 1000, async () => {
  await poll();
});

// Run a daily report at 09:00 and 17:00
ctx.scheduler.schedule(["09:00", "17:00"], async () => {
  await sendReport();
});
\`\`\`

---

### ctx.logger — Logger

Structured JSON logger. Writes to the configured log file with automatic
rotation. Outputs coloured text to stderr when attached to a TTY.

\`\`\`ts
interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string,  data?: Record<string, unknown>): void;
  warn(msg: string,  data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}
\`\`\`

Example:

\`\`\`ts
ctx.logger.info("poll complete", { found: 3, skipped: 1 });
ctx.logger.error("API call failed", { status: 503, url });
\`\`\`

---

### ctx.http — HttpClient

HTTP client with interceptor support and automatic request/response logging.

\`\`\`ts
interface HttpRequestArgs {
  url: string;
  headers?: Record<string, string>;
  body?: unknown;           // serialised to JSON automatically
  timeout?: number;         // milliseconds
}

interface HttpResponse<T> {
  status: number;
  headers: Record<string, string>;
  data: T;
}

interface HttpClient {
  get<T>(args: HttpRequestArgs): Promise<HttpResponse<T>>;
  post<T>(args: HttpRequestArgs): Promise<HttpResponse<T>>;
  put<T>(args: HttpRequestArgs): Promise<HttpResponse<T>>;
  patch<T>(args: HttpRequestArgs): Promise<HttpResponse<T>>;
  delete<T>(args: HttpRequestArgs): Promise<HttpResponse<T>>;

  withBearer(tokenFn: () => string | null | Promise<string | null>): HttpClient;
  withRequestInterceptor(fn: RequestInterceptor): HttpClient;
  withResponseInterceptor(fn: ResponseInterceptor): HttpClient;
}
\`\`\`

Example:

\`\`\`ts
const client = ctx.http.withBearer(async () => token);

const res = await client.get<{ items: Item[] }>({
  url: "https://api.example.com/items",
});
console.log(res.data.items);
\`\`\`

---

### ctx.metrics — PluginMetrics

Register custom Prometheus metrics. Each metric name is automatically prefixed
with \`conductor_plugin_<sanitized_plugin_id>_\`, so two plugins can never
collide — do NOT include that prefix yourself. Metrics render at the same
\`/metrics\` endpoint as core metrics. Registration is idempotent (same name
returns the existing instance); re-registering a name under a different metric
type throws. A plugin's metrics are removed from the registry when it unloads.

\`\`\`ts
interface PluginMetricOptions {
  name: string;          // namespaced automatically; no conductor_plugin_ prefix
  help: string;
  labelNames?: string[];
}
interface PluginHistogramOptions extends PluginMetricOptions {
  buckets?: number[];
}
interface PluginMetrics {
  counter(opts: PluginMetricOptions): Counter<string>;     // prom-client instances
  gauge(opts: PluginMetricOptions): Gauge<string>;
  histogram(opts: PluginHistogramOptions): Histogram<string>;
}
\`\`\`

Example:

\`\`\`ts
const polls = ctx.metrics.counter({ name: "polls_total", help: "Poll attempts", labelNames: ["result"] });
const pollMs = ctx.metrics.histogram({ name: "poll_duration_ms", help: "Poll duration", buckets: [50, 100, 500, 1000, 5000] });

ctx.scheduler.interval(60_000, async () => {
  const end = pollMs.startTimer();
  try { await poll(); polls.inc({ result: "ok" }); }
  catch { polls.inc({ result: "error" }); }
  finally { end(); }
});
\`\`\`

---

## Complete annotated example

\`\`\`ts
import { definePlugin } from "@conductor/sdk";

interface WorkItem {
  id: string;
  title: string;
  url: string;
}

export default definePlugin({
  id: "acme.work-queue",
  name: "Work Queue",
  version: "1.0.0",
  requiredSecrets: ["acme.api-key"],

  async init(ctx) {
    const apiKey = await ctx.secrets.get("acme.api-key", { env: "ACME_API_KEY" });
    const client = ctx.http.withBearer(async () => apiKey);

    // Poll for new work items every 2 minutes
    ctx.scheduler.interval(2 * 60 * 1000, async () => {
      let items: WorkItem[];
      try {
        const res = await client.get<{ items: WorkItem[] }>({
          url: "https://api.acme.com/queue?status=pending",
        });
        items = res.data.items;
      } catch (err) {
        ctx.logger.error("poll failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      for (const item of items) {
        // Skip already-seen items
        if (await ctx.kv.has(\`seen:\${item.id}\`)) continue;

        ctx.logger.info("new work item", { id: item.id, title: item.title });

        let session;
        try {
          session = await ctx.hive.newSession({
            name: \`work-\${item.id}\`,
            remote: "https://github.com/acme/repo",
            context: \`Work item \${item.id}: \${item.title}\\n\${item.url}\`,
          });
        } catch (err) {
          ctx.logger.error("failed to create session", {
            itemId: item.id,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        await ctx.kv.set(\`seen:\${item.id}\`, { sessionId: session.id });
        await ctx.kv.set(\`session:\${session.id}\`, { itemId: item.id });
      }
    });

    // Mark item done when its session completes
    ctx.hive.onSessionComplete(async ({ session }) => {
      const entry = await ctx.kv.get<{ itemId: string }>(\`session:\${session.id}\`);
      if (!entry) return;

      try {
        await client.patch({ url: \`https://api.acme.com/queue/\${entry.itemId}\`, body: { status: "done" } });
        ctx.logger.info("marked done", { itemId: entry.itemId });
      } catch (err) {
        ctx.logger.error("failed to mark done", {
          itemId: entry.itemId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      await ctx.kv.delete(\`seen:\${entry.itemId}\`);
      await ctx.kv.delete(\`session:\${session.id}\`);
    });
  },
});
\`\`\`

---

## Session lifecycle events (reference)

\`\`\`
CREATED  + PostToolUse               → ACTIVE   (agent started a tool call)
ACTIVE   + PostToolUse               → ACTIVE   (resets idle timer)
ACTIVE   + Stop (no approval)        → IDLE
ACTIVE   + Stop (approval pending)   → APPROVAL (agent needs human input)
ACTIVE   + IdleTimeout               → IDLE
IDLE     + PostToolUse               → ACTIVE
IDLE     + IdleTimeout               → COMPLETE (session recycled)
IDLE     + Stop (no approval)        → COMPLETE
IDLE     + Stop (approval pending)   → APPROVAL
APPROVAL + PostToolUse               → ACTIVE
APPROVAL + ApprovalResolved          → ACTIVE
COMPLETE + any                       → no-op
\`\`\`

Sessions are recycled (\`hive recycle\`) only when they reach COMPLETE.
The idle timeout defaults to \`idleTimeoutMs\` in conductor.config.json (default 10 min)
and can be overridden per plugin entry or per \`newSession\` call.

## Restart recovery

Session state and idle timers are in-memory only. To survive daemon restarts,
Conductor writes a per-session \`meta.json\` sidecar at creation (\`pluginId\`,
\`name\`, \`workDir\`, \`idleTimeoutMs\`) and reconciles on startup: sessions hive
still reports active are re-adopted into IDLE with a fresh idle timer, stale
session dirs are cleaned up, and IPC signals written while the daemon was down
are drained rather than stranded. Plugins do not need to do anything to
participate — newly created sessions are persisted automatically.
`;

const program = new Command("conductor").description("Poll-driven session orchestrator for hive").version("0.1.0");

program
  .command("start")
  .description("Start the conductor daemon")
  .option("-c, --config <path>", "Path to conductor.config.json")
  .option("--foreground", "Run in foreground (daemonize is v2)")
  .action(async (opts: { config?: string }) => {
    try {
      const config = loadConfig(opts.config);
      const configPath = resolveConfigPath(opts.config);
      const logger = createLogger({
        component: "conductor",
        logPath: resolvePath(config.observability.logPath),
        logMaxBytes: config.observability.logMaxBytes,
        logMaxBackups: config.observability.logMaxBackups,
        format: config.observability.logFormat,
        caller: config.observability.logCaller,
      });
      const kvDatabase = openKVDatabase(conductorDataDir());
      const secrets = createSecretsClient();
      const eventBus = new EventBus(logger.with({ component: "eventbus" }));
      const globalLimiter = createConcurrencyLimiter(config.concurrency.global);

      const { registry, metrics, pluginMetrics } = createMetrics();
      const metricsServer = startMetricsServer(config.observability.metricsPort, registry);

      const sessionManager = new SessionManager({
        config,
        eventBus,
        globalLimiter,
        logger,
        metrics,
      });

      // Record the exact command the injected hooks will run. A bare `bun` with
      // no script path here is the fingerprint of the signal-hook failure that
      // motivated this logging — it pinpoints the bug without scraping a pane.
      logger.info("signal invocation resolved", { invocation: resolveSignalInvocation() });

      // Re-adopt sessions that outlived a previous daemon before plugins start
      // creating new ones, so the in-memory map reflects reality (open-session
      // caps, idle timers) from the first poll. Never fatal to startup.
      try {
        await sessionManager.reconcileSessions();
      } catch (err) {
        logger.warn("session reconciliation failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const registrations = await loadPlugins({
        config,
        configPath,
        sessionManager,
        eventBus,
        kvDatabase,
        pluginMetrics,
        secrets,
        globalLogger: logger,
      });

      const watcher = watchIpcEvents(async (ipcEvent) => {
        metrics.ipcEventsTotal.inc({ signal: ipcEvent.signal });
        const isApproval = isApprovalSignal(ipcEvent.signal);
        const event: SessionEvent = ipcEvent.signal === "activity" ? "PostToolUse" : "Stop";
        const outcome = await sessionManager.applyTransition(ipcEvent.sessionId, event, {
          isApprovalPending: isApproval,
        });
        // type collapses the wire signal to activity|stop (stop:approval is a
        // stop); result=ok only when the signal actually drove a tracked session.
        const type = ipcEvent.signal === "activity" ? "activity" : "stop";
        metrics.signalsReceived.inc({ type, result: outcome === "applied" ? "ok" : "error" });
      });

      sessionManager.startMonitor(
        config.observability.sessionInventoryIntervalMs,
        config.observability.signalStallWarnMs,
      );

      let shuttingDown = false;
      const handleSignal = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        process.exitCode = 0;
        shutdown(registrations, sessionManager, watcher, metricsServer, kvDatabase, eventBus, logger)
          .catch((err) => {
            logger.error("Shutdown error", {
              error: err instanceof Error ? err.message : String(err),
            });
            process.exitCode = 1;
          })
          .finally(() => process.exit());
      };
      process.once("SIGTERM", handleSignal);
      process.once("SIGINT", handleSignal);

      await eventBus.emit("conductorStart", {});
      logger.info("Conductor started", {
        pluginCount: registrations.length,
        dataDir: conductorDataDir(),
      });

      await new Promise<never>(() => {});
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  });

async function shutdown(
  registrations: PluginRegistration[],
  sessionManager: SessionManager,
  watcher: { stop(): void },
  metricsServer: { stop(): void },
  kvDatabase: ReturnType<typeof openKVDatabase>,
  eventBus: EventBus,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  await eventBus.emit("conductorStop", {});
  await unloadPlugins(registrations);
  sessionManager.shutdown();
  watcher.stop();
  metricsServer.stop();
  kvDatabase.close();
  logger.info("Conductor stopped");
}

program
  .command("stop")
  .description("Send shutdown signal to running conductor daemon")
  .action(async () => {
    console.log("Stop not implemented (PID file is Phase 2 integration)");
  });

program
  .command("signal <event>")
  .description("Write a lifecycle signal for a session (called by Claude Code hooks)")
  .requiredOption("--session <id>", "Session ID")
  .action(async (event: string, opts: { session: string }) => {
    const valid: IpcSignal[] = ["activity", "stop", "stop:approval"];
    if (!valid.includes(event as IpcSignal)) {
      console.error(`Unknown event "${event}". Valid: ${valid.join(", ")}`);
      process.exit(1);
    }
    try {
      await writeIpcEvent(opts.session, event as IpcSignal);
      console.log(`Signal written: ${event} for session ${opts.session}`);
    } catch (e) {
      console.error(`Failed to write signal: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Show running sessions and daemon status")
  .action(async () => {
    console.log("Status not implemented (daemon loop is Phase 2)");
  });

program
  .command("plugin-docs")
  .description("Print the plugin SDK reference (LLM-friendly markdown for plugin authoring)")
  .action(() => {
    console.log(PLUGIN_DOCS);
  });

const kvCmd = program.command("kv").description("Inspect and manage plugin KV state");

kvCmd
  .command("list")
  .description("List all keys, optionally scoped to a plugin")
  .option("--plugin <id>", "Scope to a specific plugin")
  .action((opts: { plugin?: string }) => {
    const kv = openKVDatabase(conductorDataDir());
    try {
      const entries = kv.listEntries(opts.plugin);
      if (entries.length === 0) {
        console.log("(empty)");
        return;
      }
      if (opts.plugin) {
        for (const e of entries) console.log(e.key);
      } else {
        let lastPlugin = "";
        for (const e of entries) {
          if (e.pluginId !== lastPlugin) {
            if (lastPlugin !== "") console.log();
            console.log(`[${e.pluginId}]`);
            lastPlugin = e.pluginId;
          }
          console.log(`  ${e.key}`);
        }
      }
    } finally {
      kv.close();
    }
  });

kvCmd
  .command("get <key>")
  .description("Print a single value as JSON")
  .requiredOption("--plugin <id>", "Plugin to read from")
  .action(async (key: string, opts: { plugin: string }) => {
    const kv = openKVDatabase(conductorDataDir());
    try {
      const value = await kv.forPlugin(opts.plugin).get(key);
      if (value === undefined) {
        console.error(`Key not found: ${key}`);
        process.exit(1);
      }
      console.log(JSON.stringify(value, null, 2));
    } finally {
      kv.close();
    }
  });

kvCmd
  .command("delete <key>")
  .description("Delete a single key")
  .requiredOption("--plugin <id>", "Plugin to delete from")
  .action(async (key: string, opts: { plugin: string }) => {
    const kv = openKVDatabase(conductorDataDir());
    try {
      await kv.forPlugin(opts.plugin).delete(key);
      console.log(`Deleted: ${key}`);
    } finally {
      kv.close();
    }
  });

kvCmd
  .command("clear")
  .description("Delete all keys for a plugin")
  .requiredOption("--plugin <id>", "Plugin to clear")
  .action(async (opts: { plugin: string }) => {
    const kv = openKVDatabase(conductorDataDir());
    try {
      await kv.forPlugin(opts.plugin).clear();
      console.log(`Cleared all keys for plugin: ${opts.plugin}`);
    } finally {
      kv.close();
    }
  });

program.parseAsync(process.argv);
