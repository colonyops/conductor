import { existsSync, readdirSync } from "node:fs";
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
  background?: boolean;
  cloneStrategy?: "full" | "worktree";
  agent?: string;
}

function hiveDataDir(): string {
  return process.env.HIVE_DATA_DIR ?? join(homedir(), ".local/share/hive");
}

function deriveWorkDir(repo: string, sessionId: string): string {
  return join(hiveDataDir(), "repos", `${repo}-${sessionId}`);
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

// Serialize hiveNew calls: the before/after diff approach is not safe when
// multiple calls run concurrently against the same hive DB and repos directory.
let hiveNewQueue: Promise<void> = Promise.resolve();

export async function hiveNew(
  args: HiveNewSessionArgs,
): Promise<{ id: string; workDir: string }> {
  // Wait for any in-flight hiveNew call to finish before starting this one.
  const prev = hiveNewQueue;
  let release!: () => void;
  hiveNewQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    const before = await hiveSessionList();
    const beforeIds = new Set(before.map((s) => s.id));

    // Snapshot repos directory before cloning so we can detect the new workspace.
    // The workspace directory ID differs from the session ID in hive's data model.
    const reposDir = join(hiveDataDir(), "repos");
    const beforeRepos = new Set(
      existsSync(reposDir) ? readdirSync(reposDir) : [],
    );

    const cmd = ["hive", "new", args.name, "--remote", args.remote];
    if (args.background) cmd.push("--background");
    if (args.cloneStrategy) cmd.push("--clone-strategy", args.cloneStrategy);
    if (args.agent) cmd.push("--agent", args.agent);

    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    // Do not fail on non-zero exit: `hive new --background` often exits non-zero
    // due to terminal spawning failures (e.g., duplicate tmux session name) even
    // when the session workspace was successfully cloned. Session creation success
    // is determined by whether a new session appears in the session list.

    const after = await hiveSessionList();
    const newSession = after.find((s) => !beforeIds.has(s.id));
    if (!newSession) {
      const err = await new Response(proc.stderr).text();
      throw new Error(
        `hive new did not create a session. stderr: ${err.trim()}`,
      );
    }

    // Find the newly created workspace directory. This must be detected by
    // directory scanning because hive's workspace-directory ID (the suffix in
    // repos/<repo>-<suffix>) is distinct from the session's id field.
    const afterRepos = existsSync(reposDir) ? readdirSync(reposDir) : [];
    const newRepoDir = afterRepos.find((dir) => !beforeRepos.has(dir));
    const workDir = newRepoDir
      ? join(reposDir, newRepoDir)
      : deriveWorkDir(newSession.repo, newSession.id); // fallback (e.g. recycled session)

    return { id: newSession.id, workDir };
  } finally {
    release();
  }
}

export async function hiveRecycle(_sessionId: string): Promise<void> {
  // No `hive recycle` CLI exists. hive auto-recycles sessions via `hive new`.
}
