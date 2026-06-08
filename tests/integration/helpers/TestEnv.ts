import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConductorConfig } from "../../../src/config.js";
import type { HiveSessionRecord } from "../../../src/core/hive-client.js";
import { hashPlugin } from "../../../src/plugins/loader.js";

// ── Port allocation ───────────────────────────────────────────────────────────

// Random base per process + per-instance increment avoids cross-worker conflicts
// when bun test runs multiple scenario files concurrently.
const portBase = 40000 + Math.floor(Math.random() * 5000);
let portOffset = 0;

function allocatePort(): number {
  return portBase + portOffset++;
}

// ── Git env for commits ───────────────────────────────────────────────────────

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Conductor Test",
  GIT_AUTHOR_EMAIL: "test@conductor.local",
  GIT_COMMITTER_NAME: "Conductor Test",
  GIT_COMMITTER_EMAIL: "test@conductor.local",
  // Disable GPG/SSH signing for test repos — no project commits are involved
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "tag.gpgsign",
  GIT_CONFIG_VALUE_1: "false",
};

async function runGit(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`git ${args[0]} failed (${code}): ${err.trim()}`);
  }
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface PluginOpt {
  path: string;
  idleTimeoutMs?: number;
  concurrencyLimit?: number;
}

export interface TestEnvOptions {
  idleTimeoutMs?: number;
  globalConcurrency?: number;
  prePromptTemplate?: string;
  postPromptTemplate?: string;
  plugins?: PluginOpt[];
}

// ── TestEnv ───────────────────────────────────────────────────────────────────

export class TestEnv {
  readonly root: string;
  readonly hivePath: string;
  readonly conductorDataPath: string;
  readonly logPath: string;
  readonly configPath: string;
  readonly hiveConfigPath: string;
  readonly metricsPort: number;

  private readonly opts: TestEnvOptions;
  private _bareRepoUrl = "";

  constructor(opts: TestEnvOptions = {}) {
    this.opts = opts;
    this.root = mkdtempSync(join(tmpdir(), "conductor-int-"));
    this.hivePath = join(this.root, "hive-data");
    this.conductorDataPath = join(this.root, "conductor-data");
    this.logPath = join(this.root, "logs", "conductor.log");
    this.configPath = join(this.root, "conductor.config.json");
    this.hiveConfigPath = join(this.root, "hive.yaml");
    this.metricsPort = allocatePort();
  }

  get bareRepoUrl(): string {
    return this._bareRepoUrl;
  }

  get processEnv(): Record<string, string> {
    return {
      ...(process.env as Record<string, string>),
      HIVE_DATA_DIR: this.hivePath,
      HIVE_CONFIG: this.hiveConfigPath,
      HIVE_LOG_LEVEL: "error",
      CONDUCTOR_DATA_DIR_TEST_OVERRIDE: this.conductorDataPath,
      TEST_REMOTE: this._bareRepoUrl,
    };
  }

  async setup(): Promise<void> {
    // Create directory structure
    for (const dir of [this.hivePath, this.conductorDataPath, join(this.root, "logs"), join(this.root, "git-remote")]) {
      mkdirSync(dir, { recursive: true });
    }

    // Initialize bare git repo
    const bareRepoPath = join(this.root, "git-remote", "testrepo.git");
    const tmpClonePath = join(this.root, "git-init-tmp");
    this._bareRepoUrl = `file://${bareRepoPath}`;

    await runGit(["init", "--bare", bareRepoPath], this.root);
    await runGit(["init", tmpClonePath], this.root);
    await runGit(["commit", "--allow-empty", "-m", "initial"], tmpClonePath);
    await runGit(["remote", "add", "origin", bareRepoPath], tmpClonePath);
    // Push HEAD (works regardless of whether default branch is main or master)
    await runGit(["push", "-u", "origin", "HEAD"], tmpClonePath);
    rmSync(tmpClonePath, { recursive: true, force: true });

    // Write minimal hive config (no tmux, no agents that require external tools)
    writeFileSync(
      this.hiveConfigPath,
      `${'version: 0.2.7\ngit_path: git\nworkspaces: []\ntmux:\n  enabled: []\nagents:\n  default: ""'}\n`,
    );

    // Compute plugin hashes and build config
    const plugins: ConductorConfig["plugins"] = [];
    const trustedPlugins: Record<string, string> = {};

    for (const pluginOpt of this.opts.plugins ?? []) {
      const hash = await hashPlugin(pluginOpt.path);
      // Trust is keyed by the config-declared path, matching loadPlugins().
      trustedPlugins[pluginOpt.path] = hash;
      const entry: ConductorConfig["plugins"][number] = {
        path: pluginOpt.path,
        enabled: true,
      };
      if (pluginOpt.idleTimeoutMs !== undefined) {
        entry.idleTimeoutMs = pluginOpt.idleTimeoutMs;
      }
      if (pluginOpt.concurrencyLimit !== undefined) {
        entry.concurrencyLimit = pluginOpt.concurrencyLimit;
      }
      plugins.push(entry);
    }

    const config: ConductorConfig = {
      plugins,
      trustedPlugins,
      concurrency: { global: this.opts.globalConcurrency ?? 10 },
      observability: {
        metricsPort: this.metricsPort,
        logPath: this.logPath,
        logMaxBytes: 10_485_760,
        logMaxBackups: 5,
        logFormat: "json" as const,
        logCaller: false,
      },
      idleTimeoutMs: this.opts.idleTimeoutMs ?? 60_000,
      builtins: {},
    };

    if (this.opts.prePromptTemplate !== undefined) {
      config.prePromptTemplate = this.opts.prePromptTemplate;
    }

    if (this.opts.postPromptTemplate !== undefined) {
      config.postPromptTemplate = this.opts.postPromptTemplate;
    }

    writeFileSync(this.configPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  async teardown(): Promise<void> {
    rmSync(this.root, { recursive: true, force: true });
  }

  async hiveSessionList(): Promise<HiveSessionRecord[]> {
    const proc = Bun.spawn(["hive", "session", "list", "--json"], {
      env: this.processEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`hive session list failed (${code}): ${err.trim()}`);
    }
    const output = await new Response(proc.stdout).text();
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HiveSessionRecord);
  }

  async pollHiveSessions(
    predicate: (sessions: HiveSessionRecord[]) => boolean,
    timeoutMs = 15_000,
  ): Promise<HiveSessionRecord[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const sessions = await this.hiveSessionList();
      if (predicate(sessions)) return sessions;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for hive sessions to match predicate`);
  }

  /**
   * Find the workspace directory for a session.
   *
   * Hive uses an internal workspace-directory ID that differs from the session's
   * `id` field, so we cannot derive the path mathematically. Instead we scan
   * HIVE_DATA_DIR/repos/ for the single directory that starts with
   * `<session.repo>-`. This works for any test that creates exactly one session
   * per repo name. Tests with multiple sessions for the same repo should not
   * call this method.
   */
  workDir(session: HiveSessionRecord): string {
    const reposDir = join(this.hivePath, "repos");
    try {
      const entries = readdirSync(reposDir);
      const prefix = `${session.repo}-`;
      const candidates = entries.filter((e) => e.startsWith(prefix));
      if (candidates.length === 1 && candidates[0]) return join(reposDir, candidates[0]);
    } catch {
      // repos dir doesn't exist yet
    }
    return join(this.hivePath, "repos", `${session.repo}-${session.id}`);
  }
}
