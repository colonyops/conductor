import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConductorConfig } from "../../src/config.js";
import { EventBus } from "../../src/core/events.js";
import type { HiveSessionRecord } from "../../src/core/hive-client.js";
import { createMetrics } from "../../src/core/observability.js";
import { type ReconcileDeps, SessionManager } from "../../src/core/session.js";
import { createConcurrencyLimiter } from "../../src/sdk/concurrency.js";
import type { Logger } from "../../src/sdk/logger.js";

// ── Harness ───────────────────────────────────────────────────────────────────

interface LogLine {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  data: Record<string, unknown> | undefined;
}

function recordingLogger(sink: LogLine[]): Logger {
  const logger: Logger = {
    debug: (msg, data) => sink.push({ level: "debug", msg, data }),
    info: (msg, data) => sink.push({ level: "info", msg, data }),
    warn: (msg, data) => sink.push({ level: "warn", msg, data }),
    error: (msg, data) => sink.push({ level: "error", msg, data }),
    with: () => logger,
  };
  return logger;
}

function makeConfig(idleTimeoutMs = 1_000_000): ConductorConfig {
  return {
    plugins: [],
    trustedPlugins: {},
    concurrency: { global: 10 },
    observability: {
      metricsPort: 9090,
      logPath: "~/.local/dotlogs/conductor.log",
      logMaxBytes: 10_485_760,
      logMaxBackups: 5,
      logFormat: "json",
      logCaller: false,
      sessionInventoryIntervalMs: 120_000,
      signalStallWarnMs: 300_000,
    },
    idleTimeoutMs,
    builtins: {},
  };
}

function record(overrides: Partial<HiveSessionRecord> = {}): HiveSessionRecord {
  return {
    id: "s1",
    name: "gh-1-fix-thing",
    repo: "conductor",
    inbox: "agent.s1.inbox",
    state: "active",
    unread: 0,
    ...overrides,
  };
}

function reconcileDeps(): ReconcileDeps {
  return {
    listAllSessions: async () => [record()],
    readMeta: () => ({ name: "gh-1-fix-thing", pluginId: "plugin-x", workDir: "/work/s1" }),
    listTrackedSessionIds: () => ["s1"],
    removeSessionDir: () => {},
  };
}

function makeManager(logs: LogLine[]): {
  manager: SessionManager;
  metrics: ReturnType<typeof createMetrics>["metrics"];
  registry: ReturnType<typeof createMetrics>["registry"];
} {
  const { metrics, registry } = createMetrics();
  const manager = new SessionManager({
    config: makeConfig(),
    eventBus: new EventBus(recordingLogger([])),
    globalLimiter: createConcurrencyLimiter(10),
    logger: recordingLogger(logs),
    metrics,
  });
  return { manager, metrics, registry };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("SessionManager observability", () => {
  let dataDir: string;
  const original = process.env.CONDUCTOR_DATA_DIR_TEST_OVERRIDE;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "session-obs-"));
    process.env.CONDUCTOR_DATA_DIR_TEST_OVERRIDE = dataDir;
  });

  afterEach(() => {
    process.env.CONDUCTOR_DATA_DIR_TEST_OVERRIDE = original;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("applyTransition returns unknown-session for an untracked id", async () => {
    const { manager } = makeManager([]);
    expect(await manager.applyTransition("nope", "PostToolUse")).toBe("unknown-session");
  });

  it("applyTransition returns invalid (and does not throw) on an illegal transition", async () => {
    const logs: LogLine[] = [];
    const { manager } = makeManager(logs);
    await manager.reconcileSessions(reconcileDeps()); // s1 adopted as IDLE

    // IDLE + ApprovalResolved has no transition rule.
    expect(await manager.applyTransition("s1", "ApprovalResolved")).toBe("invalid");
    expect(logs.some((l) => l.level === "warn" && l.msg === "invalid session transition")).toBe(true);
    manager.shutdown();
  });

  it("applyTransition returns applied and records the state on a real transition", async () => {
    const { manager, registry } = makeManager([]);
    await manager.reconcileSessions(reconcileDeps()); // IDLE

    expect(await manager.applyTransition("s1", "PostToolUse")).toBe("applied"); // → ACTIVE
    const text = await registry.metrics();
    expect(text).toContain('conductor_sessions_total{state="ACTIVE",plugin_id="plugin-x"} 1');
    expect(text).toContain('conductor_sessions_active{state="ACTIVE"} 1');
    expect(text).toContain('conductor_sessions_active{state="IDLE"} 0');
    manager.shutdown();
  });

  it("counts a completed session when it reaches COMPLETE", async () => {
    const { manager, registry } = makeManager([]);
    await manager.reconcileSessions(reconcileDeps()); // IDLE

    // IDLE + Stop (no approval) → COMPLETE, without recycling (no hive call).
    await manager.applyTransition("s1", "Stop");
    const text = await registry.metrics();
    expect(text).toContain('conductor_sessions_completed_total{plugin_id="plugin-x"} 1');
    manager.shutdown();
  });

  it("monitorTick refreshes the oldest-session-age gauge and logs an inventory", async () => {
    const logs: LogLine[] = [];
    const { manager, registry } = makeManager(logs);
    await manager.reconcileSessions(reconcileDeps());

    const createdAt = manager.getSession("s1")?.createdAt;
    if (!createdAt) throw new Error("session not adopted");
    const now = new Date(createdAt.getTime() + 615_000);

    manager.monitorTick(300_000, now);

    const text = await registry.metrics();
    expect(text).toContain("conductor_oldest_session_age_seconds 615");

    const inventory = logs.find((l) => l.msg === "session inventory");
    expect(inventory?.data?.count).toBe(1);
    manager.shutdown();
  });
});
