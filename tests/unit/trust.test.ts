import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConductorConfig } from "../../src/config.js";
import {
  checkTrust,
  getStoredHash,
  hashPlugin,
  persistTrustedPlugins,
  promptTrustApproval,
} from "../../src/plugins/loader.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpDir(): string {
  const dir = join(tmpdir(), `trust-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeConfig(trusted: Record<string, string> = {}): ConductorConfig {
  return {
    plugins: [],
    trustedPlugins: trusted,
    concurrency: { global: 10 },
    observability: {
      metricsPort: 9090,
      logPath: "~/.local/dotlogs/conductor.log",
      logMaxBytes: 10_485_760,
      logMaxBackups: 5,
      logFormat: "json" as const,
      logCaller: false,
    },
    idleTimeoutMs: 600_000,
    builtins: {},
  };
}

// ── hashPlugin ────────────────────────────────────────────────────────────────

describe("hashPlugin", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  it("returns sha256:<hex> for a file", async () => {
    const file = join(dir, "plugin.ts");
    writeFileSync(file, "export default { id: 'test' };");
    const hash = await hashPlugin(file);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("returns the same hash for the same contents", async () => {
    const content = "export default { id: 'stable' };";
    const f1 = join(dir, "a.ts");
    const f2 = join(dir, "b.ts");
    writeFileSync(f1, content);
    writeFileSync(f2, content);
    expect(await hashPlugin(f1)).toBe(await hashPlugin(f2));
  });

  it("returns different hashes for different contents", async () => {
    const f1 = join(dir, "a.ts");
    const f2 = join(dir, "b.ts");
    writeFileSync(f1, "export default { id: 'a' };");
    writeFileSync(f2, "export default { id: 'b' };");
    expect(await hashPlugin(f1)).not.toBe(await hashPlugin(f2));
  });

  it("throws if file does not exist", async () => {
    await expect(hashPlugin(join(dir, "missing.ts"))).rejects.toThrow();
  });
});

// ── getStoredHash ─────────────────────────────────────────────────────────────

describe("getStoredHash", () => {
  it("returns the stored hash when the trust key is present", () => {
    const config = makeConfig({ "./plugins/my.ts": "sha256:abc123" });
    expect(getStoredHash(config, "./plugins/my.ts")).toBe("sha256:abc123");
  });

  it("returns undefined when the trust key is absent", () => {
    const config = makeConfig();
    expect(getStoredHash(config, "./plugins/unknown.ts")).toBeUndefined();
  });
});

// ── checkTrust ────────────────────────────────────────────────────────────────

describe("checkTrust", () => {
  it("returns 'unknown' when the trust key is not in trustedPlugins", () => {
    const config = makeConfig();
    expect(checkTrust("./plugins/new.ts", "sha256:abc", config)).toBe("unknown");
  });

  it("returns 'trusted' when hash matches stored hash", () => {
    const config = makeConfig({ "./plugins/my.ts": "sha256:abc" });
    expect(checkTrust("./plugins/my.ts", "sha256:abc", config)).toBe("trusted");
  });

  it("returns 'changed' when hash differs from stored hash", () => {
    const config = makeConfig({ "./plugins/my.ts": "sha256:abc" });
    expect(checkTrust("./plugins/my.ts", "sha256:xyz", config)).toBe("changed");
  });
});

// ── promptTrustApproval ───────────────────────────────────────────────────────

describe("promptTrustApproval", () => {
  const meta = {
    path: "/path/to/plugin.ts",
    hash: "sha256:abc123",
  };

  it("returns true when user answers 'y'", async () => {
    const result = await promptTrustApproval(meta, "new", async () => "y");
    expect(result).toBe(true);
  });

  it("returns true when user answers 'yes'", async () => {
    const result = await promptTrustApproval(meta, "new", async () => "yes");
    expect(result).toBe(true);
  });

  it("returns false when user answers 'n'", async () => {
    const result = await promptTrustApproval(meta, "new", async () => "n");
    expect(result).toBe(false);
  });

  it("returns false when user presses enter (empty answer)", async () => {
    const result = await promptTrustApproval(meta, "new", async () => "");
    expect(result).toBe(false);
  });

  it("passes reason 'new' for unknown plugins", async () => {
    let capturedQuestion = "";
    await promptTrustApproval(meta, "new", async (q) => {
      capturedQuestion = q;
      return "n";
    });
    expect(capturedQuestion).toContain("New plugin");
  });

  it("passes reason 'changed' for modified plugins", async () => {
    let capturedQuestion = "";
    await promptTrustApproval(meta, "changed", async (q) => {
      capturedQuestion = q;
      return "n";
    });
    expect(capturedQuestion).toContain("Plugin file changed");
  });

  it("includes path and hash in the prompt", async () => {
    let capturedQuestion = "";
    await promptTrustApproval(meta, "new", async (q) => {
      capturedQuestion = q;
      return "n";
    });
    expect(capturedQuestion).toContain("/path/to/plugin.ts");
    expect(capturedQuestion).toContain("sha256:abc123");
  });
});

// ── persistTrustedPlugins ─────────────────────────────────────────────────────

describe("persistTrustedPlugins", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  it("writes approved hashes into config file", async () => {
    const config = makeConfig({ "./plugins/existing.ts": "sha256:old" });
    const configPath = join(dir, "conductor.config.json");
    const approvals = [{ trustKey: "./plugins/new.ts", hash: "sha256:new123" }];

    await persistTrustedPlugins(approvals, config, configPath);

    const written = JSON.parse(await Bun.file(configPath).text()) as ConductorConfig;
    expect(written.trustedPlugins["./plugins/new.ts"]).toBe("sha256:new123");
    expect(written.trustedPlugins["./plugins/existing.ts"]).toBe("sha256:old");
  });

  it("does not modify the original config object", async () => {
    const config = makeConfig();
    const configPath = join(dir, "conductor.config.json");
    await persistTrustedPlugins([{ trustKey: "./plugins/p.ts", hash: "sha256:h" }], config, configPath);
    expect(config.trustedPlugins["./plugins/p.ts"]).toBeUndefined();
  });

  it("overwrites an existing hash for the same trust key", async () => {
    const config = makeConfig({ "./plugins/my.ts": "sha256:old" });
    const configPath = join(dir, "conductor.config.json");
    await persistTrustedPlugins([{ trustKey: "./plugins/my.ts", hash: "sha256:new" }], config, configPath);
    const written = JSON.parse(await Bun.file(configPath).text()) as ConductorConfig;
    expect(written.trustedPlugins["./plugins/my.ts"]).toBe("sha256:new");
  });
});
