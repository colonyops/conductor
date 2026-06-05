import { type AcceptTrustDeps, acceptTrustPrompt } from "../../src/core/hive-client.js";
import type { Logger } from "../../src/sdk/logger.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TRUST_PANE = "Do you trust the files in this folder?\n  1. Yes, proceed\n  2. No, exit";

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

function makeDeps(overrides: Partial<AcceptTrustDeps> = {}): { deps: AcceptTrustDeps; counters: DepCounters } {
  const counters: DepCounters = { captureCalls: 0, sendKeysCalls: [], sleepCalls: 0 };
  const deps: AcceptTrustDeps = {
    alreadyTrusted: () => false,
    capturePane: async () => {
      counters.captureCalls++;
      return { ok: true, content: TRUST_PANE };
    },
    sendKeys: async (target, keys) => {
      counters.sendKeysCalls.push({ target, keys });
      return true;
    },
    sleep: async () => {
      counters.sleepCalls++;
    },
    ...overrides,
  };
  return { deps, counters };
}

// ── acceptTrustPrompt ───────────────────────────────────────────────────────────

describe("acceptTrustPrompt", () => {
  it("returns early without touching tmux when the directory is already trusted", async () => {
    const { deps, counters } = makeDeps({ alreadyTrusted: () => true });
    await acceptTrustPrompt("sess", "/work/dir", { deps });
    expect(counters.captureCalls).toBe(0);
    expect(counters.sendKeysCalls).toHaveLength(0);
  });

  it("sends Enter to the claude pane once the trust prompt is rendered", async () => {
    const { deps, counters } = makeDeps();
    await acceptTrustPrompt("my-session", "/work/dir", { deps });
    expect(counters.sendKeysCalls).toEqual([{ target: "my-session:claude", keys: ["Enter"] }]);
  });

  it("polls until the trust prompt appears", async () => {
    let calls = 0;
    const { deps, counters } = makeDeps({
      capturePane: async () => {
        calls++;
        if (calls < 3) return { ok: true, content: "starting up..." };
        return { ok: true, content: TRUST_PANE };
      },
    });
    await acceptTrustPrompt("sess", "/work/dir", { deps, pollIntervalMs: 1, timeoutMs: 100 });
    expect(calls).toBe(3);
    expect(counters.sendKeysCalls).toHaveLength(1);
    expect(counters.sleepCalls).toBe(2);
  });

  it("retries while the pane is not yet accessible", async () => {
    let calls = 0;
    const { deps, counters } = makeDeps({
      capturePane: async () => {
        calls++;
        if (calls < 2) return { ok: false, content: "" };
        return { ok: true, content: TRUST_PANE };
      },
    });
    await acceptTrustPrompt("sess", "/work/dir", { deps, pollIntervalMs: 1, timeoutMs: 100 });
    expect(counters.sendKeysCalls).toHaveLength(1);
  });

  it("logs a warning when send-keys fails", async () => {
    const logger = makeLogger();
    const { deps } = makeDeps({ sendKeys: async () => false });
    await acceptTrustPrompt("sess", "/work/dir", { deps, logger });
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]?.msg).toContain("send-keys failed");
  });

  it("logs a warning when the prompt never appears before timeout", async () => {
    const logger = makeLogger();
    const { deps, counters } = makeDeps({
      capturePane: async () => ({ ok: true, content: "no prompt here" }),
    });
    await acceptTrustPrompt("sess", "/work/dir", { deps, logger, pollIntervalMs: 1, timeoutMs: 3 });
    expect(counters.sendKeysCalls).toHaveLength(0);
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]?.msg).toContain("not detected before timeout");
    expect(logger.warns[0]?.data?.paneAccessible).toBe(true);
  });

  it("reports paneAccessible=false when capture never succeeds", async () => {
    const logger = makeLogger();
    const { deps } = makeDeps({
      capturePane: async () => ({ ok: false, content: "" }),
    });
    await acceptTrustPrompt("sess", "/work/dir", { deps, logger, pollIntervalMs: 1, timeoutMs: 3 });
    expect(logger.warns[0]?.data?.paneAccessible).toBe(false);
  });

  it("logs a debug entry on successful acceptance", async () => {
    const logger = makeLogger();
    const { deps } = makeDeps();
    await acceptTrustPrompt("sess", "/work/dir", { deps, logger });
    expect(logger.debugs).toHaveLength(1);
    expect(logger.debugs[0]?.msg).toContain("accepted trust prompt");
  });
});
