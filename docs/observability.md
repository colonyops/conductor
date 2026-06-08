# Observability

Conductor exposes Prometheus metrics and writes structured logs. All configuration lives under the `observability` key in `conductor.config.json`.

## Metrics

Conductor starts an HTTP server serving Prometheus metrics at:

```
GET http://localhost:<metricsPort>/metrics
```

The server binds all interfaces (`0.0.0.0`). There is no authentication or TLS. All other paths return `404`. The default port is **9090**.

```json
{
  "observability": {
    "metricsPort": 9090
  }
}
```

### Available metrics

All metrics use a `conductor_` prefix.

#### Sessions

| Metric | Type | Labels |
|---|---|---|
| `conductor_sessions_total` | Counter | `state`, `plugin_id` |
| `conductor_sessions_active` | Gauge | `state` |

`state` values: `CREATED`, `ACTIVE`, `IDLE`, `APPROVAL`, `COMPLETE`. `plugin_id` is the stable `id` from the plugin definition.

#### Plugin lifecycle

| Metric | Type | Labels |
|---|---|---|
| `conductor_plugin_init_duration_ms` | Histogram | `plugin_id` |
| `conductor_plugin_errors_total` | Counter | `plugin_id`, `type` |

Init duration buckets (ms): `10, 50, 100, 500, 1000, 5000, 10000, 30000`.

#### Scheduler

| Metric | Type | Labels |
|---|---|---|
| `conductor_scheduler_runs_total` | Counter | `plugin_id`, `job_type` |
| `conductor_scheduler_run_duration_ms` | Histogram | `plugin_id`, `job_type` |

`job_type` is `interval` or `daily`. Duration buckets (ms): `10, 50, 100, 500, 1000, 5000, 30000, 60000`.

#### IPC signals

| Metric | Type | Labels |
|---|---|---|
| `conductor_ipc_events_total` | Counter | `signal` |

`signal` values: `activity`, `stop`, `stop:approval`. This is the primary active metric — it increments once per IPC event received from Claude Code hooks.

#### Concurrency

| Metric | Type | Labels |
|---|---|---|
| `conductor_concurrency_active` | Gauge | `scope` |
| `conductor_concurrency_waiting` | Gauge | `scope` |

`scope` is `"global"` for the daemon-wide limit or the plugin `id` for per-plugin limits.

#### Secrets

| Metric | Type | Labels |
|---|---|---|
| `conductor_secrets_resolution_total` | Counter | `backend`, `result` |

`backend` values: `env`, `keychain`, `stdin`. `result` values: `hit`, `miss`.

> Most core metrics are defined but not yet fully instrumented and will report zero values. `conductor_ipc_events_total` is the only core counter currently active.

---

## Plugin metrics

Plugins can register and emit their own custom metrics through the `metrics` handle on the `PluginContext`. Plugin metrics render at the same `/metrics` endpoint as core metrics — no extra wiring required.

### Naming and isolation

Every plugin-registered metric name is automatically prefixed with:

```
conductor_plugin_<sanitized_plugin_id>_
```

The plugin id is baked into the metric **name** (not just a label), so two plugins can **never** collide — even if they declare the same metric name with different label sets (which would otherwise throw at registration in `prom-client`). This follows Prometheus' own subsystem-prefix convention (`go_`, `process_`, `nodejs_`).

```
plugin "acme.deploybot"                   -> conductor_plugin_acme_deploybot_deploys_total
plugin "conductor.builtin.github-issues"  -> conductor_plugin_conductor_builtin_github_issues_polls_total
```

**Sanitization** — both the plugin id and the metric name are normalized to valid Prometheus name tokens (`[a-zA-Z0-9_]`): any run of disallowed characters collapses to a single `_`, and leading/trailing `_` are trimmed. Because the fixed prefix is always prepended, a plugin cannot escape its namespace via a crafted name (e.g. `name: "../core"` → `conductor_plugin_<id>_core`). A name that is empty after sanitization is rejected.

### API

The `metrics` handle returns real `prom-client` instances, so plugins get the full familiar API (`.inc()`, `.observe()`, `.startTimer()`, `.labels()`):

