#!/usr/bin/env bash
#
# Deploy plugin changes into Home Screens and restart it.
#
# Run this after editing anything under plugin/ :
#     ./deploy.sh
#
# It copies the plugin's manifest + bundle into the Home Screens data dir
# (where the display loads it from) and restarts the service. The server
# (todo-server.mjs) is run directly from this folder by its own systemd unit,
# so server edits just need:  sudo systemctl restart todo-sync
#
set -euo pipefail
cd "$(dirname "$0")"

HS=$(systemctl show home-screens -p WorkingDirectory --value)
if [ -z "$HS" ] || [ ! -d "$HS/data" ]; then
  echo "Could not find the Home Screens data dir from the systemd unit." >&2
  echo "Set it manually, e.g.:  HS=~/home-screens ./deploy.sh" >&2
  HS="${HS:-$HOME/home-screens}"
fi

DEST="$HS/data/plugins/todo-sync"
mkdir -p "$DEST/dist"
cp plugin/manifest.json "$DEST/"
cp plugin/dist/bundle.js "$DEST/dist/"
echo "Copied plugin -> $DEST"

sudo systemctl restart home-screens
echo "Restarted home-screens."
echo "Now hard-refresh the editor (Ctrl+Shift+R) and reload the display (or reboot) to pick up the new bundle."
