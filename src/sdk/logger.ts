import {
  appendFileSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  plugin: string;
  msg: string;
  data?: Record<string, unknown>;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "\x1b[36m",
  info: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
};
const RESET = "\x1b[0m";

export function createLogger(opts: {
  pluginName: string;
  logPath: string;
  logMaxBytes: number;
  logMaxBackups: number;
}): Logger {
  const { pluginName, logPath, logMaxBytes, logMaxBackups } = opts;
  mkdirSync(dirname(logPath), { recursive: true });

  // Track current log file size in memory to avoid a stat() on every write.
  let size = 0;
  try {
    size = statSync(logPath).size;
  } catch {
    // File doesn't exist yet — size stays 0.
  }

  function rotate(): void {
    // Delete oldest backup to make room.
    try {
      unlinkSync(`${logPath}.${logMaxBackups}`);
    } catch {
      // Doesn't exist — fine.
    }
    // Shift .{N-1} → .{N} from oldest to newest (descending index).
    for (let i = logMaxBackups - 1; i >= 1; i--) {
      try {
        renameSync(`${logPath}.${i}`, `${logPath}.${i + 1}`);
      } catch {
        // Source may not exist — skip.
      }
    }
    // Rotate current log to .1.
    try {
      renameSync(logPath, `${logPath}.1`);
    } catch {
      // Log file may not exist yet — fine.
    }
    size = 0;
  }

  function write(
    level: LogLevel,
    msg: string,
    data?: Record<string, unknown>,
  ): void {
    const ts = new Date().toISOString();
    const entry: LogEntry = { ts, level, plugin: pluginName, msg };
    if (data && Object.keys(data).length > 0) entry.data = data;
    const line = `${JSON.stringify(entry)}\n`;

    if (size + line.length > logMaxBytes) rotate();

    try {
      appendFileSync(logPath, line, "utf-8");
      size += line.length;
    } catch {
      // Best-effort — don't throw from a logger.
    }

    // Emit to stderr for info and above.
    if (level === "debug") return;

    if (process.stderr.isTTY) {
      const color = LEVEL_COLOR[level];
      const label = LEVEL_LABEL[level];
      const dataStr =
        data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : "";
      process.stderr.write(
        `${ts} ${color}[${label}]${RESET} ${pluginName}: ${msg}${dataStr}\n`,
      );
    } else {
      process.stderr.write(line);
    }
  }

  return {
    debug: (msg, data) => write("debug", msg, data),
    info: (msg, data) => write("info", msg, data),
    warn: (msg, data) => write("warn", msg, data),
    error: (msg, data) => write("error", msg, data),
  };
}
