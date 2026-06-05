import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ConductorDaemon } from "../helpers/ConductorDaemon.js";
import { TestEnv } from "../helpers/TestEnv.js";
import { byMsgData, pollLog } from "../helpers/logUtils.js";

describe("11 — restart signal recovery", () => {
  let env: TestEnv;
  let daemon: ConductorDaemon;

  beforeEach(async () => {
    env = new TestEnv();
    await env.setup();
  });

  afterEach(async () => {
    await daemon.stop().catch(() => {});
    await env.teardown();
  });

  it("processes a pre-written event file when a second event triggers the watcher", async () => {
    const sessionId = "recovery-test-session";
    const eventsDir = join(
      env.conductorDataPath,
      "sessions",
      sessionId,
      "events",
    );
    mkdirSync(eventsDir, { recursive: true });

    // Write first event BEFORE starting conductor
    const pre = {
      signal: "activity",
      sessionId,
      timestamp: new Date().toISOString(),
    };
    await Bun.write(
      join(eventsDir, `${Date.now() - 1000}-activity.json`),
      JSON.stringify(pre),
    );

    // Start conductor
    daemon = new ConductorDaemon();
    await daemon.start(env);
    await daemon.waitForReady();

    // Write a second event to trigger the fs.watch callback,
    // which will drain all unprocessed files in the same pass.
    await daemon.signal("activity", sessionId);

    // Both events should be drained — the IPC watcher drains all
    // sessions on every trigger, picking up the pre-written file too.
    // Since sessionId isn't in conductor's session map, applyTransition
    // is a no-op, but the drain still occurs (and files get .processed).
    // We verify by checking the session's events dir is fully drained.
    await new Promise((r) => setTimeout(r, 1_000));

    // The drain runs for any session directory found — even unknown sessions.
    // The log doesn't have a specific entry for "drained N events", but
    // we can verify by confirming the signal subprocess exited successfully.
    // (If the IPC watcher is broken, daemon.signal would still succeed since
    // it's write-only; the real verification is via the metrics endpoint.)
    const res = await fetch(`http://localhost:${env.metricsPort}/metrics`);
    const text = await res.text();
    // Both signals should be counted in ipc_events_total
    expect(text).toContain('conductor_ipc_events_total{signal="activity"} 2');
  });
});
