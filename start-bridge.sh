#!/usr/bin/env bash
# Bridge + tunnel. Run this once after a reboot; the phone needs both alive.
#
# The tunnel is a Cloudflare quick tunnel, so the URL is random and changes
# every restart. That is the price of not owning a domain. When it changes,
# re-pair the phone with the link this script prints.
set -euo pipefail
cd "$(dirname "$0")"

set -a; . ./.env.local; set +a
: "${BRIDGE_KEY:?BRIDGE_KEY missing from .env.local}"

pkill -f "node notes-bridge.js" 2>/dev/null || true
pkill -f "cloudflared tunnel --url" 2>/dev/null || true
sleep 1

nohup node notes-bridge.js > logs/bridge.log 2>&1 &
nohup cloudflared tunnel --url http://localhost:8787 > logs/tunnel.log 2>&1 &

for _ in $(seq 30); do
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' logs/tunnel.log 2>/dev/null | head -1) || true
  [ -n "${URL:-}" ] && break
  sleep 1
done
[ -z "${URL:-}" ] && { echo "Tunnel did not come up — see logs/tunnel.log"; exit 1; }

curl -sf "$URL/health" > /dev/null || { echo "Tunnel up but bridge not answering"; exit 1; }

echo
echo "Bridge:  http://localhost:8787"
echo "Tunnel:  $URL"
echo
PAIR="https://officialunifitapp-blip.github.io/MDPEnterprise.inc/?bridge=$URL&key=$BRIDGE_KEY"
echo "Pair the phone — scan the QR, or open this once in the phone's browser:"
echo "$PAIR"
echo
# The key is 48 hex characters. Nobody is retyping that off a screen.
if command -v qrencode > /dev/null; then
  qrencode -t ANSIUTF8 -l M "$PAIR"
else
  echo "(brew install qrencode for a scannable code)"
fi
