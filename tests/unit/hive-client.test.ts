import { homedir } from "node:os";
import { join } from "node:path";
import { type AcceptTrustDeps, acceptTrustPrompt, deriveWorkDir } from "../../src/core/hive-client.js";
import type { Logger } from "../../src/sdk/logger.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TRUST_PANE = "Do you trust the files in this folder?\n  1. Yes, proceed\n  2. No, exit";
// Newer Claude Code wording — different phrasing, same dialog.
const TRUST_PANE_NEW =
  "Quick safety check: Is this a project you created or one you trust? (Like your own code,\n" +
  "a well-known open source project, or work from your team).\n" +
  " ❯ 1. Yes, I trust this folder\n   2. No, exit\n Enter to confirm · Esc to cancel";
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
    listWindows: async () => [{ index: "1", name: "claude", active: true }],
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
    expect(counters.sendKeysCalls).toEqual([{ target: "my-session:1", keys: ["Enter"] }]);
  });

  it("matches the newer 'Quick safety check / trust this folder' wording", async () => {
    let promptVisible = true;
    const { deps, counters } = makeDeps({
      capturePane: async () => ({ ok: true, content: promptVisible ? TRUST_PANE_NEW : CLEARED_PANE }),
      sendKeys: async (target, keys) => {
        counters.sendKeysCalls.push({ target, keys });
        promptVisible = false;
        return true;
      },
    });
    await acceptTrustPrompt("sess", "/work/dir", { deps, pollIntervalMs: 1 });
    expect(counters.sendKeysCalls).toHaveLength(1);
  });

  it("finds the trust prompt by content regardless of the agent window name", async () => {
    // The agent window is named "codex", not "claude", and is not the first
    // window. Detection must rely on pane content, not the window name.
    let promptVisible = true;
    const { deps, counters } = makeDeps({
      listWindows: async () => [
        { index: "1", name: "shell", active: false },
        { index: "2", name: "codex", active: true },
      ],
      capturePane: async (target) => {
        if (target === "sess:2") return { ok: true, content: promptVisible ? TRUST_PANE_NEW : CLEARED_PANE };
        return { ok: true, content: "a normal shell\n❯ " };
      },
      sendKeys: async (target, keys) => {
        counters.sendKeysCalls.push({ target, keys });
        promptVisible = false;
        return true;
      },
    });
    await acceptTrustPrompt("sess", "/work/dir", { deps, pollIntervalMs: 1 });
    expect(counters.sendKeysCalls).toEqual([{ target: "sess:2", keys: ["Enter"] }]);
  });

  it("falls back to the active window when windows cannot be listed", async () => {
    let promptVisible = true;
    const { deps, counters } = makeDeps({
      listWindows: async () => [],
      capturePane: async () => ({ ok: true, content: promptVisible ? TRUST_PANE : CLEARED_PANE }),
      sendKeys: async (target, keys) => {
        counters.sendKeysCalls.push({ target, keys });
        promptVisible = false;
        return true;
      },
    });
    await acceptTrustPrompt("sess", "/work/dir", { deps, pollIntervalMs: 1 });
    // Bare session target addresses the session's active window.
    expect(counters.sendKeysCalls).toEqual([{ target: "sess", keys: ["Enter"] }]);
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

  it("proceeds without error when no prompt appears and the folder is not trusted", async () => {
    // "No prompt" is overwhelmingly the already-trusted case; failing here would
    // recycle a healthy session, so acceptTrustPrompt must not throw.
    const logger = makeLogger();
    const { deps, counters } = makeDeps({
      capturePane: async () => ({ ok: true, content: "no prompt here" }),
    });
    await acceptTrustPrompt("sess", "/work/dir", { deps, logger, pollIntervalMs: 1, timeoutMs: 3 });
    expect(counters.sendKeysCalls).toHaveLength(0);
    expect(logger.warns.some((w) => w.msg.includes("no trust prompt or ready state"))).toBe(true);
  });

  it("proceeds (does not throw) even when the pane is never accessible", async () => {
    const { deps, counters } = makeDeps({
      capturePane: async () => ({ ok: false, content: "" }),
    });
    await acceptTrustPrompt("sess", "/work/dir", { deps, pollIntervalMs: 1, timeoutMs: 3 });
    expect(counters.sendKeysCalls).toHaveLength(0);
  });

  it("returns as soon as a running REPL is detected, without sending keys", async () => {
    // Already-trusted folder: no dialog, the REPL is up. Recognized as healthy.
    const { deps, counters } = makeDeps({
      alreadyTrusted: () => false,
      capturePane: async () => ({
        ok: true,
        content: "● Claude Code\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n❯ ",
      }),
    });
    await acceptTrustPrompt("sess", "/work/dir", { deps, pollIntervalMs: 1, timeoutMs: 5_000 });
    expect(counters.sendKeysCalls).toHaveLength(0);
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
