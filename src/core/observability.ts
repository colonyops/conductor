import { Counter, Gauge, Histogram, Registry } from "prom-client";

// ── Plugin metrics ─────────────────────────────────────────────────────────────

/** Fixed prefix prepended to every plugin-registered metric name. */
const PLUGIN_METRIC_PREFIX = "conductor_plugin_";

export interface PluginMetricOptions {
  /** Namespaced automatically; do NOT include the conductor_plugin_ prefix. */
  name: string;
  help: string;
  /** Plugin-defined dimensions; the name prefix handles cross-plugin isolation. */
  labelNames?: string[];
}

export interface PluginHistogramOptions extends PluginMetricOptions {
  buckets?: number[];
}

export interface PluginMetrics {
  counter(opts: PluginMetricOptions): Counter<string>;
  gauge(opts: PluginMetricOptions): Gauge<string>;
  histogram(opts: PluginHistogramOptions): Histogram<string>;
}

export interface PluginMetricsFactory {
  forPlugin(pluginId: string): PluginMetrics;
  removePlugin(pluginId: string): void;
}

/**
 * Normalize an arbitrary string to a valid Prometheus name token: collapse any
 * run of disallowed characters (anything outside [a-zA-Z0-9_]) into a single
 * underscore, then trim leading/trailing underscores.
 */
function sanitizeNameToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Build a factory of per-plugin metric facades over a shared registry. Each
 * plugin's metrics are name-prefixed with `conductor_plugin_<sanitized_id>_`,
 * so two plugins can never collide even when they declare the same metric name
 * with different label sets. Mirrors `openKVDatabase(...).forPlugin(id)`.
 */
export function createPluginMetricsFactory(registry: Registry): PluginMetricsFactory {
  // Full metric names registered per plugin id, for teardown.
  const namesByPlugin = new Map<string, Set<string>>();

  function fullName(pluginId: string, name: string): string {
    const idToken = sanitizeNameToken(pluginId);
    const nameToken = sanitizeNameToken(name);
    if (nameToken === "") {
      throw new Error(`Plugin metric name "${name}" is empty after sanitization`);
    }
    return `${PLUGIN_METRIC_PREFIX}${idToken}_${nameToken}`;
  }

  function track(pluginId: string, name: string): void {
    let set = namesByPlugin.get(pluginId);
    if (!set) {
      set = new Set<string>();
      namesByPlugin.set(pluginId, set);
    }
    set.add(name);
  }

  function forPlugin(pluginId: string): PluginMetrics {
    function register<T>(name: string, type: string, create: () => T): T {
      const existing = registry.getSingleMetric(name);
      if (existing) {
        // prom-client tags each metric instance with its type; reuse the
        // existing instance for idempotent re-registration, but reject a
        // collision with a different metric type under the same name.
        const existingType = (existing as { type?: string }).type;
        if (existingType !== type) {
          throw new Error(`${name} already registered as a ${existingType}`);
        }
        return existing as T;
      }
      const metric = create();
      track(pluginId, name);
      return metric;
    }

    return {
      counter(opts) {
        const name = fullName(pluginId, opts.name);
        return register(name, "counter", () => {
          return new Counter({
            name,
            help: opts.help,
            labelNames: opts.labelNames ?? [],
            registers: [registry],
          });
        });
      },
      gauge(opts) {
        const name = fullName(pluginId, opts.name);
        return register(name, "gauge", () => {
          return new Gauge({
            name,
            help: opts.help,
            labelNames: opts.labelNames ?? [],
            registers: [registry],
          });
        });
      },
      histogram(opts) {
        const name = fullName(pluginId, opts.name);
        return register(name, "histogram", () => {
          return new Histogram({
            name,
            help: opts.help,
            labelNames: opts.labelNames ?? [],
            ...(opts.buckets ? { buckets: opts.buckets } : {}),
            registers: [registry],
          });
        });
      },
    };
  }

  function removePlugin(pluginId: string): void {
    const set = namesByPlugin.get(pluginId);
    if (!set) return;
    for (const name of set) {
      registry.removeSingleMetric(name);
    }
    namesByPlugin.delete(pluginId);
  }

  return { forPlugin, removePlugin };
}

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
  pluginMetrics: PluginMetricsFactory;
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
    pluginMetrics: createPluginMetricsFactory(registry),
  };
}

export function startMetricsServer(port: number, registry: Registry): { stop(): void } {
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
