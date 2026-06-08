import { createMetrics, startMetricsServer } from "../../src/core/observability.js";

describe("createMetrics", () => {
  it("returns a registry and all 10 standard metric handles", () => {
    const { registry, metrics } = createMetrics();
    expect(registry).toBeDefined();
    expect(metrics.sessionsTotal).toBeDefined();
    expect(metrics.sessionsActive).toBeDefined();
    expect(metrics.pluginInitDuration).toBeDefined();
    expect(metrics.pluginErrors).toBeDefined();
    expect(metrics.schedulerRuns).toBeDefined();
    expect(metrics.schedulerRunDuration).toBeDefined();
    expect(metrics.ipcEventsTotal).toBeDefined();
    expect(metrics.concurrencyActive).toBeDefined();
    expect(metrics.concurrencyWaiting).toBeDefined();
    expect(metrics.secretsResolutionTotal).toBeDefined();
  });

  it("returns a working pluginMetrics factory", () => {
    const { pluginMetrics } = createMetrics();
    expect(pluginMetrics).toBeDefined();
    expect(typeof pluginMetrics.forPlugin).toBe("function");
    expect(typeof pluginMetrics.removePlugin).toBe("function");
  });

  it("renders plugin-registered metrics on the shared registry", async () => {
    const { registry, pluginMetrics } = createMetrics();
    pluginMetrics.forPlugin("acme.bot").counter({ name: "widgets_total", help: "Widgets" }).inc();

    const text = await registry.metrics();
    expect(text).toContain("conductor_plugin_acme_bot_widgets_total 1");
  });

  it("counter inc accumulates correctly", async () => {
    const { registry, metrics } = createMetrics();
    metrics.sessionsTotal.inc({ state: "ACTIVE", plugin_id: "test" });
    metrics.sessionsTotal.inc({ state: "ACTIVE", plugin_id: "test" });
    metrics.sessionsTotal.inc({ state: "IDLE", plugin_id: "test" });

    const text = await registry.metrics();
    // Should have 2 for ACTIVE and 1 for IDLE
    expect(text).toContain('conductor_sessions_total{state="ACTIVE",plugin_id="test"} 2');
    expect(text).toContain('conductor_sessions_total{state="IDLE",plugin_id="test"} 1');
  });

  it("gauge set overwrites previous value", async () => {
    const { registry, metrics } = createMetrics();
    metrics.sessionsActive.set({ state: "ACTIVE" }, 5);
    metrics.sessionsActive.set({ state: "ACTIVE" }, 3);

    const text = await registry.metrics();
    expect(text).toContain('conductor_sessions_active{state="ACTIVE"} 3');
  });

  it("histogram records observations in buckets", async () => {
    const { registry, metrics } = createMetrics();
    metrics.pluginInitDuration.observe({ plugin_id: "test" }, 100);
    metrics.pluginInitDuration.observe({ plugin_id: "test" }, 5000);

    const text = await registry.metrics();
    expect(text).toContain("conductor_plugin_init_duration_ms");
    expect(text).toContain("conductor_plugin_init_duration_ms_sum");
    expect(text).toContain("conductor_plugin_init_duration_ms_count");
    expect(text).toContain("+Inf");
  });

  it("renderText output contains # HELP and # TYPE lines for each metric", async () => {
    const { registry } = createMetrics();
    const text = await registry.metrics();

    const expectedMetrics = [
      "conductor_sessions_total",
      "conductor_sessions_active",
      "conductor_plugin_init_duration_ms",
      "conductor_plugin_errors_total",
      "conductor_scheduler_runs_total",
      "conductor_scheduler_run_duration_ms",
      "conductor_ipc_events_total",
      "conductor_concurrency_active",
      "conductor_concurrency_waiting",
      "conductor_secrets_resolution_total",
    ];

    for (const name of expectedMetrics) {
      expect(text).toContain(`# HELP ${name}`);
      expect(text).toContain(`# TYPE ${name}`);
    }
  });

  it("registry output is valid Prometheus text format (lines end with newline)", async () => {
    const { registry, metrics } = createMetrics();
    metrics.sessionsTotal.inc({ state: "CREATED", plugin_id: "p1" });

    const text = await registry.metrics();
    // Every non-empty line that's not a comment should match the Prometheus line format
    const lines = text.split("\n").filter((l) => l.length > 0 && !l.startsWith("#"));
    for (const line of lines) {
      // Lines should be: metric_name{labels} value [timestamp]
      expect(line).toMatch(/^\w+(\{[^}]*\})?\s+[\d.+e-]+/);
    }
  });
});

describe("startMetricsServer", () => {
  it("serves /metrics and returns 200 with text/plain content type", async () => {
    const { registry, metrics } = createMetrics();
    metrics.sessionsTotal.inc({ state: "ACTIVE", plugin_id: "srv-test" });

    const port = 19091 + Math.floor(Math.random() * 100);
    const server = startMetricsServer(port, registry);

    try {
      const res = await fetch(`http://localhost:${port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/plain");
      const body = await res.text();
      expect(body).toContain("conductor_sessions_total");
    } finally {
      server.stop();
    }
  });

  it("returns 404 for unknown paths", async () => {
    const { registry } = createMetrics();
    const port = 19191 + Math.floor(Math.random() * 100);
    const server = startMetricsServer(port, registry);

    try {
      const res = await fetch(`http://localhost:${port}/unknown`);
      expect(res.status).toBe(404);
    } finally {
      server.stop();
    }
  });
});
