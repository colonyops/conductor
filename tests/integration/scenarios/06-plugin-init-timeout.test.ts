import { join } from "node:path";
import { ConductorDaemon } from "../helpers/ConductorDaemon.js";
import { TestEnv } from "../helpers/TestEnv.js";
import { parseLog, pollLog } from "../helpers/logUtils.js";

const SLOW_INIT = join(import.meta.dir, "../fixtures/plugins/slow-init.plugin.ts");
const FAST_INIT = join(import.meta.dir, "../fixtures/plugins/fast-init.plugin.ts");

describe("06 — plugin init timeout", () => {
  let env: TestEnv;
  let daemon: ConductorDaemon;

  // This test waits for the 30s INIT_TIMEOUT_MS to fire.
  // Allow generous headroom for system load when running in parallel.
  beforeEach(async () => {
    env = new TestEnv({
      plugins: [{ path: SLOW_INIT }, { path: FAST_INIT }],
    });
    await env.setup();
    daemon = new ConductorDaemon();
    await daemon.start(env);
    await daemon.waitForReady(55_000);
  });

  afterEach(async () => {
    await daemon.stop().catch(() => {});
    await env.teardown();
  });

  it("logs that the slow plugin timed out", async () => {
    const entry = await pollLog(
      env.logPath,
      (e) => e.msg === "Plugin init timed out" && e.data?.plugin === "Slow Init",
      5_000,
    );
    expect(entry).toBeDefined();
  }, 90_000);

  it("fast-init plugin still loads when slow-init times out", async () => {
    const content = await Bun.file(env.logPath).text();
    const loaded = parseLog(content).find((e) => e.msg === "Plugin loaded" && e.data?.pluginId === "test-fast-init");
    expect(loaded).toBeDefined();
  }, 90_000);

  it("conductor reports pluginCount: 1 (only fast-init loaded)", async () => {
    const content = await Bun.file(env.logPath).text();
    const started = parseLog(content).find((e) => e.msg === "Conductor started");
    expect(started?.data?.pluginCount).toBe(1);
  }, 90_000);
});
