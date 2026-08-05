#!/usr/bin/env bash
# Swap the random quick tunnel for a named tunnel on a domain you own.
#
#   ./setup-domain.sh bridge.yourdomain.com
#
# Run `cloudflared tunnel login` first — this needs the certificate that
# command writes to ~/.cloudflared/cert.pem.
set -euo pipefail
cd "$(dirname "$0")"

HOST="${1:-}"
[ -z "$HOST" ] && { echo "Usage: ./setup-domain.sh bridge.yourdomain.com"; exit 1; }
[ -f "$HOME/.cloudflared/cert.pem" ] || { echo "Run: cloudflared tunnel login"; exit 1; }

NAME=mdp-bridge

# Reuse the tunnel if it already exists — re-running this must not strand the
# old one, which would keep the DNS record pointing at a tunnel nothing runs.
if cloudflared tunnel list | grep -q " $NAME "; then
  echo "Reusing existing tunnel $NAME"
else
  cloudflared tunnel create "$NAME"
fi
ID=$(cloudflared tunnel list | awk -v n="$NAME" '$2==n{print $1}')
[ -z "$ID" ] && { echo "Could not resolve the tunnel id"; exit 1; }

cloudflared tunnel route dns --overwrite-dns "$NAME" "$HOST"

mkdir -p "$HOME/.cloudflared"
cat > "$HOME/.cloudflared/config.yml" <<YML
tunnel: $ID
credentials-file: $HOME/.cloudflared/$ID.json

ingress:
  - hostname: $HOST
    service: http://localhost:8787
  - service: http_status:404
YML

# Point the launch agent at the named tunnel instead of --url.
PLIST="$HOME/Library/LaunchAgents/com.mdp.agency.tunnel.plist"
/usr/libexec/PlistBuddy -c "Delete :ProgramArguments" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :ProgramArguments array" "$PLIST"
i=0
for a in /opt/homebrew/bin/cloudflared tunnel run "$NAME"; do
  /usr/libexec/PlistBuddy -c "Add :ProgramArguments:$i string $a" "$PLIST"; i=$((i+1))
done

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "Waiting for $HOST ..."
for _ in $(seq 30); do
  curl -sf --max-time 5 "https://$HOST/health" > /dev/null && break
  sleep 2
done
curl -sf --max-time 5 "https://$HOST/health" > /dev/null || { echo "Not answering yet — DNS can take a minute. Retry: curl https://$HOST/health"; exit 1; }

set -a; . ./.env.local; set +a
PAIR="https://officialunifitapp-blip.github.io/MDPEnterprise.inc/?bridge=https://$HOST&key=$BRIDGE_KEY"
printf '%s' "$PAIR" | pbcopy
echo
echo "$HOST is live and permanent."
echo
echo "$PAIR"
echo "(copied to clipboard — tap this on the phone once, and never again)"
command -v qrencode > /dev/null && qrencode -t ANSIUTF8 -l M "$PAIR"
