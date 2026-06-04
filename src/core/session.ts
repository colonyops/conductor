import type { Session } from "../types.js";

export async function injectHooks(
  workDir: string,
  sessionId: string,
): Promise<void> {
  const settingsPath = `${workDir}/.claude/settings.json`;
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await Bun.file(settingsPath).text());
  } catch {
    // file doesn't exist yet — start fresh
  }

  const hooks = (existing.hooks as Record<string, unknown> | undefined) ?? {};
  const stopCmd = `conductor signal stop --session ${sessionId}`;
  const activityCmd = `conductor signal activity --session ${sessionId}`;

  existing.hooks = {
    ...hooks,
    Stop: [{ hooks: [{ type: "command", command: stopCmd }] }],
    PostToolUse: [{ hooks: [{ type: "command", command: activityCmd }] }],
  };

  await Bun.write(settingsPath, `${JSON.stringify(existing, null, 2)}\n`);
}

const CONDUCTOR_MARKER_START = "<!-- conductor:start -->";
const CONDUCTOR_MARKER_END = "<!-- conductor:end -->";

export async function injectPrePrompt(
  workDir: string,
  template: string,
): Promise<void> {
  const claudeMdPath = `${workDir}/CLAUDE.md`;
  let content = "";
  try {
    content = await Bun.file(claudeMdPath).text();
  } catch {
    // file doesn't exist — will be created
  }

  const block = `${CONDUCTOR_MARKER_START}\n${template}\n${CONDUCTOR_MARKER_END}`;

  if (content.includes(CONDUCTOR_MARKER_START)) {
    const re = new RegExp(
      `${CONDUCTOR_MARKER_START}[\\s\\S]*?${CONDUCTOR_MARKER_END}`,
      "g",
    );
    content = content.replace(re, block);
  } else {
    content = block + (content ? `\n\n${content}` : "");
  }

  await Bun.write(claudeMdPath, content);
}

export function buildSession(
  id: string,
  name: string,
  pluginId: string,
  workDir: string,
  isEphemeral: boolean,
  conductorDataDir: string,
): Session {
  const eventsDir = `${conductorDataDir}/sessions/${id}/events`;
  return {
    id,
    name,
    state: "CREATED",
    pluginId,
    createdAt: new Date(),
    eventsDir,
    workDir,
    isEphemeral,
  };
}
