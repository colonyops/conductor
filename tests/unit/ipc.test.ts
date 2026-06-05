import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set the override env var BEFORE importing ipc.ts so CONDUCTOR_DATA_DIR
// is resolved to our temp dir when the module initializes.
const TEST_DATA_DIR = join(tmpdir(), `conductor-ipc-test-${process.pid}`);
process.env.CONDUCTOR_DATA_DIR_TEST_OVERRIDE = TEST_DATA_DIR;

const { writeIpcEvent, drainEventFiles, sessionEventsDir, watchIpcEvents } = await import("../../src/core/ipc.js");

afterAll(() => {
  process.env.CONDUCTOR_DATA_DIR_TEST_OVERRIDE = undefined;
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("sessionEventsDir", () => {
  it("returns path under data dir", () => {
    const dir = sessionEventsDir("abc123");
    expect(dir).toContain("abc123");
    expect(dir).toContain("events");
    expect(dir).toContain(TEST_DATA_DIR);
  });
});

describe("writeIpcEvent", () => {
  beforeEach(() => {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  it("creates a .json file in the events dir", async () => {
    await writeIpcEvent("sess-1", "activity");
    const eventsDir = sessionEventsDir("sess-1");
    const files = readdirSync(eventsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.json$/);
  });

  it("written file has correct IpcEvent structure", async () => {
    await writeIpcEvent("sess-2", "stop");
    const eventsDir = sessionEventsDir("sess-2");
    const [filename] = readdirSync(eventsDir);
    if (!filename) throw new Error("no file written");
    const content = JSON.parse(await Bun.file(join(eventsDir, filename)).text());
    expect(content).toMatchObject({
      signal: "stop",
      sessionId: "sess-2",
    });
    expect(typeof content.timestamp).toBe("string");
  });

  it("sanitizes colon in stop:approval signal name", async () => {
    await writeIpcEvent("sess-3", "stop:approval");
    const eventsDir = sessionEventsDir("sess-3");
    const [filename] = readdirSync(eventsDir);
    expect(filename).not.toContain(":");
  });
});

describe("drainEventFiles", () => {
  beforeEach(() => {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  it("returns empty array when events dir does not exist", async () => {
    const events = await drainEventFiles("nonexistent");
    expect(events).toEqual([]);
  });

  it("returns events sorted by timestamp prefix", async () => {
    const eventsDir = sessionEventsDir("sess-sort");
    mkdirSync(eventsDir, { recursive: true });
    const event1 = {
      signal: "activity",
      sessionId: "sess-sort",
      timestamp: "2026-01-01T00:00:01Z",
    };
    const event2 = {
      signal: "stop",
      sessionId: "sess-sort",
      timestamp: "2026-01-01T00:00:02Z",
    };
    await Bun.write(join(eventsDir, "1000-activity.json"), JSON.stringify(event1));
    await Bun.write(join(eventsDir, "2000-stop.json"), JSON.stringify(event2));

    const drained = await drainEventFiles("sess-sort");
    expect(drained).toHaveLength(2);
    expect(drained[0]?.signal).toBe("activity");
    expect(drained[1]?.signal).toBe("stop");
  });

  it("marks each file .processed after reading", async () => {
    await writeIpcEvent("sess-drain", "activity");
    await drainEventFiles("sess-drain");
    const eventsDir = sessionEventsDir("sess-drain");
    const files = readdirSync(eventsDir);
    expect(files.every((f) => f.endsWith(".processed"))).toBe(true);
  });

  it("skips .processed files on a second drain (restart recovery)", async () => {
    await writeIpcEvent("sess-recovery", "activity");
    const first = await drainEventFiles("sess-recovery");
    expect(first).toHaveLength(1);
    const second = await drainEventFiles("sess-recovery");
    expect(second).toHaveLength(0);
  });

  it("does not skip a new unprocessed file written after the first drain", async () => {
    await writeIpcEvent("sess-new", "activity");
    await drainEventFiles("sess-new");
    await writeIpcEvent("sess-new", "stop");
    const second = await drainEventFiles("sess-new");
    expect(second).toHaveLength(1);
    expect(second[0]?.signal).toBe("stop");
  });
});

describe("watchIpcEvents", () => {
  beforeAll(() => {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  it("calls handler when a signal file is written", async () => {
    const received: string[] = [];
    const { stop } = watchIpcEvents(async (event) => {
      received.push(event.signal);
    });

    try {
      // Pre-create the events dir while the watcher initializes.
      // In production, createSession() creates this dir before any signals arrive.
      // On macOS, FSEvents needs the directory to exist before the watcher starts
      // watching it, otherwise file-creation events inside new subdirs are not reported.
      await new Promise((r) => setTimeout(r, 200));
      mkdirSync(sessionEventsDir("sess-watch"), { recursive: true });

      // Wait for the watcher to register the new subdirectory, then write
      await new Promise((r) => setTimeout(r, 500));
      await writeIpcEvent("sess-watch", "activity");

      // Poll until the handler fires (up to 5 seconds)
      const deadline = Date.now() + 5_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(received).toContain("activity");
    } finally {
      stop();
    }
  }, 15_000);
});
