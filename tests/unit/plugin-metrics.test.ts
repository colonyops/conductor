import { Registry } from "prom-client";
import { createPluginMetricsFactory } from "../../src/core/observability.js";

describe("createPluginMetricsFactory", () => {
  it("prefixes metric names with conductor_plugin_<sanitized_id>_", async () => {
    const registry = new Registry();
    const factory = createPluginMetricsFactory(registry);
    const metrics = factory.forPlugin("acme.deploybot");

    const counter = metrics.counter({ name: "deploys_total", help: "Deploys" });
    counter.inc();

    const text = await registry.metrics();
    expect(text).toContain("conductor_plugin_acme_deploybot_deploys_total 1");
  });

  it("sanitizes dots, dashes, and other invalid chars in id and name", async () => {
    const registry = new Registry();
    const factory = createPluginMetricsFactory(registry);
    const metrics = factory.forPlugin("conductor.builtin.github-issues");

    metrics.counter({ name: "polls.total!", help: "Polls" }).inc();

    const text = await registry.metrics();
    expect(text).toContain("conductor_plugin_conductor_builtin_github_issues_polls_total 1");
  });

  it("collapses runs of invalid chars into a single underscore", async () => {
    const registry = new Registry();
    const factory = createPluginMetricsFactory(registry);
    const metrics = factory.forPlugin("a---b...c");

    metrics.counter({ name: "x  y", help: "h" }).inc();

    const text = await registry.metrics();
    expect(text).toContain("conductor_plugin_a_b_c_x_y 1");
  });

  it("prevents namespace escape via a crafted name", async () => {
    const registry = new Registry();
    const factory = createPluginMetricsFactory(registry);
    const metrics = factory.forPlugin("p1");

    metrics.counter({ name: "../core", help: "h" }).inc();

    const text = await registry.metrics();
    // The leading "../" sanitizes away; the metric stays inside the plugin namespace.
    expect(text).toContain("conductor_plugin_p1_core 1");
    expect(text).not.toContain("\ncore ");
  });

  it("rejects a name that is empty after sanitization", () => {
    const registry = new Registry();
    const factory = createPluginMetricsFactory(registry);
    const metrics = factory.forPlugin("p1");

    expect(() => metrics.counter({ name: "...", help: "h" })).toThrow(/empty after sanitization/);
  });

  it("returns the same instance on idempotent re-registration", () => {
    const registry = new Registry();
    const factory = createPluginMetricsFactory(registry);
    const metrics = factory.forPlugin("p1");

    const first = metrics.counter({ name: "hits_total", help: "h" });
    const second = metrics.counter({ name: "hits_total", help: "h" });
    expect(second).toBe(first);
  });

  it("throws when a name is re-registered as a different metric type", () => {
    const registry = new Registry();
    const factory = createPluginMetricsFactory(registry);
    const metrics = factory.forPlugin("p1");

    metrics.counter({ name: "thing", help: "h" });
    expect(() => metrics.gauge({ name: "thing", help: "h" })).toThrow(/already registered as a counter/);
  });

  it("removePlugin removes the plugin's metrics from the registry", async () => {
    const registry = new Registry();
    const factory = createPluginMetricsFactory(registry);
    const metrics = factory.forPlugin("p1");

    metrics.counter({ name: "hits_total", help: "h" }).inc();
    expect(await registry.metrics()).toContain("conductor_plugin_p1_hits_total");

    factory.removePlugin("p1");
    expect(await registry.metrics()).not.toContain("conductor_plugin_p1_hits_total");
  });

  it("removePlugin is a no-op for an unknown plugin id", () => {
    const registry = new Registry();
    const factory = createPluginMetricsFactory(registry);
    expect(() => factory.removePlugin("never-registered")).not.toThrow();
  });

  it("two plugins declaring the same metric name with different labels do not collide", async () => {
    const registry = new Registry();
    const factory = createPluginMetricsFactory(registry);

    const a = factory.forPlugin("plugin.a").counter({
      name: "events_total",
      help: "Events",
      labelNames: ["kind"],
    });
    const b = factory.forPlugin("plugin.b").counter({
      name: "events_total",
      help: "Events",
      labelNames: ["region"],
    });

    a.inc({ kind: "click" });
    b.inc({ region: "us" });

    const text = await registry.metrics();
    expect(text).toContain('conductor_plugin_plugin_a_events_total{kind="click"} 1');
    expect(text).toContain('conductor_plugin_plugin_b_events_total{region="us"} 1');
  });

  it("supports gauge set and histogram observe through the facade", async () => {
    const registry = new Registry();
    const factory = createPluginMetricsFactory(registry);
    const metrics = factory.forPlugin("p1");

    metrics.gauge({ name: "open", help: "h" }).set(4);
    metrics.histogram({ name: "dur_ms", help: "h", buckets: [10, 100] }).observe(50);

    const text = await registry.metrics();
    expect(text).toContain("conductor_plugin_p1_open 4");
    expect(text).toContain("conductor_plugin_p1_dur_ms_count 1");
    expect(text).toContain("conductor_plugin_p1_dur_ms_sum 50");
  });
});
