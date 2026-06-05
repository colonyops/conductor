# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install                          # install dependencies
bun run conductor start              # start the daemon
bun run lint                         # biome check src/ tests/
bun run format                       # biome format --write src/ tests/
bun run typecheck                    # tsc --noEmit (pre-existing type errors exist; don't introduce new ones)
bun test tests/unit/                 # unit tests (fast, no external deps)
bun test tests/unit/lifecycle.test.ts  # single test file
bun run test:integration             # integration tests (requires hive CLI, 120s timeout)
bun run test:e2e                     # e2e tests
```

## Architecture

Conductor is a Bun/TypeScript daemon. The flow is:

```
Claude Code hooks → IPC signal files → fs.watch watcher → state machine → EventBus → plugins
```

### Key layers

**`src/core/`** — daemon internals

- `ipc.ts` — writes/reads signal files at `~/.local/conductor/sessions/<id>/events/`. `writeIpcEvent` is called by `conductor signal` (injected as a Claude Code hook). `watchIpcEvents` uses `fs.watch` recursively and drains all session dirs on any `.json` file event.
- `lifecycle.ts` — pure state machine `transition()`. Takes current `Session` + `SessionEvent`, returns `{ nextState, actions[] }`. Actions are side-effect descriptors (start/cancel idle timer, emit event, trigger cleanup) — never executed here.
- `session.ts` — `SessionManager` owns the live session map and idle timers. `applyTransition()` calls `lifecycle.transition()` then executes the returned actions. Also contains `injectHooks()` (writes `.claude/settings.json` into session workspaces) and `injectPrePrompt()` (writes `agents.md`, symlinks `CLAUDE.md` → `agents.md`).
- `events.ts` — typed `EventBus` with 30s per-handler timeout. Core events: `sessionCreated`, `sessionActive`, `sessionIdle`, `sessionComplete`, `sessionRecycled`, `sessionApproval`, `sessionError`, `conductorStart`, `conductorStop`, `pluginError`.
- `hive-client.ts` — shells out to `hive new` and `hive session list --json`. Derives `workDir` as `~/.local/share/hive/repos/<repo>-<id>`.
- `observability.ts` — Prometheus metrics via `prom-client`, served by `Bun.serve()` at `:9090/metrics`.

**`src/sdk/`** — plugin-facing API (re-exported from `src/sdk/index.ts` as `@conductor/sdk`)

- `kv.ts` — `BunSqliteKVStore`, scoped per plugin ID, WAL mode, at `~/.local/conductor/kv.db`
- `scheduler.ts` — `interval()` and `schedule()` (HH:MM daily times); no external cron lib
- `secrets.ts` — resolves from env var → OS keychain (macOS `security`, Linux `secret-tool`) → interactive prompt
- `hive.ts` — plugin-facing `HiveClient` wrapping `SessionManager`; all `onSession*` subscriptions are auto-unsubscribed on teardown
- `http.ts` — thin `HttpClient` wrapper used by built-in plugins

**`src/plugins/`**

- `loader.ts` — SHA-256 trust model: hashes plugin file, compares to `trustedPlugins` in config, prompts on first run or file change. 30s `init()` timeout; failed plugins are skipped, daemon continues. Built-in plugins skip the trust check.
- `github-issues.ts` — built-in plugin: polls GitHub REST API, creates hive sessions for matching issues, closes issues on session complete. KV keys: `seen:<issueId>` and `session:<sessionId>`.

**`src/config.ts`** — hand-rolled validation (no Zod). Config search order: explicit path → `.conductor/conductor.config.json` → `conductor.config.json`. Atomic writes via temp-file rename.

### Session lifecycle

Sessions live in `SessionManager.sessions` (in-memory Map). State transitions are driven by IPC signals from Claude Code hooks (`PostToolUse` → `activity`, `Stop` → `stop` or `stop:approval`). Approval-pending state is detected by `stop:approval` signal. Sessions are removed from the map on COMPLETE; `hive recycle` is called at that point.

### Plugin contract

Plugins export `definePlugin({ id, name, init })` as default. `init(ctx)` receives `{ kv, hive, secrets, scheduler, logger, http }`. All scheduler jobs and event subscriptions registered during `init()` are tracked and torn down on plugin unload. The `@conductor/sdk` path alias resolves to `src/sdk/index.ts`.

### IPC data directory

`CONDUCTOR_DATA_DIR` defaults to `~/.local/conductor/`, overridable via `CONDUCTOR_DATA_DIR_TEST_OVERRIDE` env var (used by integration tests to isolate state).

### Integration tests

Tests in `tests/integration/scenarios/` use `TestEnv` (manages isolated conductor data dirs and temp hive workspaces) and `ConductorDaemon` (starts/stops the daemon subprocess). Each scenario is numbered and independent. They require `hive` CLI on `PATH`.
