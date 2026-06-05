# Observability Guide

Conductor exposes Prometheus metrics and writes structured logs. This guide covers what is available, how to configure it, and how to collect both with tools like [Grafana Alloy](https://grafana.com/docs/alloy/).

## Table of Contents

- [Metrics](#metrics)
  - [Accessing the metrics endpoint](#accessing-the-metrics-endpoint)
  - [Configuration](#metrics-configuration)
  - [Available metrics](#available-metrics)
  - [Scraping with Alloy / Prometheus](#scraping-with-alloy--prometheus)
- [Logging](#logging)
  - [Configuration](#logging-configuration)
  - [Log formats](#log-formats)
  - [Structured fields](#structured-fields)
  - [Collecting logs with Alloy](#collecting-logs-with-alloy)
- [Full config reference](#full-config-reference)

---

## Metrics

### Accessing the metrics endpoint

Conductor starts a lightweight HTTP server that serves Prometheus metrics in the standard text exposition format. The endpoint is:

```
GET http://<host>:<metricsPort>/metrics
```

By default the server listens on all interfaces (`0.0.0.0`) on port **9090**:

```bash
curl http://localhost:9090/metrics
```

All other paths return `404 Not Found`. There is no authentication or TLS — restrict access at the network level if needed.

### Metrics configuration

Set `observability.metricsPort` in your `conductor.config.json`:

```json
{
  "observability": {
    "metricsPort": 9090
  }
}
```

The port must be between 1 and 65535. To disable the metrics server, set `metricsPort` to `0` (which causes Bun to reject the bind). If the port is already in use, Conductor will error on startup.

### Available metrics

All metrics use a `conductor_` prefix and are registered in a private Prometheus registry (not the default global registry).

#### Sessions

| Metric | Type | Labels | Description |
|---|---|---|---|
| `conductor_sessions_total` | Counter | `state`, `plugin_id` | Total sessions that have entered each state |
| `conductor_sessions_active` | Gauge | `state` | Current session count by state |

The `state` label takes the values `CREATED`, `ACTIVE`, `IDLE`, `APPROVAL`, and `COMPLETE`. The `plugin_id` label is the stable `id` string from the plugin definition (e.g. `"conductor.github-issues"`).

#### Plugin lifecycle

| Metric | Type | Labels | Description |
|---|---|---|---|
| `conductor_plugin_init_duration_ms` | Histogram | `plugin_id` | Time spent in a plugin's `init()` call (ms) |
| `conductor_plugin_errors_total` | Counter | `plugin_id`, `type` | Plugin errors by plugin and error type |

The `conductor_plugin_init_duration_ms` histogram uses buckets `[10, 50, 100, 500, 1000, 5000, 10000, 30000]` ms. Plugins have a 30-second init timeout, so the largest bucket captures timeouts.

#### Scheduler

| Metric | Type | Labels | Description |
|---|---|---|---|
| `conductor_scheduler_runs_total` | Counter | `plugin_id`, `job_type` | Scheduler job executions by plugin and job type |
| `conductor_scheduler_run_duration_ms` | Histogram | `plugin_id`, `job_type` | Scheduler job execution duration (ms) |

The `job_type` label distinguishes `interval` jobs from `daily` (time-of-day) jobs. The duration histogram uses buckets `[10, 50, 100, 500, 1000, 5000, 30000, 60000]` ms.

#### IPC signals

| Metric | Type | Labels | Description |
|---|---|---|---|
| `conductor_ipc_events_total` | Counter | `signal` | IPC signals received from Claude Code hooks |

The `signal` label takes the values `activity`, `stop`, and `stop:approval`. This is the only metric currently instrumented — it increments once per signal drained from the IPC file watcher.

#### Concurrency

| Metric | Type | Labels | Description |
|---|---|---|---|
| `conductor_concurrency_active` | Gauge | `scope` | Active concurrency slots currently held |
| `conductor_concurrency_waiting` | Gauge | `scope` | Sessions queued waiting for a concurrency slot |

The `scope` label is either `"global"` (the daemon-wide limit) or the plugin `id` (for per-plugin `concurrencyLimit`).

#### Secrets

| Metric | Type | Labels | Description |
|---|---|---|---|
| `conductor_secrets_resolution_total` | Counter | `backend`, `result` | Secret resolution attempts by backend and result |

The `backend` label indicates which backend was tried: `env`, `keychain`, or `stdin`. The `result` label is `hit` or `miss`.

> **Note:** Most metrics are defined and will appear in the scrape output with zero values, but the full instrumentation call sites are not yet complete. The `conductor_ipc_events_total` counter is the primary active metric today.

### Scraping with Alloy / Prometheus

#### Prometheus

Add a scrape config to `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: conductor
    static_configs:
      - targets: ["localhost:9090"]
    scrape_interval: 15s
```

#### Grafana Alloy

```alloy
prometheus.scrape "conductor" {
  targets = [{ __address__ = "localhost:9090" }]

  forward_to = [prometheus.remote_write.default.receiver]
}
```

If Conductor runs on a different host (e.g. inside a VM or container), replace `localhost` with the appropriate address. Alloy and Conductor only need network-level access — no credentials are required.

---

## Logging

### Logging configuration

All logging options live under `observability` in `conductor.config.json`:

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
| `logPath` | `string` | `~/.local/dotlogs/conductor.log` | Path to the log file. `~` is expanded to `$HOME`. |
| `logMaxBytes` | `number` | `10485760` | Max file size in bytes before rotation triggers (default 10 MiB). |
| `logMaxBackups` | `number` | `5` | Number of rotated backup files to keep. Oldest is deleted. |
| `logFormat` | `"json"` \| `"logfmt"` | `"json"` | Wire format for file and non-TTY stderr output. |
| `logCaller` | `boolean` | `false` | Attach a `caller` field with the `file:line` of the log call site. |

#### Log rotation

When a log line would push the file past `logMaxBytes`, Conductor rotates before writing:

1. `conductor.log.5` is deleted (if it exists)
2. `conductor.log.4` → `conductor.log.5`, and so on down to `conductor.log.1`
3. `conductor.log` → `conductor.log.1`
4. The new line is written to a fresh `conductor.log`

The in-memory byte counter is seeded from the file size at startup, so rotation is approximately correct across restarts.

#### TTY behavior

When Conductor's stderr is a terminal, log lines are written to stderr with ANSI colors in a human-readable format:

```
12:00:00.000 [INFO] conductor: Conductor started pluginCount=2 dataDir=/home/user/.local/conductor
```

`debug`-level entries are never written to stderr — they go to the log file only. When stderr is not a TTY (e.g. when running as a service or piping output), the serialized line is written to both stderr and the file.

### Log formats

#### JSON (default)

Each line is a JSON object followed by a newline:

```json
{"ts":"2026-06-05T12:00:00.000Z","level":"info","component":"conductor","msg":"Conductor started","pluginCount":2,"dataDir":"/home/user/.local/conductor"}
```

JSON is the recommended format for machine consumption and log collection agents.

#### logfmt

Each line is a sequence of `key=value` pairs separated by spaces:

```
ts=2026-06-05T12:00:00.000Z level=info component=conductor msg="Conductor started" pluginCount=2 dataDir=/home/user/.local/conductor
```

Values that contain spaces, `=`, `"`, or `\` are JSON-quoted. Field order is: `ts`, `level`, `component`, `msg`, `caller` (if enabled), then all additional data fields.

### Structured fields

Every log line includes these fields:

| Field | Type | Description |
|---|---|---|
| `ts` | string | UTC timestamp in ISO 8601 format |
| `level` | string | `debug`, `info`, `warn`, or `error` |
| `component` | string | `"conductor"` for daemon logs; plugin `name` for plugin logs |
| `msg` | string | Human-readable message |
| `caller` | string | `file:line` of the log call site (only when `logCaller: true`) |

Additional fields are emitted in context-specific log lines:

| Source | Extra fields |
|---|---|
| Daemon startup | `pluginCount`, `dataDir` |
| Session state change | `sessionId`, `from`, `to`, `event` |
| Plugin loaded | `pluginId`, `name` |
| Plugin load error | `path`, `error` |
| Scheduler error | `error`, `time` (for daily jobs) |
| Shutdown error | `error` |

Plugin log lines carry the plugin's `name` as `component`, so you can filter by plugin:

```bash
# Follow logs from a specific plugin
tail -f ~/.local/dotlogs/conductor.log | jq 'select(.component == "GitHub Issues")'

# All errors across all components
tail -f ~/.local/dotlogs/conductor.log | jq 'select(.level == "error")'

# Session state transitions
tail -f ~/.local/dotlogs/conductor.log | jq 'select(.sessionId != null)'
```

### Collecting logs with Alloy

The log file is newline-delimited JSON by default, which Alloy's `loki.source.file` component reads directly.

#### Alloy config

```alloy
local.file_match "conductor_logs" {
  path_targets = [{
    __path__ = "/home/<user>/.local/dotlogs/conductor.log*",
    job      = "conductor",
  }]
}

loki.source.file "conductor" {
  targets    = local.file_match.conductor_logs.targets
  forward_to = [loki.process.conductor.receiver]
}

loki.process "conductor" {
  stage.json {
    expressions = {
      ts        = "ts",
      level     = "level",
      component = "component",
    }
  }

  stage.labels {
    values = {
      level     = "level",
      component = "component",
    }
  }

  stage.timestamp {
    source = "ts"
    format = "RFC3339Nano"
  }

  forward_to = [loki.write.default.receiver]
}
```

The glob pattern `conductor.log*` covers the active file and all rotated backups (`conductor.log.1` through `conductor.log.5`). Alloy tracks file offsets and handles rotation automatically.

If you use `logFormat: "logfmt"` instead:

```alloy
loki.process "conductor" {
  stage.logfmt {
    mapping = {
      ts        = "ts",
      level     = "level",
      component = "component",
    }
  }

  stage.labels {
    values = {
      level     = "level",
      component = "component",
    }
  }

  stage.timestamp {
    source = "ts"
    format = "RFC3339Nano"
  }

  forward_to = [loki.write.default.receiver]
}
```

#### Promtail (alternative)

If you use Promtail instead of Alloy, the equivalent `scrape_configs` entry is:

```yaml
scrape_configs:
  - job_name: conductor
    static_configs:
      - targets: [localhost]
        labels:
          job: conductor
          __path__: /home/<user>/.local/dotlogs/conductor.log*
    pipeline_stages:
      - json:
          expressions:
            ts: ts
            level: level
            component: component
      - labels:
          level:
          component:
      - timestamp:
          source: ts
          format: RFC3339Nano
```

---

## Full config reference

All observability options in one block with their defaults:

```json
{
  "observability": {
    "metricsPort": 9090,
    "logPath": "~/.local/dotlogs/conductor.log",
    "logMaxBytes": 10485760,
    "logMaxBackups": 5,
    "logFormat": "json",
    "logCaller": false
  }
}
```

For all other configuration options see the [Getting Started guide](./getting-started.md#config-file-reference).
