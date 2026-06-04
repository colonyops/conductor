#!/usr/bin/env bun
import { Command } from "commander";
import { loadConfig, resolvePath } from "./config.js";
import { EventBus } from "./core/events.js";
import {
  CONDUCTOR_DATA_DIR,
  isApprovalSignal,
  watchIpcEvents,
  writeIpcEvent,
} from "./core/ipc.js";
import { SessionManager } from "./core/session.js";
import { createConcurrencyLimiter } from "./sdk/concurrency.js";
import { createLogger } from "./sdk/logger.js";
import type { IpcSignal, SessionEvent } from "./types.js";

const program = new Command("conductor")
  .description("Poll-driven session orchestrator for hive")
  .version("0.1.0");

program
  .command("start")
  .description("Start the conductor daemon")
  .option("-c, --config <path>", "Path to conductor.config.json")
  .option("--foreground", "Run in foreground (daemonize is v2)")
  .action(async (opts: { config?: string }) => {
    try {
      const config = loadConfig(opts.config);
      const logger = createLogger({
        pluginName: "conductor",
        logPath: resolvePath(config.observability.logPath),
        logMaxBytes: config.observability.logMaxBytes,
        logMaxBackups: config.observability.logMaxBackups,
      });
      const eventBus = new EventBus();
      const globalLimiter = createConcurrencyLimiter(config.concurrency.global);
      const sessionManager = new SessionManager({
        config,
        eventBus,
        globalLimiter,
      });

      const watcher = watchIpcEvents(async (ipcEvent) => {
        const isApproval = isApprovalSignal(ipcEvent.signal);
        const event: SessionEvent =
          ipcEvent.signal === "activity" ? "PostToolUse" : "Stop";
        await sessionManager.applyTransition(ipcEvent.sessionId, event, {
          isApprovalPending: isApproval,
        });
      });

      let shuttingDown = false;
      const handleSignal = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        process.exitCode = 0;
        shutdown(sessionManager, watcher, eventBus, logger)
          .catch((err) => {
            logger.error("Shutdown error", {
              error: err instanceof Error ? err.message : String(err),
            });
            process.exitCode = 1;
          })
          .finally(() => process.exit());
      };
      process.once("SIGTERM", handleSignal);
      process.once("SIGINT", handleSignal);

      await eventBus.emit("conductorStart", {});
      logger.info("Conductor started", {
        pluginCount: 0,
        dataDir: CONDUCTOR_DATA_DIR,
      });

      // Plugin loading is Phase 4; hold the process open
      await new Promise<never>(() => {});
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  });

async function shutdown(
  sessionManager: SessionManager,
  watcher: { stop(): void },
  eventBus: EventBus,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  await eventBus.emit("conductorStop", {});
  sessionManager.shutdown();
  watcher.stop();
  logger.info("Conductor stopped");
}

program
  .command("stop")
  .description("Send shutdown signal to running conductor daemon")
  .action(async () => {
    console.log("Stop not implemented (PID file is Phase 2 integration)");
  });

program
  .command("signal <event>")
  .description(
    "Write a lifecycle signal for a session (called by Claude Code hooks)",
  )
  .requiredOption("--session <id>", "Session ID")
  .action(async (event: string, opts: { session: string }) => {
    const valid: IpcSignal[] = ["activity", "stop", "stop:approval"];
    if (!valid.includes(event as IpcSignal)) {
      console.error(`Unknown event "${event}". Valid: ${valid.join(", ")}`);
      process.exit(1);
    }
    try {
      await writeIpcEvent(opts.session, event as IpcSignal);
      console.log(`Signal written: ${event} for session ${opts.session}`);
    } catch (e) {
      console.error(
        `Failed to write signal: ${e instanceof Error ? e.message : String(e)}`,
      );
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Show running sessions and daemon status")
  .action(async () => {
    console.log("Status not implemented (daemon loop is Phase 2)");
  });

program.parseAsync(process.argv);
