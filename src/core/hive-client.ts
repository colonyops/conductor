import { homedir } from "node:os";
import { join } from "node:path";

export interface HiveSessionRecord {
  id: string;
  name: string;
  repo: string;
  inbox: string;
  state: "active" | "recycled";
  unread: number;
}

export interface HiveNewSessionArgs {
  name: string;
  remote: string;
  prompt?: string;
  agent?: string;
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
    .replace(/\x1b\[[0-9;]*[mGKHF]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "");
  const idx = clean.lastIndexOf("\n{");
  if (idx !== -1) return clean.slice(idx + 1);
  const fallback = clean.indexOf("{");
  if (fallback !== -1) return clean.slice(fallback);
  throw new Error("No JSON object found in hive batch output");
}

export async function hiveSessionList(): Promise<HiveSessionRecord[]> {
  const proc = Bun.spawn(["hive", "session", "list", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(
      `hive session list failed (exit ${exitCode}): ${err.trim()}`,
    );
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

export async function hiveNew(
  args: HiveNewSessionArgs,
): Promise<{ id: string; workDir: string }> {
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
    if (!result || result.status !== "created") {
      throw new Error(
        `hive batch did not create session: ${result?.error ?? result?.status ?? "no result"}`,
      );
    }

    return { id: result.session_id, workDir: result.path };
  } finally {
    release();
  }
}

export async function hiveRecycle(_sessionId: string): Promise<void> {
  // No `hive recycle` CLI exists. hive auto-recycles sessions via `hive new`.
}

export { hiveDataDir };
