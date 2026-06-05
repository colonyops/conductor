# Conductor Server Deployment Guide

This guide covers installing and running conductor as a persistent daemon on a Linux server.

## Prerequisites

The following must be installed and on `PATH` before running conductor:

| Dependency | Notes |
|---|---|
| [Bun](https://bun.sh) ≥ 1.1 | JavaScript runtime |
| [hive CLI](https://github.com/hay-kot/hive) | Session management |
| git | Cloning and upgrading the repo |
| tmux _(optional)_ | Required only if your plugins launch tmux sessions |

Install Bun:

```bash
curl -fsSL https://bun.sh/install | bash
# Add to shell PATH permanently
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

Install the hive CLI per its own documentation, then verify both are available:

```bash
bun --version
hive --version
```

## Installation

### Automated (recommended)

The `deploy/install.sh` script creates a dedicated system user, clones the repository,
installs dependencies, writes a starter config, and registers the systemd service.

```bash
# Download and run as root
curl -fsSL https://raw.githubusercontent.com/colonyops/conductor/main/deploy/install.sh | sudo bash
```

Environment variables can override the defaults:

| Variable | Default | Description |
|---|---|---|
| `CONDUCTOR_REPO` | GitHub HTTPS URL | Repository to clone |
| `CONDUCTOR_DIR` | `/opt/conductor` | Installation directory |
| `CONDUCTOR_USER` | `conductor` | System user to run the daemon |
| `CONDUCTOR_DATA_DIR` | `/var/lib/conductor` | Session data and KV store |
| `CONDUCTOR_LOG_DIR` | `/var/log/conductor` | Log output directory |
| `CONDUCTOR_CONFIG_DIR` | `/etc/conductor` | Config file directory |

```bash
# Example: custom install path
CONDUCTOR_DIR=/srv/conductor sudo -E bash deploy/install.sh
```

### Manual

```bash
# 1. Create a system user
sudo useradd --system --no-create-home --shell /usr/sbin/nologin conductor

# 2. Clone the repository
sudo git clone https://github.com/colonyops/conductor.git /opt/conductor
sudo chown -R conductor:conductor /opt/conductor

# 3. Install dependencies
cd /opt/conductor
sudo -u conductor bun install --frozen-lockfile

# 4. Create runtime directories
sudo mkdir -p /var/lib/conductor /var/log/conductor /etc/conductor
sudo chown conductor:conductor /var/lib/conductor /var/log/conductor /etc/conductor

# 5. Write config (see Configuration section below)
sudo cp /opt/conductor/conductor.config.json /etc/conductor/conductor.config.json
sudo chown conductor:conductor /etc/conductor/conductor.config.json

# 6. Install and enable the systemd service
sudo cp /opt/conductor/deploy/conductor.service /etc/systemd/system/conductor.service
sudo systemctl daemon-reload
sudo systemctl enable conductor
```

## Configuration

The config file lives at `/etc/conductor/conductor.config.json` when deployed via the
systemd service. All fields are optional and merge with defaults.

```jsonc
{
  // Concurrency
  "concurrency": { "global": 5 },

  // Logging and metrics
  "observability": {
    "metricsPort": 9090,
    "logPath": "/var/log/conductor/conductor.log",
    "logMaxBytes": 10485760,
    "logMaxBackups": 5,
    "logFormat": "json"
  },

  // Session idle timeout before recycling (ms)
  "idleTimeoutMs": 600000,

  // External plugins (optional)
  "plugins": [
    {
      "path": "/opt/conductor/plugins/my-plugin.ts",
      "enabled": true,
      "idleTimeoutMs": 300000,
      "concurrencyLimit": 3
    }
  ],

  // Populated automatically on first plugin approval
  "trustedPlugins": {},

  // Text injected into every session's prompt
  "prePromptTemplate": "You are running as a headless agent without human interaction.",
  "postPromptTemplate": "When your task is complete, open a draft PR and link it to the relevant issue.",

  // Built-in GitHub Issues plugin
  "builtins": {
    "github-issues": {
      "repo": "owner/repo",
      "labels": ["conductor"],
      "pollIntervalMs": 300000,
      "inProgressLabel": "conductor/in-progress",
      "doneLabel": "conductor/done",
      "tokenSecretKey": "github.token"
    }
  }
}
```

### All configuration fields

| Field | Default | Description |
|---|---|---|
| `concurrency.global` | `10` | Max concurrent sessions across all plugins |
| `observability.metricsPort` | `9090` | Prometheus metrics HTTP port |
| `observability.logPath` | `~/.local/dotlogs/conductor.log` | Structured log file path |
| `observability.logMaxBytes` | `10485760` | Log rotation threshold (bytes) |
| `observability.logMaxBackups` | `5` | Rotated log files to keep |
| `observability.logFormat` | `json` | `json` or `logfmt` |
| `idleTimeoutMs` | `600000` | Idle timeout before a session moves to COMPLETE |
| `prePromptTemplate` | — | Text prepended to every session's initial prompt |
| `postPromptTemplate` | — | Text appended to every session's initial prompt |
| `plugins` | `[]` | External plugin files to load |
| `trustedPlugins` | `{}` | Plugin ID → SHA-256 hash; auto-populated on approval |
| `builtins` | `{}` | Built-in plugin configuration |

### Required environment variables

Conductor resolves secrets through the OS keychain (`hive secrets`) or environment variables. No environment variables are **required** to start the daemon, but plugins may need:

| Variable | Used by | Notes |
|---|---|---|
| `GITHUB_TOKEN` | `github-issues` builtin | Fallback if keychain entry is absent |
| `CONDUCTOR_DATA_DIR` | daemon | Override default `~/.local/conductor` data path |

Set these in the systemd unit's `[Service]` section or in `/etc/conductor/env`:

```ini
# /etc/conductor/env
GITHUB_TOKEN=ghp_...
```

Then reference it in the unit file:

```ini
[Service]
EnvironmentFile=/etc/conductor/env
```

## Starting and stopping

```bash
# Start the daemon
sudo systemctl start conductor

# Stop gracefully
sudo systemctl stop conductor

# Restart (e.g. after config change)
sudo systemctl restart conductor

# Enable auto-start on boot
sudo systemctl enable conductor

# Disable auto-start
sudo systemctl disable conductor
```

## Health check and status verification

### Service status

```bash
# One-line status
sudo systemctl status conductor

# Live log stream
sudo journalctl -u conductor -f

# Last 100 log lines
sudo journalctl -u conductor -n 100
```

A healthy daemon prints a startup line similar to:

```
level=info component=conductor msg="conductor started" metricsPort=9090
```

### Log file

Structured JSON logs are written to the path in `observability.logPath`:

```bash
tail -f /var/log/conductor/conductor.log | jq .
```

### Prometheus metrics

Conductor exposes metrics at `http://localhost:9090/metrics`. Verify it is responding:

```bash
curl -s http://localhost:9090/metrics | grep conductor_sessions
```

Key metrics to watch:

| Metric | What it means |
|---|---|
| `conductor_sessions_active` | Sessions currently in ACTIVE state |
| `conductor_plugin_errors_total` | Cumulative plugin errors (should stay low) |
| `conductor_ipc_events_total` | IPC signals received per type |

### Inspect session KV state

```bash
# List all plugin KV keys
bun conductor kv list

# Scope to a specific plugin
bun conductor kv list --plugin my-org.my-plugin

# Read a value
bun conductor kv get my-key --plugin my-org.my-plugin
```

## Upgrading

```bash
# 1. Pull latest code
sudo git -C /opt/conductor fetch
sudo git -C /opt/conductor reset --hard origin/main

# 2. Update dependencies
cd /opt/conductor && sudo -u conductor bun install --frozen-lockfile

# 3. Reload the systemd unit if it changed
sudo cp /opt/conductor/deploy/conductor.service /etc/systemd/system/conductor.service
sudo systemctl daemon-reload

# 4. Restart
sudo systemctl restart conductor
sudo systemctl status conductor
```

Active sessions are not drained before shutdown — conductor's state machine resumes cleanly on restart because session state is persisted in the KV store and IPC event files are durable on disk.

## Troubleshooting

**Daemon fails to start — `bun: command not found`**

The `conductor` system user doesn't have bun on its PATH. Either install bun system-wide (`/usr/local/bin`) or set `ExecStart` in the unit file to the full path:

```ini
ExecStart=/root/.bun/bin/bun src/index.ts start --config /etc/conductor/conductor.config.json
```

**Plugin trust prompt blocks startup**

The first time a new plugin is loaded, conductor prompts for approval interactively. Pre-populate `trustedPlugins` in the config with the SHA-256 hash of each plugin file:

```bash
sha256sum /opt/conductor/plugins/my-plugin.ts
```

Then add to config:

```json
"trustedPlugins": {
  "my-org.my-plugin": "<sha256-hash>"
}
```

**`hive` not found when running as the `conductor` user**

Add the hive binary path to the `Environment=PATH=...` line in the systemd unit:

```ini
Environment=PATH=/usr/local/bin:/home/ubuntu/.local/bin:/usr/bin:/bin
```

**Metrics port already in use**

Change `observability.metricsPort` in the config and restart.
