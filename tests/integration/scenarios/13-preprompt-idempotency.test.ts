import { join } from "node:path";
import { injectPrePrompt } from "../../../src/core/session.js";
import { ConductorDaemon } from "../helpers/ConductorDaemon.js";
import { TestEnv } from "../helpers/TestEnv.js";

const SESSION_CREATOR = join(
  import.meta.dir,
  "../fixtures/plugins/session-creator.plugin.ts",
);

const TEMPLATE = "## Conductor\nYou are running as a headless agent.";

describe("13 — pre-prompt injection idempotency", () => {
  let env: TestEnv;
  let daemon: ConductorDaemon;

  beforeEach(async () => {
    env = new TestEnv({
      prePromptTemplate: TEMPLATE,
      plugins: [{ path: SESSION_CREATOR }],
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

  it("CLAUDE.md contains exactly one conductor block after initial injection", async () => {
    const sessions = await env.hiveSessionList();
    const session = sessions[0];
    expect(session).toBeDefined();
    if (!session) return;

    const workDir = env.workDir(session);
    const content = await Bun.file(`${workDir}/CLAUDE.md`).text();

    const startCount = (content.match(/<!-- conductor:start -->/g) ?? [])
      .length;
    expect(startCount).toBe(1);
  });

  it("CLAUDE.md still has exactly one block after a second injection", async () => {
    const sessions = await env.hiveSessionList();
    const session = sessions[0];
    if (!session) return;

    const workDir = env.workDir(session);

    // Re-inject directly — simulates conductor restart or re-injection
    await injectPrePrompt(workDir, TEMPLATE);

    const content = await Bun.file(`${workDir}/CLAUDE.md`).text();
    const startCount = (content.match(/<!-- conductor:start -->/g) ?? [])
      .length;
    expect(startCount).toBe(1);
  });
});
