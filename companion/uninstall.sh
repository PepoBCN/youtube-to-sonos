#!/bin/bash
# Stops the YouTube to Sonos companion and removes it from launchd.
# The audio cache is kept unless you pass --delete-cache.
set -euo pipefail

LABEL="com.youtube-to-sonos.companion"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
CACHE="$HOME/Library/Caches/youtube-to-sonos"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "Stopped $LABEL" || echo "$LABEL wasn't running"
if [ -f "$PLIST_DEST" ]; then
  rm "$PLIST_DEST"
  echo "Removed $PLIST_DEST"
fi

if [ "${1:-}" = "--delete-cache" ]; then
  rm -rf "$CACHE"
  echo "Deleted the audio cache at $CACHE"
else
  echo "Kept the audio cache at $CACHE (run with --delete-cache to remove it)"
fi
