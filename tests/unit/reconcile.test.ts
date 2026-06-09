import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConductorConfig } from "../../src/config.js";
import { EventBus } from "../../src/core/events.js";
import type { HiveSessionRecord } from "../../src/core/hive-client.js";
import {
  type ReconcileDeps,
  SessionManager,
  type SessionMeta,
  readSessionMeta,
  writeSessionMeta,
} from "../../src/core/session.js";
import { createConcurrencyLimiter } from "../../src/sdk/concurrency.js";
import type { Logger } from "../../src/sdk/logger.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  with: () => noopLogger,
};

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
    },
    idleTimeoutMs,
    builtins: {},
  };
}

function makeManager(idleTimeoutMs?: number): SessionManager {
  return new SessionManager({
    config: makeConfig(idleTimeoutMs),
    eventBus: new EventBus(noopLogger),
    globalLimiter: createConcurrencyLimiter(10),
    logger: noopLogger,
  });
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

// makeDeps models the common path: conductor tracks one session dir (s1), hive
// reports it active, and metadata is present. Override individual deps per test.
function makeDeps(overrides: Partial<ReconcileDeps> = {}): {
  deps: ReconcileDeps;
  removed: string[];
} {
  const removed: string[] = [];
  const deps: ReconcileDeps = {
    listAllSessions: async () => [record()],
    readMeta: () => ({ name: "gh-1-fix-thing", pluginId: "plugin-x", workDir: "/work/s1" }),
    listTrackedSessionIds: () => ["s1"],
    removeSessionDir: (id) => removed.push(id),
    ...overrides,
  };
  return { deps, removed };
}

// ── meta round-trip ─────────────────────────────────────────────────────────

describe("session metadata", () => {
  let dataDir: string;
  const original = process.env.CONDUCTOR_DATA_DIR_TEST_OVERRIDE;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "reconcile-meta-"));
    process.env.CONDUCTOR_DATA_DIR_TEST_OVERRIDE = dataDir;
  });

  afterEach(() => {
    process.env.CONDUCTOR_DATA_DIR_TEST_OVERRIDE = original;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("round-trips through write and read", () => {
    const meta: SessionMeta = { name: "n", pluginId: "p", workDir: "/w", idleTimeoutMs: 1234 };
    writeSessionMeta("abc", meta);
    expect(readSessionMeta("abc")).toEqual(meta);
  });

  it("returns undefined when no metadata exists", () => {
    expect(readSessionMeta("missing")).toBeUndefined();
  });
});

// ── reconcileSessions ─────────────────────────────────────────────────────────

describe("reconcileSessions", () => {
  let dataDir: string;
  let manager: SessionManager;
  const original = process.env.CONDUCTOR_DATA_DIR_TEST_OVERRIDE;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "reconcile-"));
    process.env.CONDUCTOR_DATA_DIR_TEST_OVERRIDE = dataDir;
    manager = makeManager();
  });

  afterEach(() => {
    manager.shutdown(); // clear armed idle timers
    process.env.CONDUCTOR_DATA_DIR_TEST_OVERRIDE = original;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("re-adopts an active session not already tracked, as IDLE", async () => {
    const { deps } = makeDeps();
    await manager.reconcileSessions(deps);

    const session = manager.getSession("s1");
    expect(session).toBeDefined();
    expect(session?.state).toBe("IDLE");
    expect(session?.pluginId).toBe("plugin-x");
    expect(session?.name).toBe("gh-1-fix-thing");
    expect(session?.workDir).toBe("/work/s1");
  });

  it("falls back to a reconciled plugin id and derived workDir when metadata is missing", async () => {
    const { deps } = makeDeps({ readMeta: () => undefined });
    await manager.reconcileSessions(deps);

    const session = manager.getSession("s1");
    expect(session?.pluginId).toBe("conductor.reconciled");
    // deriveWorkDir(repo, id) → <hive data dir>/repos/<repo>-<id>
    expect(session?.workDir).toContain("repos/conductor-s1");
  });

  it("does not adopt — and removes the dir of — a tracked session hive reports recycled", async () => {
    const { deps, removed } = makeDeps({ listAllSessions: async () => [record({ state: "recycled" })] });
    await manager.reconcileSessions(deps);
    expect(manager.getSession("s1")).toBeUndefined();
    expect(manager.listSessions()).toHaveLength(0);
    expect(removed).toEqual(["s1"]);
  });

  it("does not re-adopt a session that is already tracked", async () => {
    const { deps } = makeDeps();
    await manager.reconcileSessions(deps);
    await manager.reconcileSessions(deps); // second pass must be a no-op
    expect(manager.listSessions()).toHaveLength(1);
  });

  it("removes on-disk dirs for sessions hive does not report active", async () => {
    const { deps, removed } = makeDeps({
      listTrackedSessionIds: () => ["s1", "stale-2", "stale-3"],
    });
    await manager.reconcileSessions(deps);
    // s1 is active (adopted) and kept; the others have no live session and are removed.
    expect(removed.sort()).toEqual(["stale-2", "stale-3"]);
    expect(manager.getSession("s1")?.state).toBe("IDLE");
  });

  it("does nothing and does not throw when the hive listing fails", async () => {
    const { deps, removed } = makeDeps({
      listAllSessions: async () => {
        throw new Error("hive unavailable");
      },
    });
    await manager.reconcileSessions(deps);
    expect(manager.listSessions()).toHaveLength(0);
    // No cleanup either — without an authoritative list we can't classify dirs.
    expect(removed).toHaveLength(0);
  });
});
