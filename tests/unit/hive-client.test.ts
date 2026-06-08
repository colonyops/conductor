import { homedir } from "node:os";
import { join } from "node:path";
import { type AcceptTrustDeps, acceptTrustPrompt, deriveWorkDir } from "../../src/core/hive-client.js";
import type { Logger } from "../../src/sdk/logger.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TRUST_PANE = "Do you trust the files in this folder?\n  1. Yes, proceed\n  2. No, exit";
const CLEARED_PANE = "● Welcome to Claude Code\n> ";

interface RecordingLogger extends Logger {
  warns: Array<{ msg: string; data: Record<string, unknown> | undefined }>;
  debugs: Array<{ msg: string; data: Record<string, unknown> | undefined }>;
}

function makeLogger(): RecordingLogger {
  const warns: RecordingLogger["warns"] = [];
  const debugs: RecordingLogger["debugs"] = [];
  const logger: RecordingLogger = {
    warns,
    debugs,
    debug: (msg, data) => debugs.push({ msg, data }),
    info: () => {},
    warn: (msg, data) => warns.push({ msg, data }),
    error: () => {},
    with: () => logger,
  };
  return logger;
}

interface DepCounters {
  captureCalls: number;
  sendKeysCalls: Array<{ target: string; keys: string[] }>;
  sleepCalls: number;
}

// makeDeps models the common happy path: the trust prompt is visible until an
// Enter is sent, after which the pane clears. Override individual deps to model
// slow startup, an inaccessible pane, or a prompt that refuses to clear.
function makeDeps(overrides: Partial<AcceptTrustDeps> = {}): { deps: AcceptTrustDeps; counters: DepCounters } {
  const counters: DepCounters = { captureCalls: 0, sendKeysCalls: [], sleepCalls: 0 };
  let promptVisible = true;
  const deps: AcceptTrustDeps = {
    alreadyTrusted: () => false,
    capturePane: async () => {
      counters.captureCalls++;
      return { ok: true, content: promptVisible ? TRUST_PANE : CLEARED_PANE };
    },
    sendKeys: async (target, keys) => {
      counters.sendKeysCalls.push({ target, keys });
      promptVisible = false;
      return true;
    },
    sleep: async () => {
      counters.sleepCalls++;
    },
    ...overrides,
  };
  return { deps, counters };
}

// ── deriveWorkDir ─────────────────────────────────────────────────────────────

describe("deriveWorkDir", () => {
  const originalDataDir = process.env.HIVE_DATA_DIR;

  afterEach(() => {
    if (originalDataDir === undefined) {
      // biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined"
      delete process.env.HIVE_DATA_DIR;
    } else {
      process.env.HIVE_DATA_DIR = originalDataDir;
    }
  });

  it("reconstructs the <dataDir>/repos/<repo>-<id> checkout path", () => {
    process.env.HIVE_DATA_DIR = "/tmp/hive-data";
    expect(deriveWorkDir("conductor", "uc8176")).toBe("/tmp/hive-data/repos/conductor-uc8176");
  });

  it("falls back to the default hive data dir when HIVE_DATA_DIR is unset", () => {
    // biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined"
    delete process.env.HIVE_DATA_DIR;
    expect(deriveWorkDir("conductor", "uc8176")).toBe(
      join(homedir(), ".local/share/hive", "repos", "conductor-uc8176"),
    );
  });
});

// ── acceptTrustPrompt ───────────────────────────────────────────────────────────

