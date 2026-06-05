import { join } from "node:path";
import { openKVDatabase } from "../../../src/sdk/kv.js";
import { ConductorDaemon } from "../helpers/ConductorDaemon.js";
import { TestEnv } from "../helpers/TestEnv.js";

const KV_SCOPE_A = join(
  import.meta.dir,
  "../fixtures/plugins/kv-scope-a.plugin.ts",
);
const KV_SCOPE_B = join(
  import.meta.dir,
  "../fixtures/plugins/kv-scope-b.plugin.ts",
);

describe("10 — KV scope isolation", () => {
  let env: TestEnv;
  let daemon: ConductorDaemon;

  beforeEach(async () => {
    env = new TestEnv({
      plugins: [{ path: KV_SCOPE_A }, { path: KV_SCOPE_B }],
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

  it("each plugin reads only its own scoped value for the same key", async () => {
    const db = openKVDatabase(env.conductorDataPath);
    const storeA = db.forPlugin("test-kv-scope-a");
    const storeB = db.forPlugin("test-kv-scope-b");

    const valA = await storeA.get<string>("probe");
    const valB = await storeB.get<string>("probe");

    db.close();

    expect(valA).toBe("from-a");
    expect(valB).toBe("from-b");
  });
});
