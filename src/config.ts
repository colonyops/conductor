import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mergeWithDefaults } from "./merge.js";
import type { LogFormat } from "./sdk/logger.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PluginEntry {
  path: string;
  enabled: boolean;
  idleTimeoutMs?: number;
  concurrencyLimit?: number;
  /**
   * Opaque per-plugin configuration, passed through to the plugin as
   * `ctx.config`. Conductor does not interpret it — shape and validation are
   * the plugin's responsibility.
   */
  config?: unknown;
}

export interface GitHubIssuesBuiltinConfig {
  tokenSecretKey: string;
  tokenSource: "secret" | "gh-cli";
  repo: string;
  labels: string[];
  pollIntervalMs: number;
  assignee?: string;
  inProgressLabel?: string;
  doneLabel?: string;
  maxOpenSessions?: number;
}

export interface ConductorConfig {
  plugins: PluginEntry[];
  trustedPlugins: Record<string, string>;
  concurrency: { global: number };
  observability: {
    metricsPort: number;
    logPath: string;
    logMaxBytes: number;
    logMaxBackups: number;
    logFormat: LogFormat;
    logCaller: boolean;
    /** Interval between periodic session-inventory log lines + age-gauge refresh. */
    sessionInventoryIntervalMs: number;
    /** A session wedged in CREATED this long without its first signal is warned about. */
    signalStallWarnMs: number;
  };
  idleTimeoutMs: number;
  prePromptTemplate?: string;
  postPromptTemplate?: string;
  builtins: {
    "github-issues"?: GitHubIssuesBuiltinConfig;
  };
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export const CONFIG_DEFAULTS: ConductorConfig = {
  plugins: [],
  trustedPlugins: {},
  concurrency: { global: 10 },
  observability: {
    metricsPort: 9090,
    logPath: "~/.local/dotlogs/conductor.log",
    logMaxBytes: 10_485_760,
    logMaxBackups: 5,
    logFormat: "json" as LogFormat,
    logCaller: false,
    sessionInventoryIntervalMs: 120_000,
    signalStallWarnMs: 300_000,
  },
  idleTimeoutMs: 600_000,
  builtins: {},
};

// ── Validation ────────────────────────────────────────────────────────────────

export interface ConfigError {
  field: string;
  message: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const GITHUB_ISSUES_DEFAULTS: GitHubIssuesBuiltinConfig = {
  tokenSecretKey: "github.token",
  tokenSource: "secret",
  repo: "",
  labels: [],
  pollIntervalMs: 300_000,
};

function buildBuiltins(raw: Partial<ConductorConfig>["builtins"]): ConductorConfig["builtins"] {
  if (!raw?.["github-issues"]) return raw ?? {};
  return {
    ...raw,
    "github-issues": mergeWithDefaults(
      GITHUB_ISSUES_DEFAULTS,
      raw["github-issues"] as Partial<GitHubIssuesBuiltinConfig>,
    ),
  };
}

function validatePluginEntry(raw: unknown, prefix: string): ConfigError[] {
  const errors: ConfigError[] = [];
  if (!isObject(raw)) {
    return [{ field: prefix, message: "must be an object" }];
  }
  if (typeof raw.path !== "string") {
    errors.push({ field: `${prefix}.path`, message: "must be a string" });
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    errors.push({ field: `${prefix}.enabled`, message: "must be a boolean" });
  }
  if (raw.idleTimeoutMs !== undefined && (typeof raw.idleTimeoutMs !== "number" || raw.idleTimeoutMs <= 0)) {
    errors.push({
      field: `${prefix}.idleTimeoutMs`,
      message: "must be a positive number",
    });
  }
  if (raw.concurrencyLimit !== undefined && (typeof raw.concurrencyLimit !== "number" || raw.concurrencyLimit <= 0)) {
    errors.push({
      field: `${prefix}.concurrencyLimit`,
      message: "must be a positive number",
    });
  }
  return errors;
}

function validateGitHubIssuesBuiltin(raw: unknown): ConfigError[] {
  const errors: ConfigError[] = [];
  const p = 'builtins["github-issues"]';
  if (!isObject(raw)) {
    return [{ field: p, message: "must be an object" }];
  }
  if (raw.tokenSecretKey !== undefined && typeof raw.tokenSecretKey !== "string") {
    errors.push({ field: `${p}.tokenSecretKey`, message: "must be a string" });
  }
  if (typeof raw.repo !== "string" || !raw.repo.includes("/")) {
    errors.push({
      field: `${p}.repo`,
      message: 'must be a string in "owner/repo" format',
    });
  }
  if (!Array.isArray(raw.labels) || raw.labels.length === 0) {
    errors.push({
      field: `${p}.labels`,
      message: "must be a non-empty array of strings",
    });
  } else {
    for (const l of raw.labels as unknown[]) {
      if (typeof l !== "string") {
        errors.push({
          field: `${p}.labels`,
          message: "all entries must be strings",
        });
        break;
      }
    }
  }
  if (raw.pollIntervalMs !== undefined && (typeof raw.pollIntervalMs !== "number" || raw.pollIntervalMs <= 0)) {
    errors.push({
      field: `${p}.pollIntervalMs`,
      message: "must be a positive number",
    });
  }
  if (raw.tokenSource !== undefined && raw.tokenSource !== "secret" && raw.tokenSource !== "gh-cli") {
    errors.push({
      field: `${p}.tokenSource`,
      message: 'must be "secret" or "gh-cli"',
    });
  }
  if (raw.assignee !== undefined && typeof raw.assignee !== "string") {
    errors.push({ field: `${p}.assignee`, message: "must be a string" });
  }
  if (raw.maxOpenSessions !== undefined && (typeof raw.maxOpenSessions !== "number" || raw.maxOpenSessions <= 0)) {
    errors.push({
      field: `${p}.maxOpenSessions`,
      message: "must be a positive number",
    });
  }
  return errors;
}

export function validateConfig(raw: unknown): {
  config: ConductorConfig;
  errors: ConfigError[];
} {
  const errors: ConfigError[] = [];

  if (!isObject(raw)) {
    return {
      config: CONFIG_DEFAULTS,
      errors: [{ field: "(root)", message: "config must be a JSON object" }],
    };
  }

  if (raw.plugins !== undefined) {
    if (!Array.isArray(raw.plugins)) {
      errors.push({ field: "plugins", message: "must be an array" });
    } else {
      for (let i = 0; i < raw.plugins.length; i++) {
        errors.push(...validatePluginEntry(raw.plugins[i], `plugins[${i}]`));
      }
    }
  }

  if (raw.trustedPlugins !== undefined) {
    if (!isObject(raw.trustedPlugins)) {
      errors.push({ field: "trustedPlugins", message: "must be an object" });
    } else {
      for (const [k, v] of Object.entries(raw.trustedPlugins)) {
        if (typeof v !== "string") {
          errors.push({
            field: `trustedPlugins.${k}`,
            message: "value must be a string",
          });
        }
      }
    }
  }

  if (raw.concurrency !== undefined) {
    if (!isObject(raw.concurrency)) {
      errors.push({ field: "concurrency", message: "must be an object" });
    } else {
      if (
        raw.concurrency.global !== undefined &&
        (typeof raw.concurrency.global !== "number" || raw.concurrency.global <= 0)
      ) {
        errors.push({
          field: "concurrency.global",
          message: "must be a positive number",
        });
      }
    }
  }

  if (raw.observability !== undefined) {
    if (!isObject(raw.observability)) {
      errors.push({ field: "observability", message: "must be an object" });
    } else {
      const obs = raw.observability;
      if (
        obs.metricsPort !== undefined &&
        (typeof obs.metricsPort !== "number" || obs.metricsPort <= 0 || obs.metricsPort > 65535)
      ) {
        errors.push({
          field: "observability.metricsPort",
          message: "must be a number between 1 and 65535",
        });
      }
      if (obs.logPath !== undefined && typeof obs.logPath !== "string") {
        errors.push({
          field: "observability.logPath",
          message: "must be a string",
        });
      }
      if (obs.logMaxBytes !== undefined && (typeof obs.logMaxBytes !== "number" || obs.logMaxBytes <= 0)) {
        errors.push({
          field: "observability.logMaxBytes",
          message: "must be a positive number",
        });
      }
      if (obs.logMaxBackups !== undefined && (typeof obs.logMaxBackups !== "number" || obs.logMaxBackups < 0)) {
        errors.push({
          field: "observability.logMaxBackups",
          message: "must be a non-negative number",
        });
      }
      if (obs.logFormat !== undefined && obs.logFormat !== "json" && obs.logFormat !== "logfmt") {
        errors.push({
          field: "observability.logFormat",
          message: 'must be "json" or "logfmt"',
        });
      }
      if (obs.logCaller !== undefined && typeof obs.logCaller !== "boolean") {
        errors.push({
          field: "observability.logCaller",
          message: "must be a boolean",
        });
      }
      if (
        obs.sessionInventoryIntervalMs !== undefined &&
        (typeof obs.sessionInventoryIntervalMs !== "number" || obs.sessionInventoryIntervalMs <= 0)
      ) {
        errors.push({
          field: "observability.sessionInventoryIntervalMs",
          message: "must be a positive number",
        });
      }
      if (
        obs.signalStallWarnMs !== undefined &&
        (typeof obs.signalStallWarnMs !== "number" || obs.signalStallWarnMs <= 0)
      ) {
        errors.push({
          field: "observability.signalStallWarnMs",
          message: "must be a positive number",
        });
      }
    }
  }

  if (raw.idleTimeoutMs !== undefined && (typeof raw.idleTimeoutMs !== "number" || raw.idleTimeoutMs <= 0)) {
    errors.push({
      field: "idleTimeoutMs",
      message: "must be a positive number",
    });
  }

  if (raw.prePromptTemplate !== undefined && typeof raw.prePromptTemplate !== "string") {
    errors.push({ field: "prePromptTemplate", message: "must be a string" });
  }

  if (raw.postPromptTemplate !== undefined && typeof raw.postPromptTemplate !== "string") {
    errors.push({ field: "postPromptTemplate", message: "must be a string" });
  }

  if (raw.builtins !== undefined) {
    if (!isObject(raw.builtins)) {
      errors.push({ field: "builtins", message: "must be an object" });
    } else if (raw.builtins["github-issues"] !== undefined) {
      errors.push(...validateGitHubIssuesBuiltin(raw.builtins["github-issues"]));
    }
  }

  // A field "has an error" if it, or anything nested beneath it, failed
  // validation. Errored fields fall back to defaults; everything else keeps the
  // user's value so a single bad field never discards the whole config.
  const hasError = (prefix: string): boolean =>
    errors.some((e) => e.field === prefix || e.field.startsWith(`${prefix}.`) || e.field.startsWith(`${prefix}[`));

  // mergeWithDefaults over the user's section, but drop any per-key that errored
  // so valid siblings survive (e.g. a bad observability.logFormat keeps logPath).
  function mergeValidKeys<T extends object>(defaults: T, raw: unknown, prefix: string): T {
    if (!isObject(raw)) return { ...defaults };
    const overrides: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!hasError(`${prefix}.${k}`)) overrides[k] = v;
    }
    return mergeWithDefaults(defaults, overrides as Partial<T>);
  }

