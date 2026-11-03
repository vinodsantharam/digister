#!/usr/bin/env bash
# Install (or with --uninstall, remove) a LaunchAgent that runs `digister run` daily at 05:30.
set -euo pipefail

LABEL="com.digister.run"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL"
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
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

# PATH for the job: Node's folder, Ollama's folder if found, then the usual places.
JOB_PATH="$(dirname "$NODE")"
OLLAMA="$(command -v ollama || true)"
[ -n "$OLLAMA" ] && JOB_PATH="$JOB_PATH:$(dirname "$OLLAMA")"
JOB_PATH="$JOB_PATH:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>$(xml "$BIN")</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml "$REPO")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml "$JOB_PATH")</string>
    <key>DIGISTER_HOME</key>
    <string>$(xml "$HOME_DIR")</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>5</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$(xml "$LOG_DIR")/schedule.log</string>
  <key>StandardErrorPath</key>
  <string>$(xml "$LOG_DIR")/schedule.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"

echo "Installed $LABEL: digister run every day at 05:30 (output appended to $LOG_DIR/schedule.log)"
echo "A Mac that is asleep at 05:30 runs the job when it wakes. To wake it at 05:25, run this yourself:"
echo "  sudo pmset repeat wakeorpoweron MTWRFSU 05:25:00"
