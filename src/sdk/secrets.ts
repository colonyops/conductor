export interface GetSecretOptions {
  /** If set, try process.env[env] first. */
  env?: string;
  /** If true, try `gh auth token` before falling back to keychain. */
  ghCLI?: boolean;
  /** If true, prompt interactively when not found and store in OS keychain. */
  promptIfMissing?: boolean;
}

export interface SecretsClient {
  /**
   * Resolve a secret by key. Resolution order:
   * 1. process.env[opts.env] if opts.env is set
   * 2. OS keychain (macOS: security / Linux: secret-tool)
   * 3. Interactive prompt (only if opts.promptIfMissing === true)
   * Throws if the secret cannot be resolved.
   */
  get(key: string, opts?: GetSecretOptions): Promise<string>;

  /** Store a secret in the OS keychain. */
  set(key: string, value: string): Promise<void>;
}

async function keychainGet(key: string): Promise<string | undefined> {
  try {
    if (process.platform === "darwin") {
      const proc = Bun.spawn(
        [
          "security",
          "find-generic-password",
          "-s",
          "conductor",
          "-a",
          key,
          "-w",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const code = await proc.exited;
      if (code !== 0) return undefined;
      const out = await new Response(proc.stdout).text();
      return out.trim() || undefined;
    }
    if (process.platform === "linux") {
      const proc = Bun.spawn(
        ["secret-tool", "lookup", "service", "conductor", "username", key],
        { stdout: "pipe", stderr: "pipe" },
      );
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
      const proc = Bun.spawn(
        [
          "security",
          "add-generic-password",
          "-U",
          "-s",
          "conductor",
          "-a",
          key,
          "-w",
          value,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      await proc.exited;
      return;
    }
    if (process.platform === "linux") {
      const proc = Bun.spawn(
        [
          "secret-tool",
          "store",
          "--label",
          `conductor/${key}`,
          "service",
          "conductor",
          "username",
          key,
        ],
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

async function ghCLIToken(): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["gh", "auth", "token"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) return undefined;
    const out = await new Response(proc.stdout).text();
    return out.trim() || undefined;
  } catch {
    // gh not installed
  }
  return undefined;
}

async function promptStdin(key: string): Promise<string> {
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

      const fromKeychain = await keychainGet(key);
      if (fromKeychain !== undefined) return fromKeychain;

      if (opts.promptIfMissing) {
        const val = await promptStdin(key);
        await keychainSet(key, val);
        return val;
      }

      throw new Error(
        `Secret "${key}" not found${opts.ghCLI ? " (gh auth token returned nothing)" : ""} in env or keychain`,
      );
    },

    async set(key, value) {
      await keychainSet(key, value);
    },
  };
}