  const rawObj = raw as Partial<ConductorConfig>;

  const config: ConductorConfig = {
    plugins: hasError("plugins")
      ? CONFIG_DEFAULTS.plugins
      : (rawObj.plugins ?? CONFIG_DEFAULTS.plugins).map((p) => ({
          path: p.path,
          enabled: p.enabled ?? true,
          ...(p.idleTimeoutMs !== undefined ? { idleTimeoutMs: p.idleTimeoutMs } : {}),
          ...(p.concurrencyLimit !== undefined ? { concurrencyLimit: p.concurrencyLimit } : {}),
          ...(p.config !== undefined ? { config: p.config } : {}),
        })),
    trustedPlugins: hasError("trustedPlugins")
      ? CONFIG_DEFAULTS.trustedPlugins
      : (rawObj.trustedPlugins ?? CONFIG_DEFAULTS.trustedPlugins),
    concurrency: mergeValidKeys(CONFIG_DEFAULTS.concurrency, rawObj.concurrency, "concurrency"),
    observability: mergeValidKeys(CONFIG_DEFAULTS.observability, rawObj.observability, "observability"),
    idleTimeoutMs: hasError("idleTimeoutMs")
      ? CONFIG_DEFAULTS.idleTimeoutMs
      : (rawObj.idleTimeoutMs ?? CONFIG_DEFAULTS.idleTimeoutMs),
    builtins: hasError("builtins") ? CONFIG_DEFAULTS.builtins : buildBuiltins(rawObj.builtins),
    ...(rawObj.prePromptTemplate !== undefined && !hasError("prePromptTemplate")
      ? { prePromptTemplate: rawObj.prePromptTemplate }
      : {}),
    ...(rawObj.postPromptTemplate !== undefined && !hasError("postPromptTemplate")
      ? { postPromptTemplate: rawObj.postPromptTemplate }
      : {}),
  };

