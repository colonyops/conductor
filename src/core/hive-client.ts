import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../sdk/logger.js";

export interface HiveSessionRecord {
  id: string;
  name: string;
  repo: string;
  inbox: string;
  state: "active" | "recycled";
  unread: number;
  tags?: string[];
}

export interface HiveNewSessionArgs {
  name: string;
  remote: string;
  prompt?: string;
  agent?: string;
  tags?: string[];
  logger?: Logger;
}

interface HiveBatchResult {
  name: string;
  session_id: string;
  path: string;
  status: "created" | "failed" | "skipped";
  error?: string;
}

interface HiveBatchOutput {
  batch_id: string;
  log_file: string;
  results: HiveBatchResult[];
}

function hiveDataDir(): string {
  return process.env.HIVE_DATA_DIR ?? join(homedir(), ".local/share/hive");
}

function extractJSON(raw: string): string {
  // Strip ANSI escape codes, then find the last top-level JSON object
  // (hook output precedes it on stdout).
  const clean = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape stripping
    .replace(/\x1b\[[0-9;]*[mGKHF]/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape stripping
    .replace(/\x1b\][^\x07]*\x07/g, "");
  const idx = clean.lastIndexOf("\n{");
  if (idx !== -1) return clean.slice(idx + 1);
  const fallback = clean.indexOf("{");
  if (fallback !== -1) return clean.slice(fallback);
  throw new Error("No JSON object found in hive batch output");
}

export async function hiveSessionList(tags?: string[]): Promise<HiveSessionRecord[]> {
  const args = ["hive", "session", "list", "--json"];
  if (tags) {
    for (const tag of tags) {
      args.push("--tags", tag);
    }
  }
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`hive session list failed (exit ${exitCode}): ${err.trim()}`);
  }
  const output = await new Response(proc.stdout).text();
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HiveSessionRecord);
}

// Serialize hiveNew calls to avoid races against the hive DB.
let hiveNewQueue: Promise<void> = Promise.resolve();

export async function hiveNew(args: HiveNewSessionArgs): Promise<{ id: string; workDir: string; existed: boolean }> {
  const prev = hiveNewQueue;
  let release!: () => void;
  hiveNewQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    const input = JSON.stringify({
      sessions: [
        {
          name: args.name,
          remote: args.remote,
          ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
          ...(args.agent !== undefined ? { agent: args.agent } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
        },
      ],
    });

    const proc = Bun.spawn(["hive", "batch"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(input);
    proc.stdin.end();
    await proc.exited;

    const raw = await new Response(proc.stdout).text();

    let parsed: HiveBatchOutput;
    try {
      parsed = JSON.parse(extractJSON(raw)) as HiveBatchOutput;
    } catch (e) {
      throw new Error(
        `Failed to parse hive batch output: ${e instanceof Error ? e.message : String(e)}\nRaw output: ${raw}`,
      );
    }

    const result = parsed.results[0];

    if (result?.status !== "created") {
      if (result?.error?.includes("already exists")) {
        const existing = (await hiveSessionList()).find((s) => s.name === args.name);
        if (existing) {
          return { id: existing.id, workDir: "", existed: true };
        }
      }
      throw new Error(`hive batch did not create session: ${result?.error ?? result?.status ?? "no result"}`);
    }

    await acceptTrustPrompt(result.name, result.path, args.logger ? { logger: args.logger } : {});

    return { id: result.session_id, workDir: result.path, existed: false };
  } finally {
    release();
  }
}

// Claude Code encodes the project path as the directory name under ~/.claude/projects/
// by replacing '/' with '-' and removing '.'.
function encodeProjectPath(absPath: string): string {
  return absPath.replace(/\//g, "-").replace(/\./g, "");
}

// Matches Claude Code's "Do you trust the files in this folder?" trust dialog.
const TRUST_PROMPT_PATTERN = /do you trust the files|trust the files in this folder/i;

// External operations acceptTrustPrompt depends on, injectable for testing.
export interface AcceptTrustDeps {
  capturePane(target: string): Promise<{ ok: boolean; content: string }>;
  sendKeys(target: string, keys: string[]): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  alreadyTrusted(workDir: string): boolean;
}

async function tmuxCapturePane(target: string): Promise<{ ok: boolean; content: string }> {
  const proc = Bun.spawn(["tmux", "capture-pane", "-t", target, "-p"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const content = await new Response(proc.stdout).text();
  return { ok: exitCode === 0, content };
}

async function tmuxSendKeys(target: string, keys: string[]): Promise<boolean> {
  const proc = Bun.spawn(["tmux", "send-keys", "-t", target, ...keys], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return (await proc.exited) === 0;
}

const defaultTrustDeps: AcceptTrustDeps = {
  capturePane: tmuxCapturePane,
  sendKeys: tmuxSendKeys,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  alreadyTrusted: (workDir) => existsSync(join(homedir(), ".claude", "projects", encodeProjectPath(workDir))),
};

export interface AcceptTrustOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  logger?: Logger;
  deps?: AcceptTrustDeps;
}

// acceptTrustPrompt accepts Claude Code's first-run trust dialog for a freshly
// created session. It polls the tmux pane until the prompt is rendered rather
// than guessing a fixed delay, checks the send-keys exit code, and logs a
// warning when the prompt never appears or the keystroke cannot be delivered.
export async function acceptTrustPrompt(
  sessionName: string,
  workDir: string,
  options: AcceptTrustOptions = {},
): Promise<void> {
  const { pollIntervalMs = 250, timeoutMs = 15_000, logger, deps = defaultTrustDeps } = options;

  if (deps.alreadyTrusted(workDir)) {
    // Directory already trusted from a prior session — no prompt will appear.
    return;
  }

  const target = `${sessionName}:claude`;
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  let paneAccessible = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { ok, content } = await deps.capturePane(target);
    paneAccessible = paneAccessible || ok;

    if (ok && TRUST_PROMPT_PATTERN.test(content)) {
      const sent = await deps.sendKeys(target, ["Enter"]);
      if (sent) {
        logger?.debug("accepted trust prompt", { session: sessionName, target, attempt });
      } else {
        logger?.warn("trust prompt detected but tmux send-keys failed", { session: sessionName, target });
      }
      return;
    }

    if (attempt < maxAttempts - 1) {
      await deps.sleep(pollIntervalMs);
    }
  }

  logger?.warn("trust prompt not detected before timeout; session may be blocked on the trust dialog", {
    session: sessionName,
    target,
    timeoutMs,
    paneAccessible,
  });
}

export async function hiveRecycle(sessionId: string): Promise<void> {
  const proc = Bun.spawn(["hive", "session", "recycle", sessionId], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`hive session recycle failed (exit ${exitCode}): ${err.trim()}`);
  }
}

export { hiveDataDir };
