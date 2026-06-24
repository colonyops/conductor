import { createInterface } from "node:readline";
import { type ConductorConfig, resolvePath, writeConfig } from "../config.js";
import type { EventBus } from "../core/events.js";
import type { PluginMetricsFactory } from "../core/observability.js";
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

// The trust key is the plugin's config-declared path, NOT its `id`. The id lives
// inside the plugin module and is only known after `import()` executes the module's
// top-level code — too late to gate execution on. Keying by path lets us verify
// trust from the file bytes alone, before the module ever runs.
export function getStoredHash(config: ConductorConfig, trustKey: string): string | undefined {
  return config.trustedPlugins[trustKey];
}

export type TrustStatus = "trusted" | "changed" | "unknown";

export function checkTrust(trustKey: string, currentHash: string, config: ConductorConfig): TrustStatus {
  const stored = config.trustedPlugins[trustKey];
  if (!stored) return "unknown";
  return stored === currentHash ? "trusted" : "changed";
}

export async function promptTrustApproval(
  pluginMeta: { path: string; hash: string },
  reason: "new" | "changed",
  readLineFn?: (question: string) => Promise<string>,
): Promise<boolean> {
  // The prompt deliberately identifies the plugin by path + hash only. Name/id come
  // from inside the unverified module and would be spoofable, so they are not shown.
  const reasonText = reason === "new" ? "New plugin" : "Plugin file changed";
  const msg = `\n${reasonText}\n  Path: ${pluginMeta.path}\n  Hash: ${pluginMeta.hash}\n\nAllow this plugin to load and execute? [y/N]: `;

  let answer: string;
  if (readLineFn) {
    answer = await readLineFn(msg);
  } else if (!process.stdin.isTTY) {
    // No interactive terminal (e.g. running under systemd). A readline prompt
    // here would block forever waiting on stdin that never arrives, wedging the
    // daemon with no diagnostic. Fail closed: the plugin is left untrusted and
    // skipped. Pre-pin it with `conductor plugins trust <path>` for headless use.
    process.stderr.write(
      `${reasonText} at ${pluginMeta.path} requires trust approval, but no TTY is attached. ` +
        `Skipping. Run \`conductor plugins trust ${pluginMeta.path}\` to pre-approve it.\n`,
    );
    return false;
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
  approvals: Array<{ trustKey: string; hash: string }>,
  config: ConductorConfig,
  configPath: string,
): Promise<void> {
  const updated: ConductorConfig = {
    ...config,
    trustedPlugins: { ...config.trustedPlugins },
  };
  for (const { trustKey, hash } of approvals) {
    updated.trustedPlugins[trustKey] = hash;
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
  for (const required of plugin.requiredSecrets) {
    // A bare string resolves keychain-only; the object form carries the same
    // resolution options as ctx.secrets.get, so env/CLI-sourced secrets that
    // exist (but aren't in the keychain) validate instead of being skipped.
    const { key, opts } =
      typeof required === "string"
        ? { key: required, opts: undefined }
        : {
            key: required.key,
            opts: {
              ...(required.env !== undefined ? { env: required.env } : {}),
              ...(required.ghCLI !== undefined ? { ghCLI: required.ghCLI } : {}),
              ...(required.cliToken !== undefined ? { cliToken: required.cliToken } : {}),
            },
          };
    try {
      await secrets.get(key, opts);
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
  pluginMetrics: PluginMetricsFactory;
  secrets: SecretsClient;
  globalLogger: Logger;
  readLineFn?: (question: string) => Promise<string>;
}): Promise<PluginRegistration[]> {
  const { config, configPath, sessionManager, eventBus, kvDatabase, pluginMetrics, secrets, globalLogger, readLineFn } =
    opts;

  const registrations: PluginRegistration[] = [];
  const approvals: Array<{ trustKey: string; hash: string }> = [];

  type Evaluated = {
    entry: ConductorConfig["plugins"][number];
    plugin: Plugin;
    hash: string;
  };
  const evaluated: Evaluated[] = [];

  // Phase 1: hash + trust check for each enabled user plugin. Trust MUST be verified
  // from the file bytes (hash) before `import()`, because importing executes the
  // module's top-level code. A plugin is only imported once it is trusted/approved.
  for (const entry of config.plugins.filter((p) => p.enabled !== false)) {
    const filePath = resolvePath(entry.path);
    const trustKey = entry.path;

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

    const status = checkTrust(trustKey, hash, config);

    if (status !== "trusted") {
      const reason: "new" | "changed" = status === "unknown" ? "new" : "changed";
      let approved: boolean;
      try {
        approved = await promptTrustApproval({ path: filePath, hash }, reason, readLineFn);
      } catch (err) {
        globalLogger.error("Trust prompt failed", {
          path: filePath,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (!approved) {
        globalLogger.warn("Plugin rejected at trust prompt", {
          path: filePath,
        });
        continue;
      }

      approvals.push({ trustKey, hash });
    }

    // Trust established — only now is it safe to execute the module via import().
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

    evaluated.push({ entry, plugin: pluginModule.default, hash });
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
      ...(entry.idleTimeoutMs !== undefined ? { idleTimeoutMs: entry.idleTimeoutMs } : {}),
    });
    const hive = makeTrackingHiveClient(baseHive, unsubscribes);

    const http = createHttpClient(pluginLogger);
    const metrics = pluginMetrics.forPlugin(plugin.id);
    const ctx = {
      kv,
      hive,
      secrets,
      scheduler,
      logger: pluginLogger,
      http,
      metrics,
      ...(entry.config !== undefined ? { config: entry.config } : {}),
    };

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
      pluginMetrics.removePlugin(plugin.id);
      continue;
    }

    registrations.push({
      meta: plugin,
      filePath,
      hash,
      teardown() {
        scheduler.cancelAll();
        for (const unsub of unsubscribes) unsub();
        pluginMetrics.removePlugin(plugin.id);
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
    let builtinModule: typeof import("./github-issues.js");
    try {
      builtinModule = await import("./github-issues.js");
    } catch (err) {
      globalLogger.error("Failed to import builtin github-issues plugin", {
        error: err instanceof Error ? err.message : String(err),
      });
      return registrations;
    }

    const plugin = builtinModule.createGitHubIssuesPlugin(giConfig);
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
    const metrics = pluginMetrics.forPlugin(plugin.id);
    const ctx = { kv, hive, secrets, scheduler, logger: pluginLogger, http, metrics };

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
      pluginMetrics.removePlugin(plugin.id);
      return registrations;
    }

    registrations.push({
      meta: plugin,
      filePath: "(builtin)",
      hash: "(builtin)",
      teardown() {
        scheduler.cancelAll();
        for (const unsub of unsubscribes) unsub();
        pluginMetrics.removePlugin(plugin.id);
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
