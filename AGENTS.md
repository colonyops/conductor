You are an autonomous agent working independently without human interaction. Do not ask clarifying questions — make reasonable assumptions and proceed.

## Hook Signal Resolution

Claude Code hooks are injected into `.claude/settings.local.json` in each session's work directory. These hooks call `conductor signal stop` and `conductor signal activity` to drive session state transitions.

Because `conductor` may not be on `PATH` in a development environment (when running via `bun run src/index.ts`), the injected commands use **absolute paths** resolved at hook-injection time:

- **Dev mode** (`bun run src/index.ts`): hooks are injected as `<bun-path> <script-path> signal <event> --session <id>`
- **Installed binary**: hooks are injected as `<conductor-binary-path> signal <event> --session <id>`

This is handled by `resolveSignalInvocation()` in `src/core/session.ts`, which checks whether `process.argv[1]` ends with `.ts` to distinguish the two modes.

Conductor is a Bun/TypeScript daemon. The flow is:

```
Claude Code hooks → IPC signal files → fs.watch watcher → state machine → EventBus → plugins
```

### Key layers

**`src/core/`** — daemon internals

- `ipc.ts` — writes/reads signal files at `~/.local/conductor/sessions/<id>/events/`, plus the per-session `meta.json` sidecar (`sessionMetaPath`). `writeIpcEvent` is called by `conductor signal` (injected as a Claude Code hook). `watchIpcEvents` uses `fs.watch` recursively and drains all session dirs on any `.json` file event; it also drains **once on startup** so signals written while the daemon was down are not stranded.
- `lifecycle.ts` — pure state machine `transition()`. Takes current `Session` + `SessionEvent`, returns `{ nextState, actions[] }`. Actions are side-effect descriptors (start/cancel idle timer, emit event, trigger cleanup) — never executed here.
- `session.ts` — `SessionManager` owns the live session map and idle timers. `applyTransition()` calls `lifecycle.transition()` then executes the returned actions. `createSession()` writes a `meta.json` sidecar (`pluginId`, `name`, `workDir`, `idleTimeoutMs`) and `reconcileSessions()` re-adopts sessions that outlived a previous daemon on startup (active → IDLE with a fresh idle timer; stale dirs cleaned up). Also contains `injectHooks()` (writes `.claude/settings.local.json` into session workspaces) and `injectPrePrompt()` (writes `agents.md`, symlinks `CLAUDE.md` → `agents.md`).
- `events.ts` — typed `EventBus` with 30s per-handler timeout. Core events: `sessionCreated`, `sessionActive`, `sessionIdle`, `sessionComplete`, `sessionRecycled`, `sessionApproval`, `sessionError`, `conductorStart`, `conductorStop`, `pluginError`.
- `hive-client.ts` — shells out to `hive batch`/`hive session list --json`/`hive session recycle`. Derives `workDir` as `~/.local/share/hive/repos/<repo>-<id>`. `acceptTrustPrompt()` polls tmux panes to dismiss Claude Code's first-run trust dialog; detection is content-based (no assumption about the agent window name) and matches the dialog wording across versions.
- `observability.ts` — Prometheus metrics via `prom-client`, served by `Bun.serve()` at `:9090/metrics`. Also exposes the plugin-metrics factory (`ctx.metrics`) which name-prefixes each plugin's metrics with `conductor_plugin_<id>_`.

**`src/sdk/`** — plugin-facing API (re-exported from `src/sdk/index.ts` as `@conductor/sdk`)

- `kv.ts` — `BunSqliteKVStore`, scoped per plugin ID, WAL mode, at `~/.local/conductor/kv.db`
- `scheduler.ts` — `interval()` and `schedule()` (HH:MM daily times); no external cron lib
- `secrets.ts` — resolves from env var → `gh auth token` (when `ghCLI`) → OS keychain (macOS `security`, Linux `secret-tool`) → interactive prompt
- `hive.ts` — plugin-facing `HiveClient` wrapping `SessionManager`; all `onSession*` subscriptions are auto-unsubscribed on teardown
- `http.ts` — thin `HttpClient` wrapper used by built-in plugins

**`src/plugins/`**

- `loader.ts` — SHA-256 trust model: hashes the plugin file and **verifies trust before `import()`** (importing runs the module's top-level code), keyed by the config `path`; prompts on first run or file change. 30s `init()` timeout; failed plugins are skipped, daemon continues. Built-in plugins skip the trust check.
- `github-issues.ts` — built-in plugin: polls GitHub REST API (paginated), creates hive sessions for matching issues. On session complete it adds `doneLabel` and **leaves the issue open** (PR review pending) — it does not close it. KV keys: `seen:<issueId>` (written before spawn, kept for the open issue's lifetime to prevent re-spawn) and `session:<sessionId>`. Supports `assignee`, `maxOpenSessions`, `inProgressLabel`, `doneLabel`, and `tokenSource` (`secret`/`gh-cli`).

**`src/config.ts`** — hand-rolled validation (no Zod). Config search order: explicit path → `.conductor/conductor.config.json` → `conductor.config.json`. Atomic writes via temp-file rename.

### Session lifecycle

Sessions live in `SessionManager.sessions` (in-memory Map). State transitions are driven by IPC signals from Claude Code hooks (`PostToolUse` → `activity`, `Stop` → `stop` or `stop:approval`). Approval-pending state is detected by `stop:approval` signal. Sessions are removed from the map on COMPLETE; `hive recycle` is called at that point. Because the map and idle timers are in-memory only, `reconcileSessions()` runs on startup (before plugins load) to re-adopt sessions that outlived a previous daemon, reading the `meta.json` sidecars persisted at creation.

### Plugin contract

Plugins export `definePlugin({ id, name, init })` as default. `init(ctx)` receives `{ kv, hive, secrets, scheduler, logger, http, metrics }`. All scheduler jobs and event subscriptions registered during `init()` are tracked and torn down on plugin unload. The `@conductor/sdk` path alias resolves to `src/sdk/index.ts`.

### IPC data directory

`CONDUCTOR_DATA_DIR` defaults to `~/.local/conductor/`, overridable via `CONDUCTOR_DATA_DIR_TEST_OVERRIDE` env var (used by integration tests to isolate state).

### Integration tests

Tests in `tests/integration/scenarios/` use `TestEnv` (manages isolated conductor data dirs and temp hive workspaces) and `ConductorDaemon` (starts/stops the daemon subprocess). Each scenario is numbered and independent. They require `hive` CLI on `PATH`.

## Package Manager Policy

This repository uses `bunfig.toml` to enforce:

- **minimumReleaseAge = 259200** (3 days) — packages published less than 3 days ago are blocked.
- **ignoreScripts = true** — lifecycle scripts (postinstall, etc.) are not executed.

Do not bypass these settings. If a package install fails due to `minimumReleaseAge`, report the package name and version and stop.
