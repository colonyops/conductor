import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../src/sdk/logger.js";

const TMP = join(tmpdir(), `conductor-logger-test-${process.pid}`);

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function readLines(logPath: string): string[] {
  try {
    return readFileSync(logPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "");
  } catch {
    return [];
  }
}

describe("createLogger — json format", () => {
  it("writes json lines to the log file", () => {
    const logPath = join(TMP, "app.log");
    const logger = createLogger({
      component: "test",
      logPath,
      logMaxBytes: 1_000_000,
      logMaxBackups: 3,
      format: "json",
    });

    logger.info("hello", { key: "value" });

    const lines = readLines(logPath);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "{}");
    expect(entry.level).toBe("info");
    expect(entry.component).toBe("test");
    expect(entry.msg).toBe("hello");
    expect(entry.key).toBe("value");
    expect(typeof entry.ts).toBe("string");
  });

  it("flattens data into the top-level entry", () => {
    const logPath = join(TMP, "app.log");
    const logger = createLogger({
      component: "test",
      logPath,
      logMaxBytes: 1_000_000,
      logMaxBackups: 3,
    });

    logger.warn("flat", { a: 1, b: "two" });

    const entry = JSON.parse(readLines(logPath)[0] ?? "{}");
    expect(entry.a).toBe(1);
    expect(entry.b).toBe("two");
    expect(entry.data).toBeUndefined();
  });

  it("writes all four log levels", () => {
    const logPath = join(TMP, "app.log");
    const logger = createLogger({
      component: "test",
      logPath,
      logMaxBytes: 1_000_000,
      logMaxBackups: 3,
    });

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    const lines = readLines(logPath);
    expect(lines).toHaveLength(4);
    const levels = lines.map((l) => JSON.parse(l).level);
    expect(levels).toEqual(["debug", "info", "warn", "error"]);
  });
});

describe("createLogger — logfmt format", () => {
  it("writes logfmt lines to the log file", () => {
    const logPath = join(TMP, "app.log");
    const logger = createLogger({
      component: "svc",
      logPath,
      logMaxBytes: 1_000_000,
      logMaxBackups: 3,
      format: "logfmt",
    });

    logger.info("started", { port: 8080 });

    const lines = readLines(logPath);
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? "";
    expect(line).toMatch(/^ts=/);
    expect(line).toContain("level=info");
    expect(line).toContain("component=svc");
    expect(line).toContain("msg=started");
    expect(line).toContain("port=8080");
  });

  it("quotes values containing spaces", () => {
    const logPath = join(TMP, "app.log");
    const logger = createLogger({
      component: "svc",
      logPath,
      logMaxBytes: 1_000_000,
      logMaxBackups: 3,
      format: "logfmt",
    });

    logger.info("msg with spaces", { reason: "a b c" });

    const line = readLines(logPath)[0] ?? "";
    expect(line).toContain('msg="msg with spaces"');
    expect(line).toContain('reason="a b c"');
  });

  it("emits ordered fields: ts level component msg before extras", () => {
    const logPath = join(TMP, "app.log");
    const logger = createLogger({
      component: "svc",
      logPath,
      logMaxBytes: 1_000_000,
      logMaxBackups: 3,
      format: "logfmt",
    });

    logger.info("ok", { z: 1 });

    const line = readLines(logPath)[0] ?? "";
    const tsIdx = line.indexOf("ts=");
    const levelIdx = line.indexOf("level=");
    const compIdx = line.indexOf("component=");
    const msgIdx = line.indexOf("msg=");
    const zIdx = line.indexOf("z=");
    expect(tsIdx).toBeLessThan(levelIdx);
    expect(levelIdx).toBeLessThan(compIdx);
    expect(compIdx).toBeLessThan(msgIdx);
    expect(msgIdx).toBeLessThan(zIdx);
  });
});

