import { join } from "node:path";
import { ConductorDaemon } from "../helpers/ConductorDaemon.js";
import { TestEnv } from "../helpers/TestEnv.js";
import { byMsgData, pollLog } from "../helpers/logUtils.js";

const SESSION_CREATOR = join(import.meta.dir, "../fixtures/plugins/session-creator.plugin.ts");

describe("03 — state: ACTIVE via signal", () => {
  let env: TestEnv;
  let daemon: ConductorDaemon;

  beforeEach(async () => {
    env = new TestEnv({ plugins: [{ path: SESSION_CREATOR }] });
    await env.setup();
    daemon = new ConductorDaemon();
    await daemon.start(env);
    await daemon.waitForReady();
  });

  afterEach(async () => {
    await daemon.stop().catch(() => {});
    await env.teardown();
  });

  it("conductor signal activity drives session to ACTIVE state", async () => {
    const sessions = await env.hiveSessionList();
    const session = sessions[0];
    expect(session).toBeDefined();
    if (!session) return;

    await daemon.signal("activity", session.id);

    // Poll the log for the state transition entry (written synchronously by logger)
    const entry = await pollLog(env.logPath, byMsgData("session state transition", { to: "ACTIVE" }), 5_000);
    expect(entry.data?.from).toBe("CREATED");
    expect(entry.data?.to).toBe("ACTIVE");
  });
});
