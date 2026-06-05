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

> Most metrics are defined but not yet fully instrumented and will report zero values. `conductor_ipc_events_total` is the only counter currently active.

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