describe("Logger.with()", () => {
  it("child logger includes base fields on every entry", () => {
    const logPath = join(TMP, "app.log");
    const root = createLogger({
      component: "root",
      logPath,
      logMaxBytes: 1_000_000,
      logMaxBackups: 3,
    });

    const child = root.with({ component: "child", requestId: "abc" });
    child.info("handling request");

    const entry = JSON.parse(readLines(logPath)[0] ?? "{}");
    expect(entry.component).toBe("child");
    expect(entry.requestId).toBe("abc");
    expect(entry.msg).toBe("handling request");
  });

  it("root and child share the same file sink", () => {
    const logPath = join(TMP, "app.log");
    const root = createLogger({
      component: "root",
      logPath,
      logMaxBytes: 1_000_000,
      logMaxBackups: 3,
    });
    const child = root.with({ component: "child" });

    root.info("from root");
    child.info("from child");

    const lines = readLines(logPath);
    expect(lines).toHaveLength(2);
  });

  it("child fields do not bleed into parent", () => {
    const logPath = join(TMP, "app.log");
    const root = createLogger({
      component: "root",
      logPath,
      logMaxBytes: 1_000_000,
      logMaxBackups: 3,
    });
    const child = root.with({ extra: "yes" });

    root.info("root msg");
    child.info("child msg");

    const lines = readLines(logPath);
    const rootEntry = JSON.parse(lines[0] ?? "{}");
    const childEntry = JSON.parse(lines[1] ?? "{}");
    expect(rootEntry.extra).toBeUndefined();
    expect(childEntry.extra).toBe("yes");
  });

  it("per-call data overrides with() fields", () => {
    const logPath = join(TMP, "app.log");
    const root = createLogger({
      component: "root",
      logPath,
      logMaxBytes: 1_000_000,
      logMaxBackups: 3,
    });
    const child = root.with({ status: "pending" });
    child.info("done", { status: "ok" });

    const entry = JSON.parse(readLines(logPath)[0] ?? "{}");
    expect(entry.status).toBe("ok");
  });
});

describe("caller location", () => {
  it("includes caller field when enabled", () => {
    const logPath = join(TMP, "app.log");
    const logger = createLogger({
      component: "test",
      logPath,
      logMaxBytes: 1_000_000,
      logMaxBackups: 3,
      caller: true,
    });

    logger.info("test caller");

    const entry = JSON.parse(readLines(logPath)[0] ?? "{}");
    expect(typeof entry.caller).toBe("string");
    expect(entry.caller).toMatch(/:\d+$/);
    expect(entry.caller).not.toContain("sdk/logger");
  });

  it("omits caller field when disabled", () => {
    const logPath = join(TMP, "app.log");
    const logger = createLogger({
      component: "test",
      logPath,
      logMaxBytes: 1_000_000,
      logMaxBackups: 3,
      caller: false,
    });

    logger.info("no caller");

    const entry = JSON.parse(readLines(logPath)[0] ?? "{}");
    expect(entry.caller).toBeUndefined();
  });
});

describe("log rotation", () => {
  it("rotates when size exceeds logMaxBytes", () => {
    const logPath = join(TMP, "app.log");
    const logger = createLogger({
      component: "test",
      logPath,
      logMaxBytes: 200,
      logMaxBackups: 2,
    });

    // Write enough entries to trigger rotation.
    for (let i = 0; i < 10; i++) {
      logger.info(`message ${i}`, { index: i });
    }

    expect(existsSync(`${logPath}.1`)).toBe(true);
  });

  it("does not create backups beyond logMaxBackups", () => {
    const logPath = join(TMP, "app.log");
    const logger = createLogger({
      component: "test",
      logPath,
      logMaxBytes: 10,
      logMaxBackups: 2,
    });

    // Write enough entries to trigger many rotations.
    for (let i = 0; i < 8; i++) {
      logger.info(`message ${i}`);
    }

    expect(existsSync(`${logPath}.3`)).toBe(false);
  });
});
