#!/usr/bin/env bun
import { Command } from "commander";
import { loadConfig } from "./config.js";

const program = new Command("conductor")
  .description("Poll-driven session orchestrator for hive")
  .version("0.1.0");

program
  .command("start")
  .description("Start the conductor daemon")
  .option("-c, --config <path>", "Path to conductor.config.json")
  .option("--foreground", "Run in foreground (daemonize is v2)")
  .action(async (opts: { config?: string; foreground?: boolean }) => {
    try {
      const config = loadConfig(opts.config);
      console.log("Conductor starting...");
      console.log(`Idle timeout: ${config.idleTimeoutMs}ms`);
      console.log(`Concurrency: ${config.concurrency.global}`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  });

program
  .command("stop")
  .description("Send shutdown signal to running conductor daemon")
  .action(async () => {
    console.log("Stop not implemented (daemon loop is Phase 2)");
  });

program
  .command("signal <event>")
  .description(
    "Write a lifecycle signal for a session (called by Claude Code hooks)",
  )
  .requiredOption("--session <id>", "Session ID")
  .action(async (event: string, opts: { session: string }) => {
    const valid = ["activity", "stop", "stop:approval"];
    if (!valid.includes(event)) {
      console.error(`Unknown event "${event}". Valid: ${valid.join(", ")}`);
      process.exit(1);
    }
    console.log(`Signal written: ${event} for session ${opts.session}`);
  });

program
  .command("status")
  .description("Show running sessions and daemon status")
  .action(async () => {
    console.log("Status not implemented (daemon loop is Phase 2)");
  });

program.parseAsync(process.argv);
