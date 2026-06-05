import { join } from "node:path";
import {
  injectPostPrompt,
  injectPrePrompt,
} from "../../../src/core/session.js";
import { ConductorDaemon } from "../helpers/ConductorDaemon.js";
import { TestEnv } from "../helpers/TestEnv.js";

const SESSION_CREATOR = join(
  import.meta.dir,
  "../fixtures/plugins/session-creator.plugin.ts",
);

const PRE_TEMPLATE = "## Conductor\nYou are running as a headless agent.";
const POST_TEMPLATE =
  "## After completing your task\nOpen a draft PR with a link to the issue.";

describe("15 — post-prompt injection", () => {
  let env: TestEnv;
  let daemon: ConductorDaemon;

  beforeEach(async () => {
    env = new TestEnv({
      postPromptTemplate: POST_TEMPLATE,
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

  it("CLAUDE.md contains the post-prompt block after session creation", async () => {
    const sessions = await env.hiveSessionList();
    const session = sessions[0];
    expect(session).toBeDefined();
    if (!session) return;

    const workDir = env.workDir(session);
    const content = await Bun.file(`${workDir}/CLAUDE.md`).text();

    expect(content).toContain("<!-- conductor:post-start -->");
    expect(content).toContain("<!-- conductor:post-end -->");
    expect(content).toContain(POST_TEMPLATE);
  });

  it("post-prompt block appears after existing content", async () => {
    const sessions = await env.hiveSessionList();
    const session = sessions[0];
    if (!session) return;

    const workDir = env.workDir(session);
    const content = await Bun.file(`${workDir}/CLAUDE.md`).text();

    const postStart = content.indexOf("<!-- conductor:post-start -->");
    // post block should be at or near the end
    expect(postStart).toBeGreaterThan(-1);
    const textAfterBlock = content
      .slice(content.indexOf("<!-- conductor:post-end -->") + 27)
      .trim();
    expect(textAfterBlock).toBe("");
  });

  it("CLAUDE.md has exactly one post-prompt block after re-injection", async () => {
    const sessions = await env.hiveSessionList();
    const session = sessions[0];
    if (!session) return;

    const workDir = env.workDir(session);

    await injectPostPrompt(workDir, POST_TEMPLATE);

    const content = await Bun.file(`${workDir}/CLAUDE.md`).text();
    const startCount = (
      content.match(/<!-- conductor:post-start -->/g) ?? []
    ).length;
    expect(startCount).toBe(1);
  });
});

describe("15 — pre and post prompt together", () => {
  it("injectPrePrompt then injectPostPrompt produces correct ordering", async () => {
    const tmpDir = join(
      import.meta.dir,
      `../../tmp-pp-test-${Math.random().toString(36).slice(2)}`,
    );
    const { mkdirSync, rmSync } = await import("node:fs");
    mkdirSync(tmpDir, { recursive: true });

    try {
      await injectPrePrompt(tmpDir, PRE_TEMPLATE);
      await injectPostPrompt(tmpDir, POST_TEMPLATE);

      const content = await Bun.file(`${tmpDir}/CLAUDE.md`).text();

      const preStart = content.indexOf("<!-- conductor:start -->");
      const postStart = content.indexOf("<!-- conductor:post-start -->");

      expect(preStart).toBeGreaterThan(-1);
      expect(postStart).toBeGreaterThan(-1);
      expect(preStart).toBeLessThan(postStart);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("both blocks are idempotent when injected twice", async () => {
    const tmpDir = join(
      import.meta.dir,
      `../../tmp-pp-idem-${Math.random().toString(36).slice(2)}`,
    );
    const { mkdirSync, rmSync } = await import("node:fs");
    mkdirSync(tmpDir, { recursive: true });

    try {
      await injectPrePrompt(tmpDir, PRE_TEMPLATE);
      await injectPostPrompt(tmpDir, POST_TEMPLATE);
      await injectPrePrompt(tmpDir, PRE_TEMPLATE);
      await injectPostPrompt(tmpDir, POST_TEMPLATE);

      const content = await Bun.file(`${tmpDir}/CLAUDE.md`).text();

      const preCount = (content.match(/<!-- conductor:start -->/g) ?? [])
        .length;
      const postCount = (
        content.match(/<!-- conductor:post-start -->/g) ?? []
      ).length;

      expect(preCount).toBe(1);
      expect(postCount).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
