export interface GetSecretOptions {
  /** If set, try process.env[env] first. */
  env?: string;
  /** If true, try `gh auth token` before falling back to keychain. */
  ghCLI?: boolean;
  /**
   * If set, run this argv and take trimmed stdout as the token before falling
   * back to keychain. Lets any forge reuse its CLI's stored auth (e.g.
   * `["tea", "login", "default", "--token"]`) without a GitHub-specific path.
   * Tried after `ghCLI`.
   */
  cliToken?: string[];
  /** If true, prompt interactively when not found and store in OS keychain. */
  promptIfMissing?: boolean;
}

export interface SecretsClient {
  /**
   * Resolve a secret by key. Resolution order:
   * 1. process.env[opts.env] if opts.env is set
   * 2. `gh auth token` if opts.ghCLI is set
   * 3. opts.cliToken argv (trimmed stdout) if set
   * 4. OS keychain (macOS: security / Linux: secret-tool)
   * 5. Interactive prompt (only if opts.promptIfMissing === true)
   * Throws if the secret cannot be resolved.
   */
  get(key: string, opts?: GetSecretOptions): Promise<string>;

  /** Store a secret in the OS keychain. */
  set(key: string, value: string): Promise<void>;
}

async function keychainGet(key: string): Promise<string | undefined> {
  try {
    if (process.platform === "darwin") {
      const proc = Bun.spawn(["security", "find-generic-password", "-s", "conductor", "-a", key, "-w"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      if (code !== 0) return undefined;
      const out = await new Response(proc.stdout).text();
      return out.trim() || undefined;
    }
    if (process.platform === "linux") {
      const proc = Bun.spawn(["secret-tool", "lookup", "service", "conductor", "username", key], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      if (code !== 0) return undefined;
      const out = await new Response(proc.stdout).text();
      return out.trim() || undefined;
    }
  } catch {
    // keychain tool not available
  }
  return undefined;
}

async function keychainSet(key: string, value: string): Promise<void> {
  try {
    if (process.platform === "darwin") {
      // Pass the secret via stdin, not as a CLI arg: `-w` with no value makes
      // `security` read the password from stdin (prompting for it twice), so the
      // secret never appears in the process argument list visible to `ps`.
      const proc = Bun.spawn(["security", "add-generic-password", "-U", "-s", "conductor", "-a", key, "-w"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      proc.stdin.write(`${value}\n${value}\n`);
      proc.stdin.end();
      await proc.exited;
      return;
    }
    if (process.platform === "linux") {
      const proc = Bun.spawn(
        ["secret-tool", "store", "--label", `conductor/${key}`, "service", "conductor", "username", key],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      proc.stdin.write(value);
      proc.stdin.end();
      await proc.exited;
    }
  } catch {
    // keychain tool not available — silently ignore
  }
}

// Runs an argv and returns trimmed stdout as a token, or undefined if the
// command is missing, exits non-zero, or prints nothing.
async function spawnToken(argv: string[]): Promise<string | undefined> {
  if (argv.length === 0) return undefined;
  try {
    const proc = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) return undefined;
    const out = await new Response(proc.stdout).text();
    return out.trim() || undefined;
  } catch {
    // command not found / not executable
  }
  return undefined;
}

function ghCLIToken(): Promise<string | undefined> {
  return spawnToken(["gh", "auth", "token"]);
}

/**
 * Serializes interactive prompts. Concurrent secret.get() calls share a single
 * stdin, so without this chain multiple `once("data")` listeners would resolve
 * from the same input chunk and cross-talk between requests. Each prompt waits
 * for the previous one to settle before resuming stdin and reading.
 */
let promptChain: Promise<unknown> = Promise.resolve();

function readOnePrompt(key: string): Promise<string> {
  process.stdout.write(`Enter secret for "${key}": `);
  return new Promise<string>((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.once("data", (chunk) => {
      process.stdin.pause();
      resolve(String(chunk).trim());
    });
  });
}

async function promptStdin(key: string): Promise<string> {
  const result = promptChain.then(() => readOnePrompt(key));
  // Keep the chain alive even if this prompt rejects, so later prompts still run.
  promptChain = result.catch(() => undefined);
  return result;
}

export function createSecretsClient(): SecretsClient {
  return {
    async get(key, opts = {}) {
      if (opts.env) {
        const val = process.env[opts.env];
        if (val) return val;
      }

      if (opts.ghCLI) {
        const val = await ghCLIToken();
        if (val !== undefined) return val;
      }

      if (opts.cliToken) {
        const val = await spawnToken(opts.cliToken);
        if (val !== undefined) return val;
      }

      const fromKeychain = await keychainGet(key);
      if (fromKeychain !== undefined) return fromKeychain;

      if (opts.promptIfMissing) {
        const val = await promptStdin(key);
        await keychainSet(key, val);
        return val;
      }

      throw new Error(
        `Secret "${key}" not found${opts.ghCLI ? " (gh auth token returned nothing)" : ""}${
          opts.cliToken ? ` (cliToken \`${opts.cliToken.join(" ")}\` returned nothing)` : ""
        } in env or keychain`,
      );
    },

    async set(key, value) {
      await keychainSet(key, value);
    },
  };
}
