#!/usr/bin/env bash
# Install (or with --uninstall, remove) a systemd user timer that runs `digister run` daily at 05:30.
set -euo pipefail

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE="$UNIT_DIR/digister.service"
TIMER="$UNIT_DIR/digister.timer"

if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now digister.timer 2>/dev/null || true
  rm -f "$SERVICE" "$TIMER"
  systemctl --user daemon-reload
  echo "Removed digister.timer and digister.service"
  exit 0
fi
if [ $# -gt 0 ]; then
  echo "usage: $0 [--uninstall]" >&2
  exit 2
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$REPO/bin/digister.mjs"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not found on PATH; install Node 22 first" >&2; exit 1; }
[ -f "$BIN" ] || { echo "missing $BIN" >&2; exit 1; }
NODE="$(cd "$(dirname "$NODE")" && pwd)/$(basename "$NODE")"

HOME_DIR="${DIGISTER_HOME:-$HOME/.digister}"
LOG_DIR="$HOME_DIR/logs"
mkdir -p "$LOG_DIR" "$UNIT_DIR"

JOB_PATH="$(dirname "$NODE")"
OLLAMA="$(command -v ollama || true)"
[ -n "$OLLAMA" ] && JOB_PATH="$JOB_PATH:$(dirname "$OLLAMA")"
JOB_PATH="$JOB_PATH:/usr/local/bin:/usr/bin:/bin"

cat > "$SERVICE" <<UNIT_EOF
[Unit]
Description=Digister daily digest

[Service]
Type=oneshot
WorkingDirectory=$REPO
Environment="PATH=$JOB_PATH"
Environment="DIGISTER_HOME=$HOME_DIR"
ExecStart="$NODE" "$BIN" run
StandardOutput=append:$LOG_DIR/schedule.log
StandardError=append:$LOG_DIR/schedule.log
UNIT_EOF

cat > "$TIMER" <<'UNIT_EOF'
[Unit]
Description=Run Digister every day at 05:30

[Timer]
OnCalendar=*-*-* 05:30:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT_EOF

systemctl --user daemon-reload
systemctl --user enable --now digister.timer

echo "Installed digister.timer: digister run every day at 05:30 (output appended to $LOG_DIR/schedule.log)"
echo "Persistent=true runs a missed job when the machine next starts."
echo "To run while you are logged out: loginctl enable-linger \"$(id -un)\""
