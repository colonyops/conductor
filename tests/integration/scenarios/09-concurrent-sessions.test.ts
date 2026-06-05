import { join } from "node:path";
import { ConductorDaemon } from "../helpers/ConductorDaemon.js";
import { TestEnv } from "../helpers/TestEnv.js";

const CONCURRENT_CREATOR = join(import.meta.dir, "../fixtures/plugins/concurrent-creator.plugin.ts");

describe("09 — concurrent session creation", () => {
  let env: TestEnv;
  let daemon: ConductorDaemon;

  beforeEach(async () => {
    env = new TestEnv({
      globalConcurrency: 5,
      plugins: [{ path: CONCURRENT_CREATOR }],
    });
    await env.setup();
    daemon = new ConductorDaemon();
    await daemon.start(env);
    // concurrent-creator creates 12 sessions during init(); allow 60s on a
    // loaded system (each hive new takes ~2s, limited to 5 concurrent = 3 batches)
    await daemon.waitForReady(60_000);
  });

  afterEach(async () => {
    await daemon.stop().catch(() => {});
    await env.teardown();
  });

  it("creates all 12 sessions despite a global concurrency limit of 5", async () => {
    // All sessions are created during plugin init(), so they're already present
    // by the time waitForReady() returns. Poll briefly for any stragglers.
    const sessions = await env.pollHiveSessions((ss) => ss.length === 12, 30_000);
    expect(sessions.length).toBe(12);
  }, 90_000);
});
