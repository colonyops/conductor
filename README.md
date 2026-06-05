# Conductor

Poll-driven session orchestrator for the [`hive`](https://github.com/hay-kot/hive) CLI. Conductor runs as a long-lived daemon that manages the lifecycle of headless AI agent sessions — watching for activity signals, driving a per-session state machine, and dispatching plugin logic in response to lifecycle events.

## How it works

Claude Code (or any hive-compatible agent) writes IPC signal files as it runs. Conductor watches those files, maps each signal to a session state transition, and fires events that plugins subscribe to.

```
Claude Code hooks → IPC signal files → Conductor daemon → state machine → plugin events
                                         ↑
                                    conductor.config.json
```

**Session state machine:**

```
CREATED  + PostToolUse               → ACTIVE
ACTIVE   + PostToolUse               → ACTIVE   (resets idle timer)
ACTIVE   + Stop                      → IDLE
ACTIVE   + Stop (approval pending)   → APPROVAL
ACTIVE   + IdleTimeout               → IDLE
IDLE     + PostToolUse               → ACTIVE
IDLE     + IdleTimeout               → COMPLETE  (session recycled)
IDLE     + Stop                      → COMPLETE
IDLE     + Stop (approval pending)   → APPROVAL
APPROVAL + PostToolUse               → ACTIVE
APPROVAL + ApprovalResolved          → ACTIVE
COMPLETE + any                       → no-op
```

Sessions are recycled (cleaned up via `hive recycle`) only when they reach `COMPLETE`.

## Prerequisites

- [Bun](https://bun.sh) runtime
- `hive` CLI installed and on `PATH`

## Installation

### From a release (recommended)

Download the tarball from the [latest release](https://github.com/colonyops/conductor/releases/latest), extract, and run:

```bash
curl -sL https://github.com/colonyops/conductor/releases/latest/download/conductor.tar.gz | tar -xz
bun conductor.js start
```

For a persistent install, move `conductor.js` somewhere on your `PATH` and wrap it in a small script:

```bash
#!/usr/bin/env sh
exec bun /usr/local/lib/conductor/conductor.js "$@"
```

### From source

```bash
git clone https://github.com/colonyops/conductor
cd conductor
bun install
```

## Quickstart

```bash
# From a release install
bun conductor.js start

# From source
bun conductor start

# Specify a config file explicitly
bun conductor start --config path/to/conductor.config.json
```

Conductor will load plugins, start the Prometheus metrics server on port 9090, and begin watching for IPC events.

## Configuration

Config is loaded from `.conductor/conductor.config.json` or `conductor.config.json` in the working directory. All fields are optional and merge with defaults.

```jsonc
{
  "plugins": [
    {
      "path": "./plugins/my-plugin.ts",
      "enabled": true,
      "idleTimeoutMs": 300000,
      "concurrencyLimit": 3
    }
  ],
  "trustedPlugins": {
    "my-plugin-id": "<sha256-hash>"
  },
  "concurrency": {
    "global": 10
  },
  "observability": {
    "metricsPort": 9090,
    "logPath": "~/.local/dotlogs/conductor.log",
    "logMaxBytes": 10485760,
    "logMaxBackups": 5
  },
  "idleTimeoutMs": 600000,
  "prePromptTemplate": "You are running as a headless agent without human interaction.",
  "postPromptTemplate": "When your task is complete, open a draft PR and link it to the relevant issue.",
  "builtins": {
    "github-issues": {
      "repo": "owner/repo",
      "labels": ["conductor"],
      "pollIntervalMs": 300000,
      "cloneStrategy": "full",
      "inProgressLabel": "in-progress",
      "doneLabel": "done",
      "tokenSecretKey": "github.token"
    }
  }
}
```

| Field | Default | Description |
|---|---|---|
| `plugins` | `[]` | External plugin files to load |
| `trustedPlugins` | `{}` | Plugin ID → SHA-256 hash; auto-populated on first approval |
| `concurrency.global` | `10` | Max concurrent sessions across all plugins |
| `observability.metricsPort` | `9090` | Prometheus metrics HTTP port |
| `observability.logPath` | `~/.local/dotlogs/conductor.log` | Log file path |
| `idleTimeoutMs` | `600000` | Idle timeout (ms) before a session moves to COMPLETE |
| `prePromptTemplate` | — | Text prepended to every session's initial prompt |
| `postPromptTemplate` | — | Text appended to every session's initial prompt |

### Plugin entry fields

| Field | Default | Description |
|---|---|---|
| `path` | required | Path to the plugin `.ts` file |
| `enabled` | `true` | Whether to load this plugin |
| `idleTimeoutMs` | global value | Per-plugin idle timeout override |
| `concurrencyLimit` | — | Max concurrent sessions this plugin can hold |

## CLI reference

```
conductor start [--config <path>]    Start the daemon
conductor stop                        Send shutdown signal (Phase 2)
conductor signal <event> --session <id>
                                      Write a lifecycle signal (called by Claude Code hooks)
                                      Events: activity | stop | stop:approval
conductor status                      Show session status (Phase 2)
conductor plugin-docs                 Print plugin SDK reference for LLM-assisted plugin authoring
```

## Writing plugins

Run `conductor plugin-docs` to print the full SDK reference in LLM-consumable markdown — API signatures, lifecycle events, and a complete annotated example.

Plugins are TypeScript files with a default export created via `definePlugin`:

```ts
import { definePlugin } from "@conductor/sdk";

export default definePlugin({
  id: "my-org.my-plugin",
  name: "My Plugin",
  version: "1.0.0",
  requiredSecrets: ["my-api-key"],

  async init(ctx) {
    const apiKey = await ctx.secrets.get("my-api-key");

    ctx.scheduler.interval(60_000, async () => {
      // poll something and create sessions
    });

    ctx.hive.onSessionComplete(async ({ session }) => {
      ctx.logger.info("session completed", { id: session.id });
    });
  },
});
```

Register it in `conductor.config.json`:

```json
{
  "plugins": [{ "path": "./plugins/my-plugin.ts" }]
}
```

On first load, Conductor will compute a SHA-256 hash of the file and prompt you to approve it. Approved hashes are written back to `trustedPlugins` in your config.

## Built-in plugins

### `github-issues`

Polls GitHub Issues, creates a hive session per matching issue, and closes the issue when the session completes.

Configure via `builtins["github-issues"]` in `conductor.config.json` (see example above). The GitHub token is resolved from the `github.token` OS keychain entry or the `GITHUB_TOKEN` environment variable.

## Observability

Prometheus metrics are served at `http://localhost:<metricsPort>/metrics`.

Available metrics:

| Metric | Description |
|---|---|
| `conductor_sessions_total` | Sessions created, by plugin |
| `conductor_sessions_active` | Currently active sessions |
| `conductor_plugin_init_duration_ms` | Plugin init latency |
| `conductor_plugin_errors_total` | Plugin errors, by plugin |
| `conductor_scheduler_runs_total` | Scheduler job executions |
| `conductor_scheduler_run_duration_ms` | Scheduler job latency |
| `conductor_ipc_events_total` | IPC signals received, by type |
| `conductor_concurrency_active` | Active concurrency slots |
| `conductor_concurrency_waiting` | Queued concurrency waiters |
| `conductor_secrets_resolution_total` | Secret resolution attempts |

Logs are newline-delimited JSON written to `observability.logPath`, with automatic rotation at `logMaxBytes`.

## Development

### Git hooks

This project uses [lefthook](https://github.com/evilmartians/lefthook) to run checks before commits and pushes. Hooks install automatically when you run `bun install` (via the `prepare` script).

To install manually:

```bash
bunx lefthook install
```

**Pre-commit hooks** (run in parallel):
- `bun run lint` — Biome linter
- `bun run format` — Biome formatter; fails if any file needed reformatting
- `bun run typecheck` — TypeScript type checking

**Pre-push hooks:**
- `bun run test` — unit test suite

To skip hooks in an emergency:

```bash
LEFTHOOK=0 git commit -m "..."
```

## Testing

```bash
# Unit tests (fast, no external dependencies)
bun test tests/unit/

# Integration tests (requires hive CLI)
bun test tests/integration/scenarios/ --timeout=120000

# E2E tests
bun test tests/e2e/
```
