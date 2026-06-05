# Getting Started with Conductor

Conductor is a poll-driven session orchestrator for the [`hive`](https://github.com/hay-kot/hive) CLI. It runs as a long-lived daemon that manages the lifecycle of headless AI agent sessions — watching for IPC signals, driving a per-session state machine, and dispatching plugin logic in response to lifecycle events.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Your First Run](#your-first-run)
- [Writing Your First Plugin](#writing-your-first-plugin)
- [Understanding the Session Lifecycle](#understanding-the-session-lifecycle)
- [Config File Reference](#config-file-reference)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before installing Conductor, make sure the following tools are installed and on your `PATH`:

| Tool | Purpose | Install |
|---|---|---|
| [Bun](https://bun.sh) | JavaScript runtime that executes Conductor and plugins | `curl -fsSL https://bun.sh/install \| bash` |
| [hive CLI](https://github.com/hay-kot/hive) | Session management — Conductor calls `hive` to create and recycle agent sessions | See hive docs |
| [Claude Code](https://claude.ai/code) | The agent runtime that runs inside each hive session | `npm install -g @anthropic-ai/claude-code` |
| [tmux](https://github.com/tmux/tmux) | Terminal multiplexer used by hive to host agent sessions | `brew install tmux` / `apt install tmux` |

Verify your setup:

```bash
bun --version
hive --version
claude --version
tmux -V
```

---

## Installation

```bash
git clone https://github.com/colonyops/conductor
cd conductor
bun install
```

Add `conductor` to your shell's `PATH` so the Claude Code hooks can call it from any working directory:

```bash
# Add to ~/.zshrc or ~/.bashrc
export PATH="$HOME/path/to/conductor:$PATH"

# Or install globally with bun
bun install --global .
```

Verify:

```bash
conductor --help
```

---

## Your First Run

### 1. Create a config file

Create `conductor.config.json` in your project directory (or in `.conductor/conductor.config.json`):

```json
{
  "idleTimeoutMs": 600000,
  "concurrency": { "global": 5 },
  "observability": {
    "metricsPort": 9090,
    "logPath": "~/.local/dotlogs/conductor.log"
  }
}
```

### 2. Start the daemon

```bash
# Auto-discovers conductor.config.json in the current directory
conductor start

# Or specify the path explicitly
conductor start --config .conductor/conductor.config.json
```

Conductor will print a startup log line and begin watching for IPC events. It exposes Prometheus metrics at `http://localhost:9090/metrics`.

### 3. Test IPC signaling

In a separate terminal, simulate signals that a Claude Code session would write:

```bash
# Simulate a tool-use event (marks a session active)
conductor signal activity --session my-test-session

# Simulate a stop event (marks a session idle)
conductor signal stop --session my-test-session
```

You should see corresponding log output from the daemon.

---

## Writing Your First Plugin

A plugin is a TypeScript file with a default export created via `definePlugin`. Plugins subscribe to session lifecycle events and create new sessions in response to external triggers (e.g., a GitHub Issue, a webhook, a queue message).

### Minimal plugin

Create `plugins/hello-world.ts`:

```ts
import { definePlugin } from "@conductor/sdk";

export default definePlugin({
  id: "my-org.hello-world",   // unique, stable identifier — never change this
  name: "Hello World",
  version: "1.0.0",

  async init(ctx) {
    // Create one session when the plugin starts
    const session = await ctx.hive.newSession({
      name: "hello-world-demo",
      remote: "https://github.com/your-org/your-repo",
      context: "Print hello world and stop.",
    });

    ctx.logger.info("Session created", { id: session.id });

    // React to session completion
    ctx.hive.onSessionComplete(async ({ session }) => {
      ctx.logger.info("Session finished", { id: session.id });
    });
  },
});
```

### Register the plugin

Add it to `conductor.config.json`:

```json
{
  "plugins": [
    {
      "path": "./plugins/hello-world.ts",
      "enabled": true
    }
  ]
}
```

### Trust approval

On first load, Conductor computes a SHA-256 hash of the plugin file and asks you to approve it:

```
New plugin: Hello World
  ID:   my-org.hello-world
  Path: /absolute/path/plugins/hello-world.ts
  Hash: sha256:abc123...

Allow this plugin? [y/N]:
```

Type `y` to approve. The hash is written back to `trustedPlugins` in your config. If you modify the plugin file, you will be prompted again on next startup.

### Polling example

Most real plugins use `ctx.scheduler.interval` to poll an external source and create sessions:

```ts
import { definePlugin } from "@conductor/sdk";

export default definePlugin({
  id: "my-org.issue-poller",
  name: "Issue Poller",
  requiredSecrets: ["github.token"],

  async init(ctx) {
    const token = await ctx.secrets.get("github.token");

    // Poll every 5 minutes
    ctx.scheduler.interval(5 * 60_000, async () => {
      const response = await ctx.http.get("https://api.github.com/repos/owner/repo/issues", {
        headers: { Authorization: `Bearer ${token}` },
      });

      const issues = await response.json() as Array<{ number: number; title: string }>;

      for (const issue of issues) {
        const alreadySeen = await ctx.kv.has(`seen:${issue.number}`);
        if (alreadySeen) continue;

        await ctx.kv.set(`seen:${issue.number}`, { createdAt: new Date().toISOString() });

        await ctx.hive.newSession({
          name: `issue-${issue.number}`,
          remote: "https://github.com/owner/repo",
          context: `Resolve GitHub issue #${issue.number}: ${issue.title}`,
        });
      }
    });
  },
});
```

### Using secrets

Secrets are resolved in this order:

1. Environment variable (if `opts.env` is set)
2. OS keychain (`security` on macOS, `secret-tool` on Linux)
3. Interactive stdin prompt (only if `opts.promptIfMissing: true`)

```ts
// From environment variable GITHUB_TOKEN, falling back to keychain
const token = await ctx.secrets.get("github.token", {
  env: "GITHUB_TOKEN",
  promptIfMissing: true,
});
```

On first run with `promptIfMissing: true`, you will be prompted once and the value is stored in the OS keychain for subsequent runs.

---

## Understanding the Session Lifecycle

Each hive session created by a plugin moves through a state machine driven by IPC signals from Claude Code hooks.

### State machine

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

### IPC signals

Claude Code writes IPC signals via hooks configured in the session's `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "hooks": [
          { "type": "command", "command": "conductor signal activity --session <id>" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "conductor signal stop --session <id>" }
        ]
      }
    ]
  }
}
```

Conductor writes these hooks automatically when it creates a session via `hive`. You do not need to configure them manually.

### Signal types

| Signal | CLI flag | When emitted |
|---|---|---|
| `activity` | `conductor signal activity` | Every Claude Code tool use (PostToolUse hook) |
| `stop` | `conductor signal stop` | Claude Code session stops cleanly |
| `stop:approval` | `conductor signal stop --approval` | Claude Code paused waiting for a permission approval |

### Idle timeout

When a session reaches `IDLE`, a timer starts. If no new signal arrives within `idleTimeoutMs`, the session moves to `COMPLETE` and is recycled. The timeout can be set globally or per-plugin:

```json
{
  "idleTimeoutMs": 600000,
  "plugins": [
    {
      "path": "./plugins/my-plugin.ts",
      "idleTimeoutMs": 300000
    }
  ]
}
```

---

## Config File Reference

Config is loaded from `.conductor/conductor.config.json` or `conductor.config.json` in the current directory.

### Top-level fields

| Field | Type | Default | Description |
|---|---|---|---|
| `plugins` | `PluginEntry[]` | `[]` | External plugin files to load |
| `trustedPlugins` | `Record<string, string>` | `{}` | Plugin ID → SHA-256 hash; auto-populated on first approval — do not edit manually |
| `idleTimeoutMs` | `number` | `600000` | Milliseconds a session stays IDLE before moving to COMPLETE |
| `prePromptTemplate` | `string` | — | Text prepended to every session's initial prompt |
| `postPromptTemplate` | `string` | — | Text appended to every session's initial prompt |
| `concurrency.global` | `number` | `10` | Max sessions active concurrently across all plugins |
| `observability.metricsPort` | `number` | `9090` | Prometheus metrics HTTP port |
| `observability.logPath` | `string` | `~/.local/dotlogs/conductor.log` | Log file path |
| `observability.logMaxBytes` | `number` | `10485760` | Max log file size before rotation (10 MiB) |
| `observability.logMaxBackups` | `number` | `5` | Number of rotated log files to keep |
| `builtins` | `BuiltinsConfig` | `{}` | Configuration for built-in plugins |

### Plugin entry fields

```json
{
  "plugins": [
    {
      "path": "./plugins/my-plugin.ts",
      "enabled": true,
      "idleTimeoutMs": 300000,
      "concurrencyLimit": 3
    }
  ]
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `path` | `string` | required | Path to the plugin `.ts` file (supports `~` expansion) |
| `enabled` | `boolean` | `true` | Set to `false` to disable a plugin without removing it |
| `idleTimeoutMs` | `number` | global value | Per-plugin idle timeout override |
| `concurrencyLimit` | `number` | — | Max concurrent sessions this plugin can hold; unlimited if omitted |

### Built-in: `github-issues`

The `github-issues` built-in polls a GitHub repository for matching issues and creates one session per issue. Issues are closed when the session completes.

```json
{
  "builtins": {
    "github-issues": {
      "repo": "owner/repo",
      "labels": ["conductor"],
      "pollIntervalMs": 300000,
      "inProgressLabel": "conductor/in-progress",
      "doneLabel": "conductor/done",
      "tokenSecretKey": "github.token",
      "tokenSource": "gh-cli"
    }
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `repo` | `string` | required | GitHub repository in `owner/repo` format |
| `labels` | `string[]` | required | Issues must have all of these labels to be picked up |
| `pollIntervalMs` | `number` | `300000` | How often to poll (ms) |
| `inProgressLabel` | `string` | — | Label added to an issue when its session starts |
| `doneLabel` | `string` | — | Label added to an issue when its session completes |
| `tokenSecretKey` | `string` | `"github.token"` | Keychain key used to look up the GitHub token |
| `tokenSource` | `string` | — | Set to `"gh-cli"` to use `gh auth token` instead of the keychain |

### Prompt templates

Use `prePromptTemplate` and `postPromptTemplate` to inject consistent context into every session's initial task prompt:

```json
{
  "prePromptTemplate": "You are an autonomous agent. Do not ask for clarification — make reasonable assumptions and proceed.",
  "postPromptTemplate": "When your work is complete, open a draft PR and link it to the relevant issue."
}
```

These wrap the `context` string passed to `ctx.hive.newSession()`. For individual sessions that need different instructions, use `prePromptOverride` / `postPromptOverride` in `NewSessionOptions`.

---

## Troubleshooting

### Conductor exits immediately on start

Check whether the config file is valid JSON:

```bash
bun -e "console.log(JSON.parse(require('fs').readFileSync('conductor.config.json', 'utf8')))"
```

Conductor logs a parse error and exits if the config is malformed.

### Plugin not loading

1. **Hash mismatch** — If you see `Plugin rejected at trust prompt`, the file hash changed. Start conductor and approve the new hash at the prompt.
2. **Import error** — Check for TypeScript compilation errors. Bun surfaces these at import time.
3. **Secret not found** — If `requiredSecrets` lists a key that can't be resolved, the plugin is skipped. Resolve the secret first:

```bash
# Store a secret in the keychain manually
security add-generic-password -s conductor -a github.token -w "your-token-here"
```

4. **Init timeout** — Plugins have 30 seconds to complete `init()`. If your init awaits a slow external call, move it inside `ctx.scheduler.interval` instead.

### Sessions not reaching COMPLETE

If sessions stay IDLE indefinitely, check `idleTimeoutMs`. The default is 10 minutes (600 000 ms). You can lower it for testing:

```json
{ "idleTimeoutMs": 30000 }
```

Also verify that the Claude Code hooks are writing signals. Check:

```bash
ls ~/.local/conductor/sessions/<session-id>/events/
```

You should see `.json` files created by the hooks.

### Metrics endpoint unreachable

Confirm the port is not already in use:

```bash
lsof -i :9090
```

Change the port in your config:

```json
{ "observability": { "metricsPort": 9091 } }
```

### Viewing logs

Logs are written as newline-delimited JSON to the path in `observability.logPath`:

```bash
tail -f ~/.local/dotlogs/conductor.log | jq .
```

To filter for errors only:

```bash
tail -f ~/.local/dotlogs/conductor.log | jq 'select(.level == "error")'
```

### Plugin `requiredSecrets` failing on CI / headless environments

In CI, secrets should be provided as environment variables. Use the `env` option in your plugin:

```ts
const token = await ctx.secrets.get("github.token", {
  env: "GITHUB_TOKEN",
});
```

Set `GITHUB_TOKEN` in your CI environment and the keychain lookup is skipped.

---

## Source reference

| File | Description |
|---|---|
| [`src/index.ts`](../src/index.ts) | CLI entry point (`conductor start`, `signal`, `plugin-docs`) |
| [`src/config.ts`](../src/config.ts) | Config loading, validation, and path resolution |
| [`src/core/lifecycle.ts`](../src/core/lifecycle.ts) | Pure state machine — transition table |
| [`src/core/ipc.ts`](../src/core/ipc.ts) | IPC signal writing and file watcher |
| [`src/core/session.ts`](../src/core/session.ts) | Session manager — owns the in-memory session registry |
| [`src/plugins/loader.ts`](../src/plugins/loader.ts) | Plugin loading, trust approval, and init |
| [`src/sdk/`](../src/sdk/) | Plugin SDK — `hive`, `secrets`, `kv`, `scheduler`, `http`, `logger` |
| [`src/plugins/github-issues.ts`](../src/plugins/github-issues.ts) | Built-in GitHub Issues plugin |

For the metrics and logging reference, see the [Observability Guide](./observability.md).

For the complete plugin SDK reference, run:

```bash
conductor plugin-docs
```
