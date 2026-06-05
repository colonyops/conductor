import { join } from "node:path";
import { openKVDatabase } from "../../../src/sdk/kv.js";
import { ConductorDaemon } from "../helpers/ConductorDaemon.js";
import { TestEnv } from "../helpers/TestEnv.js";

const POLLING_DEDUP = join(
  import.meta.dir,
  "../fixtures/plugins/polling-dedup.plugin.ts",
);

describe("05 — KV dedup", () => {
  let env: TestEnv;
  let daemon: ConductorDaemon;

  beforeEach(async () => {
    env = new TestEnv({ plugins: [{ path: POLLING_DEDUP }] });
    await env.setup();
    daemon = new ConductorDaemon();
    await daemon.start(env);
    await daemon.waitForReady();
  });

  afterEach(async () => {
    await daemon.stop().catch(() => {});
    await env.teardown();
  });

  it("only creates one hive session despite multiple scheduler ticks", async () => {
    // Wait for enough ticks (plugin polls every 50ms)
    await new Promise((r) => setTimeout(r, 500));

    const sessions = await env.hiveSessionList();
    expect(sessions.length).toBe(1);
  });

  it("KV store records the dedup sentinel", async () => {
    await new Promise((r) => setTimeout(r, 500));

    const db = openKVDatabase(env.conductorDataPath);
    const store = db.forPlugin("test-polling-dedup");
    const done = await store.get<boolean>("done");
    db.close();

    expect(done).toBe(true);
  });
});
