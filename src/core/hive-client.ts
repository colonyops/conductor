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

export async function hiveNew(
  args: HiveNewSessionArgs,
): Promise<{ id: string; workDir: string }> {
  const before = await hiveSessionList();
  const beforeIds = new Set(before.map((s) => s.id));

  const cmd = ["hive", "new", args.name, "--remote", args.remote];
  if (args.background) cmd.push("--background");
  if (args.cloneStrategy) cmd.push("--clone-strategy", args.cloneStrategy);
  if (args.agent) cmd.push("--agent", args.agent);

  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`hive new failed (exit ${exitCode}): ${err.trim()}`);
  }

  const after = await hiveSessionList();
  const newSession = after.find((s) => !beforeIds.has(s.id));
  if (!newSession) {
    throw new Error(
      "hive new completed but no new session found in session list",
    );
  }

  return {
    id: newSession.id,
    workDir: deriveWorkDir(newSession.repo, newSession.id),
  };
}

export async function hiveRecycle(_sessionId: string): Promise<void> {
  // No `hive recycle` CLI exists. hive auto-recycles sessions via `hive new`.
}
