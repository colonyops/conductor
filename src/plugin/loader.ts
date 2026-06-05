import { type ConductorConfig, resolvePath } from "../config.js";
import { createHiveClient } from "../sdk/client.js";
import type { HiveClient } from "../sdk/client.js";
import { createHttpClient } from "../sdk/http.js";
import type { KVStore } from "../sdk/kv.js";
import type { openKVDatabase } from "../sdk/kv.js";
import type { Logger } from "../sdk/logger.js";
import { createScheduler } from "../sdk/scheduler.js";
import type { SecretsClient } from "../sdk/secrets.js";
import type { EventBus } from "../session/events.js";
import type { SessionManager } from "../session/manager.js";
import type { Plugin, PluginMeta } from "../types.js";
import { type TrustStatus, checkTrust, hashPlugin, persistTrustedPlugins, promptTrustApproval } from "./trust.js";

const INIT_TIMEOUT_MS = 30_000;

// ── Plugin registration ───────────────────────────────────────────────────────

export interface PluginRegistration {
  meta: PluginMeta;
  filePath: string;
  hash: string;
  teardown(): void;
}

export async function validatePluginSecrets(plugin: Plugin, secrets: SecretsClient): Promise<boolean> {
  if (!plugin.requiredSecrets?.length) return true;
  for (const key of plugin.requiredSecrets) {
    try {
      await secrets.get(key);
    } catch {
      return false;
    }
  }
  return true;
}

function makeTrackingHiveClient(base: HiveClient, unsubscribes: Array<() => void>): HiveClient {
  function track<A extends unknown[]>(fn: (...args: A) => () => void): (...args: A) => () => void {
    return (...args) => {
      const unsub = fn(...args);
      unsubscribes.push(unsub);
      return unsub;
    };
  }

  return {
    newSession: (opts) => base.newSession(opts),
    ephemeralSession: (opts) => base.ephemeralSession(opts),
    listSessions: () => base.listSessions(),
    onSessionCreated: track((...a) => base.onSessionCreated(...a)),
    onSessionActive: track((...a) => base.onSessionActive(...a)),
    onSessionIdle: track((...a) => base.onSessionIdle(...a)),
    onSessionComplete: track((...a) => base.onSessionComplete(...a)),
    onSessionRecycled: track((...a) => base.onSessionRecycled(...a)),
    onSessionApproval: track((...a) => base.onSessionApproval(...a)),
    onSessionError: track((...a) => base.onSessionError(...a)),
  };
}

// ── loadPlugins ───────────────────────────────────────────────────────────────

