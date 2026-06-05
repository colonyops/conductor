import { join } from "node:path";
import { ConductorDaemon } from "../helpers/ConductorDaemon.js";
import { TestEnv } from "../helpers/TestEnv.js";

const SESSION_CREATOR = join(import.meta.dir, "../fixtures/plugins/session-creator.plugin.ts");

describe("02 — session creation", () => {
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

  it("plugin creates a hive session visible in session list", async () => {
    // session-creator.plugin.ts calls hive.newSession() during init(),
    // so the session exists by the time waitForReady() returns.
    const sessions = await env.hiveSessionList();
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.name).toBe("int-test");
    expect(sessions[0]?.state).toBe("active");
  });

  it("session workspace is a directory under HIVE_DATA_DIR/repos", async () => {
    const sessions = await env.hiveSessionList();
    const session = sessions[0];
    expect(session).toBeDefined();
    if (!session) return;

    const workDir = env.workDir(session);
    const exists =
      (await Bun.file(`${workDir}/HEAD`)
        .exists()
        .catch(() => false)) ||
      (await Bun.file(`${workDir}/.git/HEAD`)
        .exists()
        .catch(() => false));
    expect(exists).toBe(true);
  });
});
