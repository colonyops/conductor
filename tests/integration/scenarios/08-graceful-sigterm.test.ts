import { ConductorDaemon } from "../helpers/ConductorDaemon.js";
import { TestEnv } from "../helpers/TestEnv.js";
import { byMsg, parseLog } from "../helpers/logUtils.js";

describe("08 — graceful SIGTERM shutdown", () => {
  let env: TestEnv;
  let daemon: ConductorDaemon;

  beforeEach(async () => {
    env = new TestEnv();
    await env.setup();
    daemon = new ConductorDaemon();
    await daemon.start(env);
    await daemon.waitForReady();
  });

  afterEach(async () => {
    await daemon.stop().catch(() => {});
    await env.teardown();
  });

  it("exits with code 0 within 35s of SIGTERM", async () => {
    const exitCode = await daemon.stop(35_000);
    expect(exitCode).toBe(0);
  });

  it("logs Conductor stopped before exiting", async () => {
    await daemon.stop(35_000);

    const content = await Bun.file(env.logPath).text();
    const entry = parseLog(content).find(byMsg("Conductor stopped"));
    expect(entry).toBeDefined();
  });
});
