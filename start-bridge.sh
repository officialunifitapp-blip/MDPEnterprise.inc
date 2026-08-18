#!/usr/bin/env bash
# Verify the bridge and publish its address. Safe to run any time, any number
# of times.
#
# There is nothing to "start" here any more. launchd owns both halves and both
# are KeepAlive, so they survive reboots, crashes and the Mac going to sleep:
#
#   com.mdp.agency.bridge   node notes-bridge.js        (localhost:8787)
#   com.mdp.agency.tunnel   ngrok on a reserved domain  (permanent hostname)
#
# What this script does is check they are actually answering, republish
# bridge.json, and print the pair link.
#
# The previous version of this file started a Cloudflare *quick* tunnel, whose
# hostname is random and stops resolving within a day, and then wrote that
# dying hostname into bridge.json. That is exactly how Monday's calls were
# lost: the phone fetched bridge.json, got a hostname that no longer resolved,
# and queued every note in the browser where nothing could read them. The
# scoreboard understated the whole week as a result.
#
# Never publish a quick-tunnel URL from this file again. The reserved ngrok
# domain below is the only address the phone should ever be told about.
set -euo pipefail
cd "$(dirname "$0")"

set -a; . ./.env.local; set +a
: "${BRIDGE_KEY:?BRIDGE_KEY missing from .env.local}"

HOST="https://handsaw-squid-faceless.ngrok-free.dev"

# Nudge a launch agent only if it is not answering. kickstart -k restarts it
# even when launchd still believes it is alive, which is the case that used to
# need a reboot.
kick() {
  launchctl kickstart -k "gui/$(id -u)/$1" > /dev/null 2>&1 || true
}

echo -n "bridge (localhost:8787) ... "
if curl -sf --max-time 5 http://localhost:8787/health > /dev/null; then
  echo "up"
else
  echo "down — restarting"
  kick com.mdp.agency.bridge
  for _ in $(seq 15); do
    curl -sf --max-time 5 http://localhost:8787/health > /dev/null && break
    sleep 2
  done
  curl -sf --max-time 5 http://localhost:8787/health > /dev/null \
    || { echo "Bridge still not answering — see logs/bridge.log"; exit 1; }
  echo "bridge recovered"
fi

echo -n "tunnel ($HOST) ... "
if curl -sf --max-time 10 "$HOST/health" > /dev/null; then
  echo "up"
else
  echo "down — restarting"
  kick com.mdp.agency.tunnel
  for _ in $(seq 20); do
    curl -sf --max-time 5 "$HOST/health" > /dev/null && break
    sleep 3
  done
  curl -sf --max-time 10 "$HOST/health" > /dev/null \
    || { echo "Tunnel still not answering — see logs/tunnel.log"; exit 1; }
  echo "tunnel recovered"
fi

# Only published after both checks pass, so bridge.json can never again point
# at something that is not answering. Only the URL goes in the file — never
# BRIDGE_KEY, which is the thing actually guarding the endpoint.
printf '{"url":"%s","at":"%s"}\n' "$HOST" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > bridge.json

if git rev-parse --git-dir > /dev/null 2>&1; then
  if ! git diff --quiet -- bridge.json; then
    # Commit this path only, so an in-progress edit elsewhere is never swept up.
    git commit -q -m "bridge: republish $HOST" -- bridge.json > /dev/null 2>&1 || true
    git push -q origin main > /dev/null 2>&1 \
      && echo "Republished bridge.json — paired devices reconnect on their own." \
      || echo "NOTE: could not push bridge.json. Use the pair link below."
  else
    echo "bridge.json already correct — nothing to publish."
  fi
fi

echo
echo "Bridge:  http://localhost:8787"
echo "Tunnel:  $HOST"
echo
PAIR="https://officialunifitapp-blip.github.io/MDPEnterprise.inc/?bridge=$HOST&key=$BRIDGE_KEY"
echo "The phone is already paired to this hostname and stays paired — it does"
echo "not change. Only use the link below on a NEW device:"
echo "$PAIR"
echo
# The key is 48 hex characters. Nobody is retyping that off a screen.
if command -v qrencode > /dev/null; then
  qrencode -t ANSIUTF8 -l M "$PAIR"
else
  echo "(brew install qrencode for a scannable code)"
fi
