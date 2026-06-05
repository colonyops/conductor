import { join } from "node:path";
import { ConductorDaemon } from "../helpers/ConductorDaemon.js";
import { TestEnv } from "../helpers/TestEnv.js";
import { byMsgData, pollLog } from "../helpers/logUtils.js";

const SESSION_CREATOR = join(import.meta.dir, "../fixtures/plugins/session-creator.plugin.ts");

describe("04 — state machine: IDLE → COMPLETE via idle timer", () => {
  let env: TestEnv;
  let daemon: ConductorDaemon;

  beforeEach(async () => {
    // Short idle timeout so the test completes quickly
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

  it("session transitions CREATED→ACTIVE→IDLE→COMPLETE", async () => {
    const sessions = await env.hiveSessionList();
    const session = sessions[0];
    expect(session).toBeDefined();
    if (!session) return;

    // Drive CREATED → ACTIVE
    await daemon.signal("activity", session.id);
    await pollLog(env.logPath, byMsgData("session state transition", { to: "ACTIVE" }), 5_000);

    // Drive ACTIVE → IDLE
    await daemon.signal("stop", session.id);
    await pollLog(env.logPath, byMsgData("session state transition", { to: "IDLE" }), 5_000);

    // Idle timer fires after 2s → COMPLETE
    const completeEntry = await pollLog(env.logPath, byMsgData("session state transition", { to: "COMPLETE" }), 6_000);
    expect(completeEntry.data?.from).toBe("IDLE");
  }, 20_000);
});