export async function loadPlugins(opts: {
  config: ConductorConfig;
  configPath: string;
  sessionManager: SessionManager;
  eventBus: EventBus;
  kvDatabase: ReturnType<typeof openKVDatabase>;
  secrets: SecretsClient;
  globalLogger: Logger;
  readLineFn?: (question: string) => Promise<string>;
}): Promise<PluginRegistration[]> {
  const { config, configPath, sessionManager, eventBus, kvDatabase, secrets, globalLogger, readLineFn } = opts;

  const registrations: PluginRegistration[] = [];
  const approvals: Array<{ pluginId: string; hash: string }> = [];

  type Evaluated = {
    entry: ConductorConfig["plugins"][number];
    plugin: Plugin;
    hash: string;
  };
  const evaluated: Evaluated[] = [];

  // Phase 1: hash + import + trust check for each enabled user plugin
  for (const entry of config.plugins.filter((p) => p.enabled !== false)) {
    const filePath = resolvePath(entry.path);

    let hash: string;
    try {
      hash = await hashPlugin(filePath);
    } catch (err) {
      globalLogger.error("Failed to hash plugin", {
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    let pluginModule: { default: Plugin };
    try {
      pluginModule = (await import(filePath)) as { default: Plugin };
    } catch (err) {
      globalLogger.error("Failed to import plugin", {
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const plugin = pluginModule.default;
    const status = checkTrust(plugin.id, hash, config);

    if (status === "trusted") {
      evaluated.push({ entry, plugin, hash });
      continue;
    }

    const reason: "new" | "changed" = status === "unknown" ? "new" : "changed";
    let approved: boolean;
    try {
      approved = await promptTrustApproval(
        { name: plugin.name, id: plugin.id, path: filePath, hash },
        reason,
        readLineFn,
      );
    } catch (err) {
      globalLogger.error("Trust prompt failed", {
        pluginId: plugin.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (!approved) {
      globalLogger.warn("Plugin rejected at trust prompt", {
        pluginId: plugin.id,
      });
      continue;
    }

    approvals.push({ pluginId: plugin.id, hash });
    evaluated.push({ entry, plugin, hash });
  }

  // Phase 2: persist all newly approved plugins atomically
  if (approvals.length > 0) {
    try {
      await persistTrustedPlugins(approvals, config, configPath);
    } catch (err) {
      globalLogger.error("Failed to persist trusted plugins", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Phase 3: validate secrets + init each approved/trusted plugin
  for (const { entry, plugin, hash } of evaluated) {
    const filePath = resolvePath(entry.path);

    const secretsOk = await validatePluginSecrets(plugin, secrets);
    if (!secretsOk) {
      globalLogger.error("Plugin skipped: unresolvable required secret", {
        pluginId: plugin.id,
        requiredSecrets: plugin.requiredSecrets ?? [],
      });
      continue;
    }

    const pluginLogger = globalLogger.with({ component: plugin.name });
    const scheduler = createScheduler(pluginLogger);
    const kv: KVStore = kvDatabase.forPlugin(plugin.id);
    const unsubscribes: Array<() => void> = [];
    const baseHive = createHiveClient({
      pluginId: plugin.id,
      sessionManager,
      eventBus,
    });
    const hive = makeTrackingHiveClient(baseHive, unsubscribes);

    const http = createHttpClient(pluginLogger);
    const ctx = { kv, hive, secrets, scheduler, logger: pluginLogger, http };

    try {
      await Promise.race([
        plugin.init(ctx),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`plugin init timed out after ${INIT_TIMEOUT_MS}ms`)), INIT_TIMEOUT_MS),
        ),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timed out")) {
        globalLogger.error("Plugin init timed out", { plugin: plugin.name });
      } else {
        globalLogger.error("Plugin init threw", {
          plugin: plugin.name,
          error: msg,
        });
      }
      scheduler.cancelAll();
      continue;
    }

    registrations.push({
      meta: plugin,
      filePath,
      hash,
      teardown() {
        scheduler.cancelAll();
        for (const unsub of unsubscribes) unsub();
      },
    });

    globalLogger.info("Plugin loaded", {
      pluginId: plugin.id,
      name: plugin.name,
    });
  }

  // Load builtin: github-issues
  const giConfig = config.builtins["github-issues"];
  if (giConfig) {
    process.env.CONDUCTOR_GITHUB_REPO = giConfig.repo;
    process.env.CONDUCTOR_GITHUB_LABELS = giConfig.labels.join(",");
    process.env.CONDUCTOR_GITHUB_POLL_INTERVAL_MS = String(giConfig.pollIntervalMs);
    process.env.CONDUCTOR_GITHUB_TOKEN_SECRET_KEY = giConfig.tokenSecretKey;
    process.env.CONDUCTOR_GITHUB_TOKEN_SOURCE = giConfig.tokenSource;
    if (giConfig.inProgressLabel) {
      process.env.CONDUCTOR_GITHUB_IN_PROGRESS_LABEL = giConfig.inProgressLabel;
    }
    if (giConfig.doneLabel) {
      process.env.CONDUCTOR_GITHUB_DONE_LABEL = giConfig.doneLabel;
    }

    let builtinModule: { default: Plugin };
    try {
      builtinModule = (await import("./builtin/github-issues.js")) as {
        default: Plugin;
      };
    } catch (err) {
      globalLogger.error("Failed to import builtin github-issues plugin", {
        error: err instanceof Error ? err.message : String(err),
      });
      return registrations;
    }

    const plugin = builtinModule.default;
    const pluginLogger = globalLogger.with({ component: plugin.name });
    const scheduler = createScheduler(pluginLogger);
    const kv: KVStore = kvDatabase.forPlugin(plugin.id);
    const unsubscribes: Array<() => void> = [];
    const baseHive = createHiveClient({
      pluginId: plugin.id,
      sessionManager,
      eventBus,
    });
    const hive = makeTrackingHiveClient(baseHive, unsubscribes);
    const http = createHttpClient(pluginLogger);
    const ctx = { kv, hive, secrets, scheduler, logger: pluginLogger, http };

    try {
      await Promise.race([
        plugin.init(ctx),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`plugin init timed out after ${INIT_TIMEOUT_MS}ms`)), INIT_TIMEOUT_MS),
        ),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      globalLogger.error("Builtin github-issues init failed", { error: msg });
      scheduler.cancelAll();
      return registrations;
    }

    registrations.push({
      meta: plugin,
      filePath: "(builtin)",
      hash: "(builtin)",
      teardown() {
        scheduler.cancelAll();
        for (const unsub of unsubscribes) unsub();
      },
    });

    globalLogger.info("Plugin loaded", {
      pluginId: plugin.id,
      name: plugin.name,
    });
  }

  return registrations;
}

export async function unloadPlugins(registrations: PluginRegistration[]): Promise<void> {
  for (const reg of registrations) {
    try {
      reg.teardown();
    } catch {
      // ignore teardown errors
    }
  }
}

export type { TrustStatus };
