import { ConductorDaemon } from "../helpers/ConductorDaemon.js";
import { TestEnv } from "../helpers/TestEnv.js";
import { byMsg, parseLog } from "../helpers/logUtils.js";

describe("01 — daemon start", () => {
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

  it("logs Conductor started with pluginCount 0", async () => {
    const content = await Bun.file(env.logPath).text();
    const entry = parseLog(content).find(byMsg("Conductor started"));
    expect(entry).toBeDefined();
    expect(entry?.data?.pluginCount).toBe(0);
  });

  it("is still running 500ms after start", async () => {
    await new Promise((r) => setTimeout(r, 500));
    expect(daemon.isRunning()).toBe(true);
  });

  it("metrics endpoint responds on configured port", async () => {
    const res = await fetch(`http://localhost:${env.metricsPort}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("conductor_sessions_total");
  });
});
