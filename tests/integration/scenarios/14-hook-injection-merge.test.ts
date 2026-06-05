import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { injectHooks } from "../../../src/session/manager.js";
import { ConductorDaemon } from "../helpers/ConductorDaemon.js";
import { TestEnv } from "../helpers/TestEnv.js";

const SESSION_CREATOR = join(import.meta.dir, "../fixtures/plugins/session-creator.plugin.ts");

describe("14 — hook injection merge", () => {
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

  it("preserves existing settings.json fields when injecting conductor hooks", async () => {
    const sessions = await env.hiveSessionList();
    const session = sessions[0];
    expect(session).toBeDefined();
    if (!session) return;

    const workDir = env.workDir(session);
    const settingsPath = `${workDir}/.claude/settings.local.json`;

    // Overwrite settings with pre-existing content
    const existing = {
      model: "claude-opus-4-5",
      hooks: {
        PreToolUse: [
          {
            hooks: [{ type: "command", command: "echo pre-tool" }],
          },
        ],
      },
    };
    mkdirSync(join(workDir, ".claude"), { recursive: true });
    await Bun.write(settingsPath, `${JSON.stringify(existing, null, 2)}\n`);

    // Re-inject conductor hooks — should merge, not overwrite
    await injectHooks(workDir, session.id);

    const merged = JSON.parse(await Bun.file(settingsPath).text()) as {
      model?: string;
      hooks?: Record<string, unknown[]>;
    };

    // Original field preserved
    expect(merged.model).toBe("claude-opus-4-5");

    // Original hook preserved
    expect(merged.hooks?.PreToolUse).toBeDefined();
    expect(merged.hooks?.PreToolUse?.length).toBeGreaterThan(0);

    // Conductor hooks injected
    expect(merged.hooks?.Stop).toBeDefined();
    expect(merged.hooks?.PostToolUse).toBeDefined();
  });
});
