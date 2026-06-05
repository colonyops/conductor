import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DEFAULTS, loadConfig, resolvePath, validateConfig } from "../../src/config.js";

describe("validateConfig", () => {
  it("returns defaults for empty object", () => {
    const { config, errors } = validateConfig({});
    expect(errors).toHaveLength(0);
    expect(config.concurrency.global).toBe(10);
    expect(config.idleTimeoutMs).toBe(600_000);
    expect(config.observability.metricsPort).toBe(9090);
    expect(config.observability.logMaxBytes).toBe(10_485_760);
    expect(config.observability.logMaxBackups).toBe(5);
    expect(config.plugins).toEqual([]);
    expect(config.trustedPlugins).toEqual({});
    expect(config.builtins).toEqual({});
  });

  it("merges partial config with defaults", () => {
    const { config, errors } = validateConfig({ idleTimeoutMs: 30_000 });
    expect(errors).toHaveLength(0);
    expect(config.idleTimeoutMs).toBe(30_000);
    expect(config.concurrency.global).toBe(10);
  });

  it("collects multiple errors without short-circuiting", () => {
    const { errors } = validateConfig({
      idleTimeoutMs: "bad",
      concurrency: { global: "also bad" },
      observability: { metricsPort: "nope" },
    });
    expect(errors.length).toBeGreaterThanOrEqual(3);
    const fields = errors.map((e) => e.field);
    expect(fields).toContain("idleTimeoutMs");
    expect(fields).toContain("concurrency.global");
    expect(fields).toContain("observability.metricsPort");
  });

  it("rejects non-object input", () => {
    const { errors } = validateConfig("not an object");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe("(root)");
  });

  it("rejects invalid plugin entry", () => {
    const { errors } = validateConfig({
      plugins: [{ enabled: true }],
    });
    expect(errors.some((e) => e.field === "plugins[0].path")).toBe(true);
  });

  it("rejects plugin with non-boolean enabled", () => {
    const { errors } = validateConfig({
      plugins: [{ path: "/some/path.ts", enabled: "yes" }],
    });
    expect(errors.some((e) => e.field === "plugins[0].enabled")).toBe(true);
  });

  it("accepts valid plugin entry", () => {
    const { config, errors } = validateConfig({
      plugins: [{ path: "/some/plugin.ts", enabled: true, idleTimeoutMs: 5000 }],
    });
    expect(errors).toHaveLength(0);
    expect(config.plugins[0]?.path).toBe("/some/plugin.ts");
    expect(config.plugins[0]?.idleTimeoutMs).toBe(5000);
  });

  it("defaults plugin enabled to true when omitted", () => {
    const { config, errors } = validateConfig({
      plugins: [{ path: "/some/plugin.ts" }],
    });
    expect(errors).toHaveLength(0);
    expect(config.plugins[0]?.enabled).toBe(true);
  });

  it("accepts valid trustedPlugins", () => {
    const { config, errors } = validateConfig({
      trustedPlugins: { "my-plugin": "sha256:abc123" },
    });
    expect(errors).toHaveLength(0);
    expect(config.trustedPlugins["my-plugin"]).toBe("sha256:abc123");
  });

  it("rejects trustedPlugins with non-string values", () => {
    const { errors } = validateConfig({
      trustedPlugins: { "my-plugin": 42 },
    });
    expect(errors.some((e) => e.field.startsWith("trustedPlugins"))).toBe(true);
  });

  it("rejects invalid concurrency.global", () => {
    const { errors } = validateConfig({ concurrency: { global: -1 } });
    expect(errors.some((e) => e.field === "concurrency.global")).toBe(true);
  });

  it("rejects out-of-range metricsPort", () => {
    const { errors } = validateConfig({
      observability: { metricsPort: 99999 },
    });
    expect(errors.some((e) => e.field === "observability.metricsPort")).toBe(true);
  });

  it("validates github-issues builtin repo format", () => {
    const { errors } = validateConfig({
      builtins: {
        "github-issues": {
          repo: "noslash",
          labels: ["bug"],
        },
      },
    });
    expect(errors.some((e) => e.field.includes("repo"))).toBe(true);
  });

  it("rejects empty labels array in github-issues builtin", () => {
    const { errors } = validateConfig({
      builtins: {
        "github-issues": {
          repo: "owner/repo",
          labels: [],
        },
      },
    });
    expect(errors.some((e) => e.field.includes("labels"))).toBe(true);
  });

  it("accepts valid github-issues builtin", () => {
    const { config, errors } = validateConfig({
      builtins: {
        "github-issues": {
          repo: "owner/repo",
          labels: ["conductor"],
          tokenSecretKey: "gh.token",
        },
      },
    });
    expect(errors).toHaveLength(0);
    expect(config.builtins["github-issues"]?.repo).toBe("owner/repo");
    expect(config.builtins["github-issues"]?.pollIntervalMs).toBe(300_000);
    expect(config.builtins["github-issues"]?.tokenSource).toBe("secret");
  });

  it("accepts assignee field in github-issues builtin", () => {
    const { config, errors } = validateConfig({
      builtins: {
        "github-issues": {
          repo: "owner/repo",
          labels: ["conductor"],
          assignee: "hay-kot",
        },
      },
    });
    expect(errors).toHaveLength(0);
    expect(config.builtins["github-issues"]?.assignee).toBe("hay-kot");
  });

  it("omits assignee from github-issues builtin when not set", () => {
    const { config, errors } = validateConfig({
      builtins: {
        "github-issues": {
          repo: "owner/repo",
          labels: ["conductor"],
        },
      },
    });
    expect(errors).toHaveLength(0);
    expect(config.builtins["github-issues"]?.assignee).toBeUndefined();
  });

  it("rejects non-string assignee in github-issues builtin", () => {
    const { errors } = validateConfig({
      builtins: {
        "github-issues": {
          repo: "owner/repo",
          labels: ["conductor"],
          assignee: 42,
        },
      },
    });
    expect(errors.some((e) => e.field.includes("assignee"))).toBe(true);
  });

  it("accepts valid prePromptTemplate", () => {
    const { config, errors } = validateConfig({
      prePromptTemplate: "You are an agent.",
    });
    expect(errors).toHaveLength(0);
    expect(config.prePromptTemplate).toBe("You are an agent.");
  });

  it("rejects non-string prePromptTemplate", () => {
    const { errors } = validateConfig({ prePromptTemplate: 42 });
    expect(errors.some((e) => e.field === "prePromptTemplate")).toBe(true);
  });

  it("accepts valid postPromptTemplate", () => {
    const { config, errors } = validateConfig({
      postPromptTemplate: "When done, open a draft PR.",
    });
    expect(errors).toHaveLength(0);
    expect(config.postPromptTemplate).toBe("When done, open a draft PR.");
  });

  it("rejects non-string postPromptTemplate", () => {
    const { errors } = validateConfig({ postPromptTemplate: 42 });
    expect(errors.some((e) => e.field === "postPromptTemplate")).toBe(true);
  });

  it("accepts both prePromptTemplate and postPromptTemplate together", () => {
    const { config, errors } = validateConfig({
      prePromptTemplate: "You are headless.",
      postPromptTemplate: "Open a draft PR when done.",
    });
    expect(errors).toHaveLength(0);
    expect(config.prePromptTemplate).toBe("You are headless.");
    expect(config.postPromptTemplate).toBe("Open a draft PR when done.");
  });
});

