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

### Restart recovery

Session state and idle timers live only in memory. To survive daemon restarts, Conductor writes a per-session `meta.json` sidecar at creation time (recording `pluginId`, `name`, `workDir`, and `idleTimeoutMs`) and reconciles on startup:

- Sessions that hive still reports `active` are re-adopted into `IDLE` with a fresh idle timer. A finished agent then idle-times-out to `COMPLETE` and is recycled; an agent still working flips back to `ACTIVE` on its next activity signal.
- Tracked session directories that hive no longer reports are treated as stale and cleaned up.
- IPC signals written while the daemon was down (e.g. a `Stop` delivered during a restart) are drained on startup rather than stranded until the next unrelated write.

Reconciliation runs before plugins start, so open-session caps and idle timers reflect reality from the first poll. It is never fatal to startup — a failure to list hive sessions is logged and skipped.

### Trust dialog

Claude Code shows a first-run trust/safety dialog the first time it opens an untrusted folder. Conductor accepts it automatically by polling the session's tmux panes and dismissing the dialog (then confirming it actually cleared). Detection is **content-based**: the agent window is not assumed to be named `claude`, so it works regardless of which agent command hive launches. The dialog appears even under `--dangerously-skip-permissions` (it precedes bypass mode), and its wording is matched across Claude Code versions.

This runtime auto-accept is **best-effort**. It screen-scrapes the agent TUI, so it depends on the prompt rendering within the poll window and on its wording matching one of the known phrasings — both of which can drift across Claude Code versions or flake under load. For **headless deployments, pre-configure trust** instead so no dialog is ever shown; see [Pre-configuring folder trust (headless)](docs/getting-started.md#pre-configuring-folder-trust-headless) in the Getting Started guide. The screen-scraping path then only matters as a fallback for workspaces you have not covered.

## Prerequisites

- [Bun](https://bun.sh) runtime
- `hive` CLI >= v0.53.0 installed and on `PATH`

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
      "assignee": "my-bot",
      "maxOpenSessions": 3,
      "inProgressLabel": "in-progress",
      "doneLabel": "done",
      "tokenSecretKey": "github.token",
      "tokenSource": "secret"
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

### Plugin context

`init(ctx)` receives a single `PluginContext` with these services:

| Service | Purpose |
|---|---|
| `ctx.kv` | Per-plugin persistent key-value store (SQLite-backed) |
| `ctx.hive` | Create sessions and subscribe to lifecycle events |
| `ctx.secrets` | Resolve secrets from env var, `gh` CLI, OS keychain, or interactive prompt |
| `ctx.scheduler` | Register recurring `interval()` and daily `schedule()` jobs |
| `ctx.logger` | Structured logger; lines are tagged with the plugin `name` |
| `ctx.http` | HTTP client with bearer/interceptor support and request logging |
| `ctx.metrics` | Register plugin-namespaced Prometheus metrics (see [Observability](#observability)) |

### Lifecycle subscriptions

`ctx.hive` exposes all seven session lifecycle events. Each returns an unsubscribe function and is automatically torn down when the plugin unloads:

| Subscription | Fires when |
|---|---|
| `onSessionCreated` | A session is created |
| `onSessionActive` | A session enters `ACTIVE` (agent ran a tool) |
| `onSessionIdle` | A session enters `IDLE` (agent stopped, idle timer running) |
| `onSessionComplete` | A session reaches `COMPLETE` (about to be recycled) |
| `onSessionRecycled` | A session has been recycled via `hive recycle` |
| `onSessionApproval` | A session is blocked in `APPROVAL` awaiting a permission decision |
| `onSessionError` | A session error occurred (handler also receives the `error`) |

```ts
ctx.hive.onSessionApproval(async ({ session }) => {
  ctx.logger.warn("session needs approval", { id: session.id });
  // notify a human, auto-approve out of band, etc.
});

ctx.hive.onSessionError(async ({ session, error }) => {
  ctx.logger.error("session error", { id: session.id, error: error.message });
});
```

### Trust model

Conductor verifies a plugin's SHA-256 hash **before** importing the module (importing executes its top-level code, so trust must be established from the file bytes first). The trust prompt identifies a plugin by **path and hash only** — the `name`/`id` come from inside the unverified module and are not shown.

On first load, Conductor computes the hash and prompts you to approve it; approved hashes are written back to `trustedPlugins` in your config (keyed by the config-declared `path`). If the file changes, the hash no longer matches and you are re-prompted on the next startup. Built-in plugins skip the trust check.

## Built-in plugins

### `github-issues`

Polls GitHub Issues and creates one hive session per matching issue. When a session completes, the plugin adds `doneLabel` (if configured) and **leaves the issue open** — the session finishing means the agent opened a PR, which still needs review, so the issue is not closed.

Configure via `builtins["github-issues"]` in `conductor.config.json`:

| Field | Default | Description |
|---|---|---|
| `repo` | required | GitHub repository in `owner/repo` format |
| `labels` | required | Issues must carry all of these labels to be picked up |
| `pollIntervalMs` | `300000` | How often to poll, in ms |
| `assignee` | — | If set, only issues assigned to this user are picked up |
| `maxOpenSessions` | — | Cap on concurrent sessions this plugin holds; further issues are deferred to later polls |
| `inProgressLabel` | — | Label added to an issue when its session starts |
| `doneLabel` | — | Label added to an issue when its session completes |
| `tokenSecretKey` | `"github.token"` | Secret key used to resolve the GitHub token |
| `tokenSource` | `"secret"` | `"secret"` resolves via env/keychain; `"gh-cli"` uses `gh auth token` |

The GitHub token is resolved from the `GITHUB_TOKEN` environment variable, then the `tokenSecretKey` OS keychain entry — or from `gh auth token` when `tokenSource` is `"gh-cli"`.

**Deduplication.** A persistent `seen:<issueId>` KV marker is written **before** a session is spawned and is kept for the lifetime of the open issue (it is *not* removed when the session completes). This prevents re-spawning a session for a completed-but-still-open issue on the next poll. A caught `newSession()` failure removes the marker so the issue can be retried. `maxOpenSessions` caps how many sessions the plugin runs at once.

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

Plugins can register their own custom metrics through `ctx.metrics` (`counter`, `gauge`, `histogram`). Each is automatically namespaced `conductor_plugin_<plugin_id>_<name>` so plugins can never collide, and they render at the same `/metrics` endpoint. See the [Observability Guide](docs/observability.md#plugin-metrics) for the full API and naming rules.

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
