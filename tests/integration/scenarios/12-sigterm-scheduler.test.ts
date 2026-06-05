import { join } from "node:path";
import { ConductorDaemon } from "../helpers/ConductorDaemon.js";
import { TestEnv } from "../helpers/TestEnv.js";
import { byMsg, parseLog } from "../helpers/logUtils.js";

const SCHEDULER_SIGTERM = join(
  import.meta.dir,
  "../fixtures/plugins/scheduler-sigterm.plugin.ts",
);

describe("12 — SIGTERM during active scheduler callback", () => {
  let env: TestEnv;
  let daemon: ConductorDaemon;

  beforeEach(async () => {
    env = new TestEnv({ plugins: [{ path: SCHEDULER_SIGTERM }] });
    await env.setup();
    daemon = new ConductorDaemon();
    await daemon.start(env);
    await daemon.waitForReady();
  });

  afterEach(async () => {
    await daemon.stop().catch(() => {});
    await env.teardown();
  });

  it("exits cleanly within 35s even if scheduler callback is mid-execution", async () => {
    // Wait for the first callback to fire (interval is 100ms)
    await new Promise((r) => setTimeout(r, 200));

    const exitCode = await daemon.stop(35_000);
    expect(exitCode).toBe(0);

    const content = await Bun.file(env.logPath).text();
    expect(parseLog(content).find(byMsg("Conductor stopped"))).toBeDefined();
  }, 40_000);
});