describe("acceptTrustPrompt", () => {
  it("sends Enter and verifies the prompt cleared on the happy path", async () => {
    const { deps, counters } = makeDeps();
    await acceptTrustPrompt("my-session", "/work/dir", { deps, pollIntervalMs: 1 });
    expect(counters.sendKeysCalls).toEqual([{ target: "my-session:claude", keys: ["Enter"] }]);
  });

  it("only verifies a short window when the folder is already trusted", async () => {
    const { deps, counters } = makeDeps({
      alreadyTrusted: () => true,
      capturePane: async () => {
        counters.captureCalls++;
        return { ok: true, content: CLEARED_PANE };
      },
    });
    await acceptTrustPrompt("sess", "/work/dir", { deps, pollIntervalMs: 1, timeoutMs: 10_000, trustedVerifyMs: 3 });
    // Verifies the pane (does not blindly skip) but does not wait the full timeout.
    expect(counters.captureCalls).toBeGreaterThan(0);
    expect(counters.captureCalls).toBeLessThan(10);
    expect(counters.sendKeysCalls).toHaveLength(0);
  });

  it("dismisses a prompt that appears even when the folder is marked trusted", async () => {
    // alreadyTrusted is a hint, not a guarantee (e.g. a reused project dir): a
    // prompt that appears anyway must still be accepted.
    const { deps, counters } = makeDeps({ alreadyTrusted: () => true });
    await acceptTrustPrompt("sess", "/work/dir", { deps, pollIntervalMs: 1 });
    expect(counters.sendKeysCalls).toHaveLength(1);
  });

  it("matches the prompt even when tmux hard-wraps it across lines", async () => {
    let promptVisible = true;
    const { deps, counters } = makeDeps({
      capturePane: async () => ({
        ok: true,
        content: promptVisible ? "Do you trust the\nfiles in this\nfolder?" : CLEARED_PANE,
      }),
      sendKeys: async (target, keys) => {
        counters.sendKeysCalls.push({ target, keys });
        promptVisible = false;
        return true;
      },
    });
    await acceptTrustPrompt("sess", "/work/dir", { deps, pollIntervalMs: 1 });
    expect(counters.sendKeysCalls).toHaveLength(1);
  });

  it("polls until the trust prompt appears", async () => {
    let calls = 0;
    let promptVisible = true;
    const { deps, counters } = makeDeps({
      capturePane: async () => {
        calls++;
        if (calls < 3) return { ok: true, content: "starting up..." };
        return { ok: true, content: promptVisible ? TRUST_PANE : CLEARED_PANE };
      },
      sendKeys: async (target, keys) => {
        counters.sendKeysCalls.push({ target, keys });
        promptVisible = false;
        return true;
      },
    });
    await acceptTrustPrompt("sess", "/work/dir", { deps, pollIntervalMs: 1, timeoutMs: 100 });
    expect(counters.sendKeysCalls).toHaveLength(1);
  });

  it("retries while the pane is not yet accessible", async () => {
    let calls = 0;
    let promptVisible = true;
    const { deps, counters } = makeDeps({
      capturePane: async () => {
        calls++;
        if (calls < 2) return { ok: false, content: "" };
        return { ok: true, content: promptVisible ? TRUST_PANE : CLEARED_PANE };
      },
      sendKeys: async (target, keys) => {
        counters.sendKeysCalls.push({ target, keys });
        promptVisible = false;
        return true;
      },
    });
    await acceptTrustPrompt("sess", "/work/dir", { deps, pollIntervalMs: 1, timeoutMs: 100 });
    expect(counters.sendKeysCalls).toHaveLength(1);
  });

  it("retries Enter until the prompt actually clears", async () => {
    // A zero exit from send-keys does not guarantee the dialog was dismissed;
    // the first Enter is dropped here and the prompt clears on the second.
    let enters = 0;
    const { deps, counters } = makeDeps({
      capturePane: async () => {
        counters.captureCalls++;
        return { ok: true, content: enters >= 2 ? CLEARED_PANE : TRUST_PANE };
      },
      sendKeys: async (target, keys) => {
        enters++;
        counters.sendKeysCalls.push({ target, keys });
        return true;
      },
    });
    await acceptTrustPrompt("sess", "/work/dir", { deps, pollIntervalMs: 1, maxKeyAttempts: 5 });
    expect(counters.sendKeysCalls).toHaveLength(2);
  });

  it("throws when the prompt never clears after the keystroke budget", async () => {
    const logger = makeLogger();
    const { deps, counters } = makeDeps({
      capturePane: async () => ({ ok: true, content: TRUST_PANE }),
    });
    await expect(
      acceptTrustPrompt("sess", "/work/dir", { deps, logger, pollIntervalMs: 1, maxKeyAttempts: 3 }),
    ).rejects.toThrow(/still present after 3/);
    expect(counters.sendKeysCalls).toHaveLength(3);
  });

  it("warns on each failed send-keys before throwing", async () => {
    const logger = makeLogger();
    const { deps } = makeDeps({
      capturePane: async () => ({ ok: true, content: TRUST_PANE }),
      sendKeys: async () => false,
    });
    await expect(
      acceptTrustPrompt("sess", "/work/dir", { deps, logger, pollIntervalMs: 1, maxKeyAttempts: 2 }),
    ).rejects.toThrow();
    expect(logger.warns).toHaveLength(2);
    expect(logger.warns[0]?.msg).toContain("send-keys failed");
  });

  it("throws when the prompt never appears and the folder is not trusted", async () => {
    const { deps, counters } = makeDeps({
      capturePane: async () => ({ ok: true, content: "no prompt here" }),
    });
    await expect(acceptTrustPrompt("sess", "/work/dir", { deps, pollIntervalMs: 1, timeoutMs: 3 })).rejects.toThrow(
      /not detected within 3ms/,
    );
    expect(counters.sendKeysCalls).toHaveLength(0);
  });

  it("includes paneAccessible=false in the error when capture never succeeds", async () => {
    const { deps } = makeDeps({
      capturePane: async () => ({ ok: false, content: "" }),
    });
    await expect(acceptTrustPrompt("sess", "/work/dir", { deps, pollIntervalMs: 1, timeoutMs: 3 })).rejects.toThrow(
      /paneAccessible=false/,
    );
  });

  it("returns without error when no prompt appears but the folder is trusted", async () => {
    const { deps, counters } = makeDeps({
      alreadyTrusted: () => true,
      capturePane: async () => ({ ok: true, content: "no prompt here" }),
    });
    await acceptTrustPrompt("sess", "/work/dir", { deps, pollIntervalMs: 1, timeoutMs: 3, trustedVerifyMs: 3 });
    expect(counters.sendKeysCalls).toHaveLength(0);
  });

  it("logs a debug entry on successful acceptance", async () => {
    const logger = makeLogger();
    const { deps } = makeDeps();
    await acceptTrustPrompt("sess", "/work/dir", { deps, logger, pollIntervalMs: 1 });
    expect(logger.debugs.some((d) => d.msg.includes("accepted trust prompt"))).toBe(true);
  });
});
