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
# --protocol http2 because QUIC does not survive this network. On the default
# the tunnel registers, passes every pre-check, then dies with "datagram
# handler: timeout: no recent network activity" and reconnect-loops forever —
# the process stays alive and the URL stays printed, so it looks up while
# every request from the phone returns nothing. http2 is TCP and holds.
nohup cloudflared tunnel --protocol http2 --url http://localhost:8787 > logs/tunnel.log 2>&1 &

for _ in $(seq 30); do
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' logs/tunnel.log 2>/dev/null | head -1) || true
  [ -n "${URL:-}" ] && break
  sleep 1
done
[ -z "${URL:-}" ] && { echo "Tunnel did not come up — see logs/tunnel.log"; exit 1; }

# The bridge can take a moment to bind after the old one releases the port,
# and a single check here used to fail the whole script on that race.
for _ in $(seq 15); do
  curl -sf "$URL/health" > /dev/null && break
  sleep 2
done
curl -sf "$URL/health" > /dev/null || { echo "Tunnel up but bridge not answering"; exit 1; }

# Publish the live URL so already-paired devices find the tunnel again on
# their own. This is what makes the random URL a non-event: pair a device
# once, ever. Only the URL goes in the file — never BRIDGE_KEY, which is the
# thing actually guarding the endpoint.
printf '{"url":"%s","at":"%s"}\n' "$URL" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > bridge.json
if git rev-parse --git-dir > /dev/null 2>&1; then
  # Commit this path only, so an in-progress edit elsewhere is never swept up.
  git commit -q -m "bridge: $URL" -- bridge.json > /dev/null 2>&1 || true
  if git push -q origin main > /dev/null 2>&1; then
    echo "Published tunnel URL — paired devices will reconnect on their own."
  else
    echo "NOTE: could not push bridge.json. Devices will need the pair link below."
  fi
fi

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
