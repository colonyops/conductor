import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "json" | "logfmt";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
  caller?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  with(fields: Record<string, unknown>): Logger;
}

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "\x1b[36m",
  info: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const COLOR_KEY = "\x1b[36m"; // cyan

const LOGFMT_ORDERED = ["ts", "level", "component", "msg", "caller"];

function logfmtValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (s === "" || /[\s="\\]/.test(s)) return JSON.stringify(s);
  return s;
}

function formatLogfmt(entry: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of LOGFMT_ORDERED) {
    if (key in entry && entry[key] !== undefined) {
      parts.push(`${key}=${logfmtValue(entry[key])}`);
    }
  }
  for (const [key, val] of Object.entries(entry)) {
    if (LOGFMT_ORDERED.includes(key) || val === undefined) continue;
    parts.push(`${key}=${logfmtValue(val)}`);
  }
  return parts.join(" ");
}

function coloredValue(v: unknown): string {
  if (v === null || v === undefined) return `${DIM}null${RESET}`;
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s === "" || /[\s="\\]/.test(s) ? JSON.stringify(s) : s;
}

function formatLogfmtColored(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(data)) {
    if (val === undefined) continue;
    parts.push(`${COLOR_KEY}${key}${RESET}${DIM}=${RESET}${coloredValue(val)}`);
  }
  return parts.join(" ");
}

function getCaller(): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  for (const line of stack.split("\n").slice(1)) {
    if (line.includes("sdk/logger")) continue;
    const m = line.match(/\((.+?):(\d+):\d+\)$/) || line.match(/at (.+?):(\d+):\d+$/);
    if (!m) continue;
    const file = (m[1] ?? "").replace(/^file:\/\//, "");
    return `${file}:${m[2]}`;
  }
  return undefined;
}

interface LogSink {
  format: LogFormat;
  serialize(entry: Record<string, unknown>): string;
  writeToFile(entry: Record<string, unknown>): void;
}

function createLogSink(opts: {
  logPath: string;
  logMaxBytes: number;
  logMaxBackups: number;
  format: LogFormat;
}): LogSink {
  const { logPath, logMaxBytes, logMaxBackups, format } = opts;
  mkdirSync(dirname(logPath), { recursive: true });

  let size = 0;
  try {
    size = statSync(logPath).size;
  } catch {
    // File doesn't exist yet — size stays 0.
  }

  function rotate(): void {
    try {
      unlinkSync(`${logPath}.${logMaxBackups}`);
    } catch {
      // Doesn't exist — fine.
    }
    for (let i = logMaxBackups - 1; i >= 1; i--) {
      try {
        renameSync(`${logPath}.${i}`, `${logPath}.${i + 1}`);
      } catch {
        // Source may not exist — skip.
      }
    }
    try {
      renameSync(logPath, `${logPath}.1`);
    } catch {
      // Log file may not exist yet — fine.
    }
    size = 0;
  }

  function serialize(entry: Record<string, unknown>): string {
    return format === "json" ? JSON.stringify(entry) : formatLogfmt(entry);
  }

  return {
    format,
    serialize,
    writeToFile(entry: Record<string, unknown>): void {
      const line = `${serialize(entry)}\n`;
      if (size + line.length > logMaxBytes) rotate();
      try {
        appendFileSync(logPath, line, "utf-8");
        size += line.length;
      } catch {
        // Best-effort — don't throw from a logger.
      }
    },
  };
}

function buildLogger(sink: LogSink, baseFields: Record<string, unknown>, withCaller: boolean): Logger {
  function write(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    const ts = new Date().toISOString();
    const entry: Record<string, unknown> = {
      ts,
      level,
      ...baseFields,
      msg,
      ...(data ?? {}),
    };
    if (withCaller) {
      entry.caller = getCaller();
    }

    sink.writeToFile(entry);

    if (level === "debug") return;

    if (process.stderr.isTTY) {
      const color = LEVEL_COLOR[level];
      const label = LEVEL_LABEL[level];
      const component = String(baseFields.component ?? "");
      let dataStr = "";
      if (data && Object.keys(data).length > 0) {
        dataStr = sink.format === "logfmt" ? ` ${formatLogfmtColored(data)}` : ` ${JSON.stringify(data)}`;
      }
      const callerStr = withCaller && entry.caller ? ` ${DIM}(${entry.caller})${RESET}` : "";
      process.stderr.write(
        `${DIM}${ts}${RESET} ${color}[${label}]${RESET} ${BOLD}${component}${RESET}: ${msg}${dataStr}${callerStr}\n`,
      );
    } else {
      process.stderr.write(`${sink.serialize(entry)}\n`);
    }
  }

  return {
    debug: (msg, data) => write("debug", msg, data),
    info: (msg, data) => write("info", msg, data),
    warn: (msg, data) => write("warn", msg, data),
    error: (msg, data) => write("error", msg, data),
    with: (fields) => buildLogger(sink, { ...baseFields, ...fields }, withCaller),
  };
}

export function createLogger(opts: {
  component: string;
  logPath: string;
  logMaxBytes: number;
  logMaxBackups: number;
  format?: LogFormat;
  caller?: boolean;
}): Logger {
  const sink = createLogSink({
    logPath: opts.logPath,
    logMaxBytes: opts.logMaxBytes,
    logMaxBackups: opts.logMaxBackups,
    format: opts.format ?? "json",
  });
  return buildLogger(sink, { component: opts.component }, opts.caller ?? false);
}
