import { Counter, Gauge, Histogram, Registry } from "prom-client";

export interface ConductorMetrics {
  sessionsTotal: Counter<"state" | "plugin_id">;
  sessionsActive: Gauge<"state">;
  pluginInitDuration: Histogram<"plugin_id">;
  pluginErrors: Counter<"plugin_id" | "type">;
  schedulerRuns: Counter<"plugin_id" | "job_type">;
  schedulerRunDuration: Histogram<"plugin_id" | "job_type">;
  ipcEventsTotal: Counter<"signal">;
  concurrencyActive: Gauge<"scope">;
  concurrencyWaiting: Gauge<"scope">;
  secretsResolutionTotal: Counter<"backend" | "result">;
}

export function createMetrics(): {
  registry: Registry;
  metrics: ConductorMetrics;
} {
  const registry = new Registry();

  const sessionsTotal = new Counter({
    name: "conductor_sessions_total",
    help: "Total sessions that have entered each state",
    labelNames: ["state", "plugin_id"] as const,
    registers: [registry],
  });

  const sessionsActive = new Gauge({
    name: "conductor_sessions_active",
    help: "Current session count by state",
    labelNames: ["state"] as const,
    registers: [registry],
  });

  const pluginInitDuration = new Histogram({
    name: "conductor_plugin_init_duration_ms",
    help: "Duration of plugin init() call in milliseconds",
    labelNames: ["plugin_id"] as const,
    buckets: [10, 50, 100, 500, 1000, 5000, 10000, 30000],
    registers: [registry],
  });

  const pluginErrors = new Counter({
    name: "conductor_plugin_errors_total",
    help: "Plugin errors by plugin and type",
    labelNames: ["plugin_id", "type"] as const,
    registers: [registry],
  });

  const schedulerRuns = new Counter({
    name: "conductor_scheduler_runs_total",
    help: "Scheduler job executions by plugin and job type",
    labelNames: ["plugin_id", "job_type"] as const,
    registers: [registry],
  });

  const schedulerRunDuration = new Histogram({
    name: "conductor_scheduler_run_duration_ms",
    help: "Scheduler job execution duration in milliseconds",
    labelNames: ["plugin_id", "job_type"] as const,
    buckets: [10, 50, 100, 500, 1000, 5000, 30000, 60000],
    registers: [registry],
  });

  const ipcEventsTotal = new Counter({
    name: "conductor_ipc_events_total",
    help: "IPC signals received",
    labelNames: ["signal"] as const,
    registers: [registry],
  });

  const concurrencyActive = new Gauge({
    name: "conductor_concurrency_active",
    help: "Active concurrency slots",
    labelNames: ["scope"] as const,
    registers: [registry],
  });

  const concurrencyWaiting = new Gauge({
    name: "conductor_concurrency_waiting",
    help: "Queued waiters for concurrency slots",
    labelNames: ["scope"] as const,
    registers: [registry],
  });

  const secretsResolutionTotal = new Counter({
    name: "conductor_secrets_resolution_total",
    help: "Secret resolution attempts by backend and result",
    labelNames: ["backend", "result"] as const,
    registers: [registry],
  });

  return {
    registry,
    metrics: {
      sessionsTotal,
      sessionsActive,
      pluginInitDuration,
      pluginErrors,
      schedulerRuns,
      schedulerRunDuration,
      ipcEventsTotal,
      concurrencyActive,
      concurrencyWaiting,
      secretsResolutionTotal,
    },
  };
}

export function startMetricsServer(
  port: number,
  registry: Registry,
): { stop(): void } {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/metrics") {
        const text = await registry.metrics();
        return new Response(text, {
          headers: {
            "Content-Type": registry.contentType,
          },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  return {
    stop() {
      server.stop();
    },
  };
}
