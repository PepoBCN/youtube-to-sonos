#!/bin/bash
# Installs the YouTube to Sonos companion as a launchd agent that starts at login
# and restarts itself if it stops. Safe to run again (for example after a node upgrade).
set -euo pipefail

LABEL="com.youtube-to-sonos.companion"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/youtube-to-sonos.log"
PORT=8787

# 1. Find a stable node binary (not an fnm per-shell shim that disappears).
NODE=""
if [ -x /opt/homebrew/bin/node ]; then
  NODE=/opt/homebrew/bin/node
else
  FOUND="$(command -v node || true)"
  if [ -z "$FOUND" ]; then
    echo "Node isn't installed or isn't on PATH. Install Node 24 first." >&2
    exit 1
  fi
  NODE="$(realpath "$FOUND")"
fi
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "Node $NODE_MAJOR found at $NODE, but Node 24 or newer is needed." >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE")"

# 2. yt-dlp and ffmpeg.
for tool in /opt/homebrew/bin/yt-dlp /opt/homebrew/bin/ffmpeg; do
  if [ ! -x "$tool" ]; then
    echo "Missing $tool. Install it with: brew install $(basename "$tool")" >&2
    exit 1
  fi
done

echo "Node:    $NODE ($("$NODE" -v))"
echo "Folder:  $DIR"

# 3. Stop any running copy and free the port.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 1
PIDS="$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$PIDS" ]; then
  echo "Stopping whatever was using port $PORT (pid $PIDS)"
  kill $PIDS 2>/dev/null || true
  sleep 1
fi

# 4. Write the plist from the template.
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s#__NODE__#$NODE#g" \
    -e "s#__NODE_DIR__#$NODE_DIR#g" \
    -e "s#__DIR__#$DIR#g" \
    -e "s#__HOME__#$HOME#g" \
    "$DIR/$LABEL.plist" > "$PLIST_DEST"
plutil -lint "$PLIST_DEST" >/dev/null

# 5. Load and start it.
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"
launchctl kickstart "gui/$(id -u)/$LABEL" 2>/dev/null || true  # no-op if RunAtLoad already started it

# 6. Wait for it to answer.
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "Running: $(curl -fsS "http://127.0.0.1:$PORT/api/health")"
    echo "Log:     $LOG"
    exit 0
  fi
  sleep 0.5
done
echo "It was installed but isn't answering on port $PORT yet. Check the log: $LOG" >&2
tail -n 20 "$LOG" >&2 || true
exit 1