describe("resolvePath", () => {
  it("expands ~ to home directory", () => {
    const result = resolvePath("~/.local/dotlogs/conductor.log");
    expect(result).toBe(join(homedir(), ".local/dotlogs/conductor.log"));
  });

  it("leaves absolute paths unchanged", () => {
    const result = resolvePath("/absolute/path");
    expect(result).toBe("/absolute/path");
  });

  it("leaves relative paths unchanged", () => {
    const result = resolvePath("relative/path");
    expect(result).toBe("relative/path");
  });
});

describe("loadConfig", () => {
  it("returns defaults when no config file exists", () => {
    const config = loadConfig("/nonexistent/path/conductor.config.json");
    expect(config).toEqual(CONFIG_DEFAULTS);
  });

  it("loads and merges a valid config file", () => {
    const dir = join(tmpdir(), `conductor-test-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, "conductor.config.json");
    writeFileSync(configPath, JSON.stringify({ idleTimeoutMs: 12345 }));

    try {
      const config = loadConfig(configPath);
      expect(config.idleTimeoutMs).toBe(12345);
      expect(config.concurrency.global).toBe(10);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("throws with field-level errors for invalid config", () => {
    const dir = join(tmpdir(), `conductor-test-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, "conductor.config.json");
    writeFileSync(configPath, JSON.stringify({ idleTimeoutMs: "bad" }));

    try {
      expect(() => loadConfig(configPath)).toThrow(/idleTimeoutMs/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("throws on malformed JSON", () => {
    const dir = join(tmpdir(), `conductor-test-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, "conductor.config.json");
    writeFileSync(configPath, "{ not valid json }");

    try {
      expect(() => loadConfig(configPath)).toThrow(/Failed to parse/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
