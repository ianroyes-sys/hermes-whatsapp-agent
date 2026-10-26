#!/bin/zsh
# One-command WhatsApp linking for Hermes.
# Shows a live QR in this terminal; once you scan it, this script exits on its
# own and restarts the background LaunchAgent with the fresh login.
set -e
cd "$(dirname "$0")"
LABEL="${HERMES_LAUNCHD_LABEL:-com.example.hermes-whatsapp-agent}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "Stopping background Hermes while we link…"
launchctl bootout gui/$(id -u)/"$LABEL" 2>/dev/null || true
sleep 1

echo ""
echo "On your phone: WhatsApp → Settings → Linked Devices → Link a Device"
echo "Then scan the QR that appears below (it refreshes if it expires)."
echo ""

trap '' INT
HERMES_LINK_MODE=1 node index.js || true

echo ""
if [ -f "$PLIST" ]; then
  echo "Restarting the background agent…"
  launchctl bootstrap gui/$(id -u) "$PLIST"
  echo "All set. Text /help to yourself in WhatsApp ('Message yourself' chat)."
else
  echo "Linked. No LaunchAgent at $PLIST — run 'npm start' or install launchd/hermes.plist.example."
fi
