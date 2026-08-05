#!/usr/bin/env bash
# Print the pairing link and a QR for it.
#
# The hostname is reserved on the ngrok account, so unlike the quick tunnel it
# replaced, this address survives reboots. You should only ever need this once
# per device — it is here for a new phone, or a browser whose storage got
# cleared.
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env.local; set +a

HOST=handsaw-squid-faceless.ngrok-free.dev

curl -sf --max-time 10 "https://$HOST/health" > /dev/null || {
  echo "Bridge is not answering at $HOST."
  echo "Check: launchctl list | grep mdp.agency"
  exit 1
}

PAIR="https://officialunifitapp-blip.github.io/MDPEnterprise.inc/?bridge=https://$HOST&key=$BRIDGE_KEY"
printf '%s' "$PAIR" | pbcopy
echo
echo "$PAIR"
echo
echo "(copied to clipboard)"
command -v qrencode > /dev/null && qrencode -t ANSIUTF8 -l M "$PAIR"