  return { config, errors };
}

// ── I/O ───────────────────────────────────────────────────────────────────────

const SEARCH_PATHS = [".conductor/conductor.config.json", "conductor.config.json"];

export function loadConfig(configPath?: string): ConductorConfig {
  let filePath: string;
  if (configPath) {
    filePath = resolve(configPath);
  } else {
    const found = SEARCH_PATHS.find((p) => {
      try {
        readFileSync(p);
        return true;
      } catch {
        return false;
      }
    });
    if (!found) {
      return { ...CONFIG_DEFAULTS };
    }
    filePath = resolve(found);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (e) {
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...CONFIG_DEFAULTS };
    }
    throw new Error(`Failed to parse config at ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const { config, errors } = validateConfig(raw);
  if (errors.length > 0) {
    const lines = errors.map((e) => `  ${e.field}: ${e.message}`).join("\n");
    throw new Error(`Config validation failed:\n${lines}`);
  }
  return config;
}

export async function writeConfig(config: ConductorConfig, configPath: string): Promise<void> {
  const absPath = resolve(configPath);
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${absPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  renameSync(tmp, absPath);
}

export function resolvePath(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export function resolveConfigPath(configPath?: string): string {
  if (configPath) return resolve(configPath);
  for (const p of SEARCH_PATHS) {
    try {
      readFileSync(p);
      return resolve(p);
    } catch {
      // not found, try next
    }
  }
  return resolve("conductor.config.json");
}
