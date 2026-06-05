import { createInterface } from "node:readline";
import { type ConductorConfig, resolvePath, writeConfig } from "../config.js";
import type { EventBus } from "../core/events.js";
import type { SessionManager } from "../core/session.js";
import { createHiveClient } from "../sdk/hive.js";
import type { HiveClient } from "../sdk/hive.js";
import { createHttpClient } from "../sdk/http.js";
import type { KVStore } from "../sdk/kv.js";
import type { openKVDatabase } from "../sdk/kv.js";
import type { Logger } from "../sdk/logger.js";
import { createScheduler } from "../sdk/scheduler.js";
import type { SecretsClient } from "../sdk/secrets.js";
import type { Plugin, PluginMeta } from "../types.js";

const INIT_TIMEOUT_MS = 30_000;

// ── Trust model ───────────────────────────────────────────────────────────────

export async function hashPlugin(filePath: string): Promise<string> {
  const content = await Bun.file(resolvePath(filePath)).arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(new Uint8Array(content));
  return `sha256:${hasher.digest("hex")}`;
}

export function getStoredHash(config: ConductorConfig, pluginId: string): string | undefined {
  return config.trustedPlugins[pluginId];
}

export type TrustStatus = "trusted" | "changed" | "unknown";

export function checkTrust(pluginId: string, currentHash: string, config: ConductorConfig): TrustStatus {
  const stored = config.trustedPlugins[pluginId];
  if (!stored) return "unknown";
  return stored === currentHash ? "trusted" : "changed";
}

export async function promptTrustApproval(
  pluginMeta: { name: string; id: string; path: string; hash: string },
  reason: "new" | "changed",
  readLineFn?: (question: string) => Promise<string>,
): Promise<boolean> {
  const reasonText = reason === "new" ? "New plugin" : "Plugin file changed";
  const msg = `\n${reasonText}: ${pluginMeta.name}\n  ID:   ${pluginMeta.id}\n  Path: ${pluginMeta.path}\n  Hash: ${pluginMeta.hash}\n\nAllow this plugin? [y/N]: `;

  let answer: string;
  if (readLineFn) {
    answer = await readLineFn(msg);
  } else {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    answer = await new Promise<string>((resolve) => {
      rl.question(msg, (ans) => {
        rl.close();
        resolve(ans.trim().toLowerCase());
      });
    });
  }
  return answer === "y" || answer === "yes";
}

export async function persistTrustedPlugins(
  approvals: Array<{ pluginId: string; hash: string }>,
  config: ConductorConfig,
  configPath: string,
): Promise<void> {
  const updated: ConductorConfig = {
    ...config,
    trustedPlugins: { ...config.trustedPlugins },
  };
  for (const { pluginId, hash } of approvals) {
    updated.trustedPlugins[pluginId] = hash;
  }
  await writeConfig(updated, configPath);
}

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
      builtinModule = (await import("./github-issues.js")) as {
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
