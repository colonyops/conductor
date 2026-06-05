import { join } from "node:path";
import { ConductorDaemon } from "../helpers/ConductorDaemon.js";
import { TestEnv } from "../helpers/TestEnv.js";

const SESSION_CREATOR = join(import.meta.dir, "../fixtures/plugins/session-creator.plugin.ts");

describe("07 — hook injection", () => {
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

  it("injects Stop and PostToolUse hooks into .claude/settings.local.json", async () => {
    const sessions = await env.hiveSessionList();
    const session = sessions[0];
    expect(session).toBeDefined();
    if (!session) return;

    const workDir = env.workDir(session);
    const settingsPath = `${workDir}/.claude/settings.local.json`;

    const text = await Bun.file(settingsPath).text();
    const settings = JSON.parse(text) as {
      hooks?: Record<string, unknown[]>;
    };

    expect(settings.hooks).toBeDefined();
    expect(settings.hooks?.Stop).toBeDefined();
    expect(settings.hooks?.PostToolUse).toBeDefined();
  });

  it("Stop hook command references the session id", async () => {
    const sessions = await env.hiveSessionList();
    const session = sessions[0];
    if (!session) return;

    const workDir = env.workDir(session);
    const text = await Bun.file(`${workDir}/.claude/settings.local.json`).text();
    const settings = JSON.parse(text) as {
      hooks: {
        Stop: Array<{ hooks: Array<{ command: string }> }>;
      };
    };

    const stopCmd = settings.hooks.Stop[0]?.hooks[0]?.command ?? "";
    expect(stopCmd).toContain(`--session ${session.id}`);
    expect(stopCmd).toContain("conductor signal stop");
  });

  it("PostToolUse hook command references the session id", async () => {
    const sessions = await env.hiveSessionList();
    const session = sessions[0];
    if (!session) return;

    const workDir = env.workDir(session);
    const text = await Bun.file(`${workDir}/.claude/settings.local.json`).text();
    const settings = JSON.parse(text) as {
      hooks: {
        PostToolUse: Array<{ hooks: Array<{ command: string }> }>;
      };
    };

    const activityCmd = settings.hooks.PostToolUse[0]?.hooks[0]?.command ?? "";
    expect(activityCmd).toContain(`--session ${session.id}`);
    expect(activityCmd).toContain("conductor signal activity");
  });
});
