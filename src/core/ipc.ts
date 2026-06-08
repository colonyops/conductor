import { mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { watch } from "node:fs";
import { join } from "node:path";
import { resolvePath } from "../config.js";
import type { IpcEvent, IpcSignal } from "../types.js";

export function conductorDataDir(): string {
  return process.env.CONDUCTOR_DATA_DIR_TEST_OVERRIDE ?? resolvePath("~/.local/conductor");
}

export function sessionEventsDir(sessionId: string): string {
  return join(conductorDataDir(), "sessions", sessionId, "events");
}

export async function writeIpcEvent(sessionId: string, signal: IpcSignal): Promise<void> {
  const eventsDir = sessionEventsDir(sessionId);
  mkdirSync(eventsDir, { recursive: true });

  const event: IpcEvent = {
    signal,
    sessionId,
    timestamp: new Date().toISOString(),
  };

  // The ms prefix preserves lexicographic time-ordering in drainEventFiles.
  // The random suffix guarantees uniqueness: this runs in separate Claude Code
  // hook processes, so two calls within the same millisecond with the same
  // signal would otherwise collide and the second write would clobber the first.
  const ms = Date.now();
  const safeSignal = signal.replace(":", "-");
  const filename = `${ms}-${safeSignal}-${crypto.randomUUID()}.json`;
  await Bun.write(join(eventsDir, filename), JSON.stringify(event));
}

export async function drainEventFiles(sessionId: string): Promise<IpcEvent[]> {
  const eventsDir = sessionEventsDir(sessionId);

  let entries: string[];
  try {
    entries = readdirSync(eventsDir);
  } catch {
    return [];
  }

  // Only unprocessed .json files, sorted lexicographically (ms prefix → time order)
  const pending = entries.filter((f) => f.endsWith(".json")).sort();

  const events: IpcEvent[] = [];
  for (const filename of pending) {
    const fullPath = join(eventsDir, filename);
    try {
      const text = await Bun.file(fullPath).text();
      const parsed = JSON.parse(text) as IpcEvent;
      // Atomic rename to mark processed — second concurrent call will find the file gone
      renameSync(fullPath, `${fullPath}.processed`);
      events.push(parsed);
    } catch {
      // skip: malformed, missing, or already processed by a concurrent call
    }
  }

  return events;
}

export type IpcEventHandler = (event: IpcEvent) => Promise<void>;

export function watchIpcEvents(handler: IpcEventHandler): { stop(): void } {
  const sessionsDir = join(conductorDataDir(), "sessions");
  mkdirSync(sessionsDir, { recursive: true });

  // Debounce: one drain pass runs at a time across all sessions.
  // On macOS, fs.watch({ recursive }) may return only the leaf filename or a
  // full relative path depending on the runtime version, so we avoid path
  // parsing entirely and scan all session subdirectories instead.
  let draining = false;

  const watcher = watch(sessionsDir, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    if (!filename.endsWith(".json")) return;
    if (draining) return;
    draining = true;

    void (async () => {
      try {
        const entries = readdirSync(sessionsDir);
        for (const entry of entries) {
          try {
            if (!statSync(join(sessionsDir, entry)).isDirectory()) continue;
          } catch {
            continue;
          }
          const events = await drainEventFiles(entry);
          for (const event of events) {
            try {
              await handler(event);
            } catch {
              // handler errors don't kill the watcher
            }
          }
        }
      } catch {
        // ignore scan errors
      } finally {
        draining = false;
      }
    })();
  });

  return { stop: () => watcher.close() };
}

export function isApprovalSignal(signal: IpcSignal): boolean {
  return signal === "stop:approval";
}
