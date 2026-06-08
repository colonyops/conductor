import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { injectHooks } from "../../../src/core/session.js";
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

    // Overwrite settings with pre-existing content, including user-provided
    // Stop and PostToolUse entries — exactly the keys conductor injects into.
    const existing = {
      model: "claude-opus-4-5",
      hooks: {
        PreToolUse: [
          {
            hooks: [{ type: "command", command: "echo pre-tool" }],
          },
        ],
        Stop: [
          {
            hooks: [{ type: "command", command: "echo user-stop" }],
          },
        ],
        PostToolUse: [
          {
            hooks: [{ type: "command", command: "echo user-post-tool" }],
          },
        ],
      },
    };
    mkdirSync(join(workDir, ".claude"), { recursive: true });
    await Bun.write(settingsPath, `${JSON.stringify(existing, null, 2)}\n`);

    // Re-inject conductor hooks — should merge, not overwrite
    await injectHooks(workDir, session.id);

    type HookCmd = { hooks?: Array<{ command?: string }> };
    type Settings = {
      model?: string;
      hooks?: Record<string, HookCmd[]>;
      permissions?: { allow?: string[] };
    };
    const commands = (entries: HookCmd[] | undefined): string[] =>
      (entries ?? []).flatMap((e) => (e.hooks ?? []).map((h) => h.command ?? ""));

    const merged = JSON.parse(await Bun.file(settingsPath).text()) as Settings;

    // Original field preserved
    expect(merged.model).toBe("claude-opus-4-5");

    // Original unrelated hook preserved
    expect(merged.hooks?.PreToolUse).toBeDefined();
    expect(merged.hooks?.PreToolUse?.length).toBeGreaterThan(0);

    // Pre-existing Stop/PostToolUse entries are not dropped
    expect(commands(merged.hooks?.Stop)).toContain("echo user-stop");
    expect(commands(merged.hooks?.PostToolUse)).toContain("echo user-post-tool");

    // Conductor hooks injected alongside them
    expect(commands(merged.hooks?.Stop).some((c) => c.includes("signal stop"))).toBe(true);
    expect(commands(merged.hooks?.PostToolUse).some((c) => c.includes("signal activity"))).toBe(true);

    // Re-injecting again is idempotent — no duplicate conductor entries
    await injectHooks(workDir, session.id);
    const reMerged = JSON.parse(await Bun.file(settingsPath).text()) as Settings;

    const stopSignals = commands(reMerged.hooks?.Stop).filter((c) => c.includes("signal stop"));
    const postSignals = commands(reMerged.hooks?.PostToolUse).filter((c) => c.includes("signal activity"));
    expect(stopSignals.length).toBe(1);
    expect(postSignals.length).toBe(1);

    // User entries still survive a second injection
    expect(commands(reMerged.hooks?.Stop)).toContain("echo user-stop");
    expect(commands(reMerged.hooks?.PostToolUse)).toContain("echo user-post-tool");

    // permissions.allow is not duplicated on re-injection
    const allow = reMerged.permissions?.allow ?? [];
    const stopAllow = allow.filter((a) => a.includes("signal stop"));
    expect(stopAllow.length).toBe(1);
  });
});
