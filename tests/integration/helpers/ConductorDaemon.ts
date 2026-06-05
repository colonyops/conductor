import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestEnv } from "./TestEnv.js";

// Conductor source root — derived from this file's location:
// helpers/ → integration/ → tests/ → project-root/
const CONDUCTOR_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

export class ConductorDaemon {
  private proc?: ReturnType<typeof Bun.spawn>;
  private env?: TestEnv;

  async start(env: TestEnv): Promise<void> {
    this.env = env;
    this.proc = Bun.spawn(["bun", "src/index.ts", "start", "--config", env.configPath], {
      cwd: CONDUCTOR_ROOT,
      env: env.processEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  /** Poll the log file until "Conductor started" appears. */
  async waitForReady(timeoutMs = 20_000): Promise<void> {
    if (!this.env) throw new Error("start() must be called before waitForReady()");
    const { logPath } = this.env;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text = await Bun.file(logPath)
        .text()
        .catch(() => "");
      // Match the bare message so this works for both `json` (`"msg":"Conductor started"`)
      // and `logfmt` (`msg="Conductor started"` / `msg=Conductor started`) log formats.
      if (text.includes("Conductor started")) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Conductor did not start within ${timeoutMs}ms. Check log: ${logPath}`);
  }

  /** Send a lifecycle signal for a session. */
  async signal(type: "activity" | "stop" | "stop:approval", sessionId: string): Promise<void> {
    if (!this.env) throw new Error("start() must be called before signal()");
    const proc = Bun.spawn(["bun", "src/index.ts", "signal", type, "--session", sessionId], {
      cwd: CONDUCTOR_ROOT,
      env: this.env.processEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`conductor signal failed (${code}): ${err.trim()}`);
    }
  }

  /** Send SIGTERM and wait for the process to exit. */
  async stop(timeoutMs = 35_000): Promise<number> {
    if (!this.proc) return 0;
    this.proc.kill("SIGTERM");
    return Promise.race([
      this.proc.exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Conductor did not stop within ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  }

  /** Kill immediately without waiting for graceful shutdown. */
  kill(): void {
    this.proc?.kill("SIGKILL");
  }

  isRunning(): boolean {
    return !!this.proc && !this.proc.killed;
  }
}
