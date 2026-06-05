You are an autonomous agent working independently without human interaction. Do not ask clarifying questions — make reasonable assumptions and proceed.

## Codebase Structure

```
src/
  config.ts               — configuration loading and validation
  index.ts                — CLI entry point and daemon startup
  ipc.ts                  — IPC signals (file-based inter-process events)
  types.ts                — shared domain types

  session/
    events.ts             — EventBus (pub/sub for session lifecycle events)
    lifecycle.ts          — pure state machine transition function
    manager.ts            — SessionManager, hook injection, prompt building

  observability/
    metrics.ts            — Prometheus metrics and HTTP metrics server

  hive/
    cli.ts                — external hive CLI wrapper (hive batch, hive session list)

  plugin/
    trust.ts              — plugin trust: SHA-256 hashing, approval prompt, persistence
    loader.ts             — plugin loading pipeline: trust → secrets → init
    builtin/
      github-issues.ts    — built-in GitHub Issues plugin

  sdk/                    — public plugin SDK (imported as @conductor/sdk)
    concurrency.ts        — ConcurrencyLimiter
    http.ts               — HttpClient
    kv.ts                 — KVStore (SQLite-backed)
    logger.ts             — Logger (file rotation + stderr, logfmt/json)
    scheduler.ts          — Scheduler (interval + daily schedule)
    secrets.ts            — SecretsClient (env → OS keychain → prompt)
    client.ts             — HiveClient: plugin-facing session API
    index.ts              — public SDK surface (definePlugin + all exported types)
```

## Key Boundaries

- **Plugin authors** import only from `@conductor/sdk` (aliased to `src/sdk/index.ts`).
- **`hive/cli.ts`** wraps the external `hive` binary (session creation, listing). It is NOT the plugin-facing API — that is `sdk/client.ts`.
- **`session/lifecycle.ts`** is a pure function with no side effects or imports beyond types. Keep it that way.
- **`plugin/trust.ts`** is independently testable. Tests live in `tests/unit/trust.test.ts`.