```ts
export interface PluginMetricOptions {
  name: string;          // namespaced automatically; do NOT include the conductor_plugin_ prefix
  help: string;
  labelNames?: string[]; // plugin-defined dimensions; the prefix handles isolation
}
export interface PluginHistogramOptions extends PluginMetricOptions {
  buckets?: number[];
}
export interface PluginMetrics {
  counter(opts: PluginMetricOptions): Counter<string>;
  gauge(opts: PluginMetricOptions): Gauge<string>;
  histogram(opts: PluginHistogramOptions): Histogram<string>;
}
```

Registration is **idempotent**: calling `counter()`/`gauge()`/`histogram()` again with the same name returns the existing instance instead of throwing. Re-registering a name under a different metric type throws a clear error. When a plugin is unloaded its metrics are removed from the registry (counters reset on reload).

```ts
async init({ metrics, scheduler, logger }) {
  const polls = metrics.counter({ name: "polls_total", help: "Poll attempts", labelNames: ["result"] });
  const pollMs = metrics.histogram({ name: "poll_duration_ms", help: "Poll duration", buckets: [50, 100, 500, 1000, 5000] });
  scheduler.interval(pollIntervalMs, async () => {
    const end = pollMs.startTimer();
    try { await poll(); polls.inc({ result: "ok" }); }
    catch { polls.inc({ result: "error" }); }
    finally { end(); }
  });
}
```

### Built-in `github-issues` metrics

The built-in `github-issues` plugin ships these metrics as a reference implementation. Names below are shown without the `conductor_plugin_conductor_builtin_github_issues_` prefix.

| Metric | Type | Labels |
|---|---|---|
| `polls_total` | Counter | `result` (`ok`/`error`) |
| `poll_duration_ms` | Histogram | — |
| `issues_seen_total` | Counter | — |
| `sessions_created_total` | Counter | `result` (`ok`/`error`) |
| `rate_limited_total` | Counter | — |
| `label_updates_total` | Counter | `label`, `result` (`ok`/`error`) |
| `open_sessions` | Gauge | — |

---

## Logging

```json
{
  "observability": {
    "logPath": "~/.local/dotlogs/conductor.log",
    "logMaxBytes": 10485760,
    "logMaxBackups": 5,
    "logFormat": "json",
    "logCaller": false
  }
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `logPath` | `string` | `~/.local/dotlogs/conductor.log` | Log file path. `~` is expanded to `$HOME`. |
| `logMaxBytes` | `number` | `10485760` | File size in bytes that triggers rotation (10 MiB). |
| `logMaxBackups` | `number` | `5` | Number of rotated files to keep. Oldest is deleted when exceeded. |
| `logFormat` | `"json"` \| `"logfmt"` | `"json"` | Wire format for the log file and non-TTY stderr. |
| `logCaller` | `boolean` | `false` | Attach a `caller` field with the `file:line` of the log call site. |

### Rotation

When a log line would push the file past `logMaxBytes`, Conductor renames `conductor.log` → `conductor.log.1`, shifts existing backups up, and drops the oldest. The rotated files follow the pattern `conductor.log.1` through `conductor.log.<logMaxBackups>`.

### TTY behavior

When stderr is a terminal, Conductor writes colored human-readable output to stderr. `debug` entries are suppressed from stderr and written to the file only. When stderr is not a TTY, each line is written to both the file and stderr in the configured format.

### Log formats

**JSON** (default) — one JSON object per line:
```
{"ts":"2026-06-05T12:00:00.000Z","level":"info","component":"conductor","msg":"Conductor started","pluginCount":2}
```

**logfmt** — space-separated `key=value` pairs; values with spaces or special characters are quoted:
```
ts=2026-06-05T12:00:00.000Z level=info component=conductor msg="Conductor started" pluginCount=2
```

### Structured fields

Every log line includes:

| Field | Description |
|---|---|
| `ts` | UTC timestamp (ISO 8601) |
| `level` | `debug`, `info`, `warn`, or `error` |
| `component` | `"conductor"` for daemon logs; plugin `name` for plugin logs |
| `msg` | Human-readable message |
| `caller` | `file:line` — only present when `logCaller: true` |

Additional fields by source:

| Source | Fields |
|---|---|
| Daemon startup | `pluginCount`, `dataDir` |
| Session state change | `sessionId`, `from`, `to`, `event` |
| Plugin loaded | `pluginId`, `name` |
| Plugin load error | `path`, `error` |
| Scheduler error | `error`, `time` (daily jobs only) |

Plugin log lines use the plugin's `name` as the `component` field, making it straightforward to filter by plugin in any log tool that understands the JSON or logfmt format.
