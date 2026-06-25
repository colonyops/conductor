import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "prom-client";
import type { ConductorConfig } from "../../src/config.js";
import { EventBus } from "../../src/core/events.js";
import { createMetrics, createPluginMetricsFactory } from "../../src/core/observability.js";
import { SessionManager } from "../../src/core/session.js";
import { loadPlugins } from "../../src/plugins/loader.js";
import { createConcurrencyLimiter } from "../../src/sdk/concurrency.js";
import { openKVDatabase } from "../../src/sdk/kv.js";
import type { Logger } from "../../src/sdk/logger.js";
import type { SecretsClient } from "../../src/sdk/secrets.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

let counter = 0;
function tmpDir(): string {
  const dir = join(tmpdir(), `loader-test-${process.pid}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeLogger(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    with: () => logger,
  };
  return logger;
}

const noopSecrets: SecretsClient = {
  get: async () => {
    throw new Error("no secrets configured");
  },
  set: async () => {},
};

// Writes a plugin file whose TOP-LEVEL code (outside init) records that it ran by
// creating `markerPath`. This is the side effect a malicious plugin could trigger.
function writePluginFixture(dir: string, markerPath: string): string {
  const file = join(dir, "side-effect.plugin.ts");
  const source = [
    `import { writeFileSync } from "node:fs";`,
    `writeFileSync(${JSON.stringify(markerPath)}, "executed");`,
    `export default { id: "side-effect", name: "Side Effect", init: async () => {} };`,
    "",
  ].join("\n");
  writeFileSync(file, source);
  return file;
}

// Writes a plugin whose init() throws, to exercise the error path.
function writeThrowingPluginFixture(dir: string): string {
  const file = join(dir, "throwing.plugin.ts");
  const source = [
    `export default { id: "throwing", name: "Throwing", init: async () => { throw new Error("init boom"); } };`,
    "",
  ].join("\n");
  writeFileSync(file, source);
  return file;
}

function makeConfig(pluginPath: string, trusted: Record<string, string> = {}): ConductorConfig {
  return {
    plugins: [{ path: pluginPath, enabled: true }],
    trustedPlugins: trusted,
    concurrency: { global: 10 },
    observability: {
      metricsPort: 9090,
      logPath: "~/.local/dotlogs/conductor.log",
      logMaxBytes: 10_485_760,
      logMaxBackups: 5,
      logFormat: "json" as const,
      logCaller: false,
      sessionInventoryIntervalMs: 120_000,
      signalStallWarnMs: 300_000,
    },
    idleTimeoutMs: 600_000,
    builtins: {},
  };
}

function makeOpts(config: ConductorConfig, configPath: string, dataDir: string, answer: string) {
  const logger = makeLogger();
  const eventBus = new EventBus(logger);
  const sessionManager = new SessionManager({
    config,
    eventBus,
    globalLimiter: createConcurrencyLimiter(10),
    logger,
  });
  const kvDatabase = openKVDatabase(dataDir);
  const pluginMetrics = createPluginMetricsFactory(new Registry());
  const { metrics } = createMetrics();
  return {
    opts: {
      config,
      configPath,
      sessionManager,
      eventBus,
      kvDatabase,
      pluginMetrics,
      metrics,
      secrets: noopSecrets,
      globalLogger: logger,
      readLineFn: async () => answer,
    },
    kvDatabase,
    metrics,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe("loadPlugins trust gating", () => {
  it("does not execute the plugin module when trust is rejected", async () => {
    const dir = tmpDir();
    const marker = join(dir, "executed.marker");
    const pluginPath = writePluginFixture(dir, marker);
    const configPath = join(dir, "conductor.config.json");
    const config = makeConfig(pluginPath); // no trust entry → prompts

    const { opts } = makeOpts(config, configPath, dir, "n");
    const registrations = await loadPlugins(opts);

    // The module's top-level side effect must NOT have run.
    expect(existsSync(marker)).toBe(false);
    expect(registrations).toHaveLength(0);
  });

  it("executes and registers the plugin only after approval, persisting trust by path", async () => {
    const dir = tmpDir();
    const marker = join(dir, "executed.marker");
    const pluginPath = writePluginFixture(dir, marker);
    const configPath = join(dir, "conductor.config.json");
    const config = makeConfig(pluginPath); // no trust entry → prompts

    const { opts } = makeOpts(config, configPath, dir, "y");
    const registrations = await loadPlugins(opts);

    expect(existsSync(marker)).toBe(true);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.meta.id).toBe("side-effect");

    // Trust persisted keyed by the config-declared path, not the plugin id.
    const written = JSON.parse(readFileSync(configPath, "utf-8")) as ConductorConfig;
    expect(written.trustedPlugins[pluginPath]).toBeDefined();
    expect(written.trustedPlugins["side-effect"]).toBeUndefined();
  });

  it("executes a pre-trusted plugin without prompting", async () => {
    const dir = tmpDir();
    const marker = join(dir, "executed.marker");
    const pluginPath = writePluginFixture(dir, marker);
    const configPath = join(dir, "conductor.config.json");

    // Pre-trust by hashing the file and keying by path.
    const { hashPlugin } = await import("../../src/plugins/loader.js");
    const hash = await hashPlugin(pluginPath);
    const config = makeConfig(pluginPath, { [pluginPath]: hash });

    let prompted = false;
    const { opts } = makeOpts(config, configPath, dir, "n");
    opts.readLineFn = async () => {
      prompted = true;
      return "n";
    };
    const registrations = await loadPlugins(opts);

    expect(prompted).toBe(false);
    expect(existsSync(marker)).toBe(true);
    expect(registrations).toHaveLength(1);
  });
});

describe("loadPlugins init metrics", () => {
  it("records init duration when a plugin loads successfully", async () => {
    const dir = tmpDir();
    const marker = join(dir, "executed.marker");
    const pluginPath = writePluginFixture(dir, marker);
    const configPath = join(dir, "conductor.config.json");
    const config = makeConfig(pluginPath);

    const { opts, metrics } = makeOpts(config, configPath, dir, "y");
    await loadPlugins(opts);

    const data = await metrics.pluginInitDuration.get();
    const count = data.values.find((v) => v.metricName?.endsWith("_count"));
    expect(count?.value).toBeGreaterThanOrEqual(1);
    expect(count?.labels.plugin_id).toBe("side-effect");
  });

  it("records a plugin error tagged 'init' when init throws", async () => {
    const dir = tmpDir();
    const pluginPath = writeThrowingPluginFixture(dir);
    const configPath = join(dir, "conductor.config.json");
    const config = makeConfig(pluginPath);

    const { opts, metrics } = makeOpts(config, configPath, dir, "y");
    const registrations = await loadPlugins(opts);

    expect(registrations).toHaveLength(0);
    const data = await metrics.pluginErrors.get();
    const errEntry = data.values.find((v) => v.labels.type === "init");
    expect(errEntry?.value).toBe(1);
    expect(errEntry?.labels.plugin_id).toBe("throwing");
  });
});
