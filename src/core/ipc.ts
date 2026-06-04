import { watch } from "node:fs";
import { join } from "node:path";
import type { IpcEvent, IpcSignal } from "../types.js";

export async function writeIpcEvent(
  eventsDir: string,
  event: IpcEvent,
): Promise<void> {
  const filename = `${event.timestamp.replace(/[:.]/g, "-")}-${event.signal}.json`;
  const path = join(eventsDir, filename);
  await Bun.write(path, JSON.stringify(event));
}

export type IpcEventCallback = (event: IpcEvent) => void;

export function watchIpcEvents(
  eventsDir: string,
  callback: IpcEventCallback,
): () => void {
  const watcher = watch(eventsDir, (_eventType, filename) => {
    if (!filename?.endsWith(".json")) return;
    const fullPath = join(eventsDir, filename);
    Bun.file(fullPath)
      .text()
      .then((text) => {
        try {
          const parsed = JSON.parse(text) as IpcEvent;
          callback(parsed);
        } catch {
          // malformed event file — skip
        }
      })
      .catch(() => {
        // file may have been deleted before we read it
      });
  });

  return () => watcher.close();
}

export function isApprovalSignal(signal: IpcSignal): boolean {
  return signal === "stop:approval";
}
