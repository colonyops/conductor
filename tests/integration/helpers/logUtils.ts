export interface LogEntry {
  ts: string;
  level: string;
  plugin: string;
  msg: string;
  data?: Record<string, unknown>;
}

export function parseLog(content: string): LogEntry[] {
  return content
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LogEntry];
      } catch {
        return [];
      }
    });
}

export async function pollLog(
  logPath: string,
  predicate: (entry: LogEntry) => boolean,
  timeoutMs: number,
): Promise<LogEntry> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = await Bun.file(logPath)
      .text()
      .catch(() => "");
    const match = parseLog(content).find(predicate);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for log entry`);
}

export function byMsg(msg: string): (e: LogEntry) => boolean {
  return (e) => e.msg === msg;
}

export function byMsgData(msg: string, data: Record<string, unknown>): (e: LogEntry) => boolean {
  return (e) => {
    if (e.msg !== msg) return false;
    return Object.entries(data).every(([k, v]) => e.data?.[k] === v);
  };
}
