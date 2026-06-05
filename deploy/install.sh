#!/usr/bin/env bash
# Conductor installation script for Linux servers.
# Run as root or a user with sudo privileges.
set -euo pipefail

CONDUCTOR_REPO="${CONDUCTOR_REPO:-https://github.com/colonyops/conductor.git}"
CONDUCTOR_DIR="${CONDUCTOR_DIR:-/opt/conductor}"
CONDUCTOR_USER="${CONDUCTOR_USER:-conductor}"
CONDUCTOR_DATA_DIR="${CONDUCTOR_DATA_DIR:-/var/lib/conductor}"
CONDUCTOR_LOG_DIR="${CONDUCTOR_LOG_DIR:-/var/log/conductor}"
CONDUCTOR_CONFIG_DIR="${CONDUCTOR_CONFIG_DIR:-/etc/conductor}"

log() { echo "[conductor-install] $*"; }
die() { echo "[conductor-install] ERROR: $*" >&2; exit 1; }

require_root() {
  if [[ $EUID -ne 0 ]]; then
    die "This script must be run as root (or via sudo)"
  fi
}

# ── Dependency checks ─────────────────────────────────────────────────────────

install_bun() {
  if command -v bun &>/dev/null; then
    log "bun $(bun --version) already installed"
    return
  fi
  log "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  # Add to PATH for the remainder of this script
  export PATH="$HOME/.bun/bin:$PATH"
  bun --version || die "bun installation failed"
}

check_hive() {
  if ! command -v hive &>/dev/null; then
    die "hive CLI not found on PATH. Install it before running this script."
  fi
  log "hive $(hive --version 2>/dev/null || echo '(version unknown)') found"
}

check_git() {
  command -v git &>/dev/null || die "git is required but not installed"
}

# ── System user and directories ───────────────────────────────────────────────

create_user() {
  if id "$CONDUCTOR_USER" &>/dev/null; then
    log "User $CONDUCTOR_USER already exists"
    return
  fi
  log "Creating system user $CONDUCTOR_USER..."
  useradd --system --no-create-home --shell /usr/sbin/nologin "$CONDUCTOR_USER"
}

create_dirs() {
  log "Creating directories..."
  for dir in "$CONDUCTOR_DATA_DIR" "$CONDUCTOR_LOG_DIR" "$CONDUCTOR_CONFIG_DIR"; do
    mkdir -p "$dir"
    chown "$CONDUCTOR_USER:$CONDUCTOR_USER" "$dir"
    chmod 750 "$dir"
  done
}

# ── Clone / update repository ─────────────────────────────────────────────────

install_conductor() {
  if [[ -d "$CONDUCTOR_DIR/.git" ]]; then
    log "Updating existing install at $CONDUCTOR_DIR..."
    git -C "$CONDUCTOR_DIR" fetch --quiet
    git -C "$CONDUCTOR_DIR" reset --hard "@{u}"
  else
    log "Cloning conductor to $CONDUCTOR_DIR..."
    git clone "$CONDUCTOR_REPO" "$CONDUCTOR_DIR"
  fi
  chown -R "$CONDUCTOR_USER:$CONDUCTOR_USER" "$CONDUCTOR_DIR"

  log "Installing Node dependencies..."
  (cd "$CONDUCTOR_DIR" && sudo -u "$CONDUCTOR_USER" bun install --frozen-lockfile)
}

# ── systemd service ───────────────────────────────────────────────────────────

install_service() {
  local unit_src="$CONDUCTOR_DIR/deploy/conductor.service"
  local unit_dst="/etc/systemd/system/conductor.service"

  if [[ ! -f "$unit_src" ]]; then
    die "Unit file not found at $unit_src"
  fi

  log "Installing systemd unit..."
  cp "$unit_src" "$unit_dst"
  # Patch data/log paths to the configured directories
  sed -i "s|/var/lib/conductor|$CONDUCTOR_DATA_DIR|g" "$unit_dst"
  sed -i "s|ReadWritePaths=.*|ReadWritePaths=$CONDUCTOR_DATA_DIR $CONDUCTOR_LOG_DIR $CONDUCTOR_CONFIG_DIR|" "$unit_dst"

  systemctl daemon-reload
  systemctl enable conductor
  log "conductor.service enabled"
}

# ── Config scaffold ───────────────────────────────────────────────────────────

scaffold_config() {
  local cfg="$CONDUCTOR_CONFIG_DIR/conductor.config.json"
  if [[ -f "$cfg" ]]; then
    log "Config already exists at $cfg — skipping scaffold"
    return
  fi
  log "Writing starter config to $cfg..."
  cat > "$cfg" <<'EOF'
{
  "concurrency": { "global": 5 },
  "observability": {
    "metricsPort": 9090,
    "logPath": "/var/log/conductor/conductor.log",
    "logMaxBytes": 10485760,
    "logMaxBackups": 5,
    "logFormat": "json"
  },
  "idleTimeoutMs": 600000,
  "plugins": [],
  "trustedPlugins": {},
  "builtins": {}
}
EOF
  chown "$CONDUCTOR_USER:$CONDUCTOR_USER" "$cfg"
  chmod 640 "$cfg"
}

# ── Main ──────────────────────────────────────────────────────────────────────

require_root
check_git
install_bun
check_hive
create_user
create_dirs
install_conductor
scaffold_config
install_service

log ""
log "Installation complete."
log ""
log "Next steps:"
log "  1. Edit $CONDUCTOR_CONFIG_DIR/conductor.config.json"
log "  2. Start: systemctl start conductor"
log "  3. Check: systemctl status conductor"
log "  4. Logs:  journalctl -u conductor -f"
