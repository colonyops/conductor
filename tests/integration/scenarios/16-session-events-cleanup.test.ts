import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConductorDaemon } from "../helpers/ConductorDaemon.js";
import { TestEnv } from "../helpers/TestEnv.js";
import { byMsgData, pollLog } from "../helpers/logUtils.js";

const SESSION_CREATOR = join(import.meta.dir, "../fixtures/plugins/session-creator.plugin.ts");

describe("16 — session events dir cleanup on complete", () => {
  let env: TestEnv;
  let daemon: ConductorDaemon;

  beforeEach(async () => {
    env = new TestEnv({
      idleTimeoutMs: 2_000,
      plugins: [{ path: SESSION_CREATOR }],
    });
    await env.setup();
    daemon = new ConductorDaemon();
    await daemon.start(env);
    await daemon.waitForReady();
  });

  afterEach(async () => {
    await daemon.stop().catch(() => {});
    await env.teardown();
  });

  it("events dir is removed after session reaches COMPLETE", async () => {
    const sessions = await env.hiveSessionList();
    const session = sessions[0];
    expect(session).toBeDefined();
    if (!session) return;

    const eventsDir = join(env.conductorDataPath, "sessions", session.id, "events");

    // Drive CREATED → ACTIVE (creates at least one event file in eventsDir)
    await daemon.signal("activity", session.id);
    await pollLog(env.logPath, byMsgData("session state transition", { to: "ACTIVE" }), 5_000);

    expect(existsSync(eventsDir)).toBe(true);

    // Drive ACTIVE → IDLE
    await daemon.signal("stop", session.id);
    await pollLog(env.logPath, byMsgData("session state transition", { to: "IDLE" }), 5_000);

    // Idle timer fires after 2s → COMPLETE → cleanup
    await pollLog(env.logPath, byMsgData("session state transition", { to: "COMPLETE" }), 6_000);

    // Wait briefly for the async finally block to execute
    await new Promise((r) => setTimeout(r, 200));

    expect(existsSync(eventsDir)).toBe(false);
  }, 20_000);

  it("session dir is preserved after events dir is removed", async () => {
    const sessions = await env.hiveSessionList();
    const session = sessions[0];
    expect(session).toBeDefined();
    if (!session) return;

    const sessionDir = join(env.conductorDataPath, "sessions", session.id);

    await daemon.signal("activity", session.id);
    await pollLog(env.logPath, byMsgData("session state transition", { to: "ACTIVE" }), 5_000);

    await daemon.signal("stop", session.id);
    await pollLog(env.logPath, byMsgData("session state transition", { to: "IDLE" }), 5_000);

    await pollLog(env.logPath, byMsgData("session state transition", { to: "COMPLETE" }), 6_000);
    await new Promise((r) => setTimeout(r, 200));

    // The parent session dir may still exist (only events/ is removed)
    const eventsDir = join(sessionDir, "events");
    expect(existsSync(eventsDir)).toBe(false);
  }, 20_000);
});
