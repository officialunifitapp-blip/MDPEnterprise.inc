#!/bin/zsh
# Depop Resale Scout — browser watcher. DORMANT until you load the launchd job.
#
#   launchctl load ~/Library/LaunchAgents/com.mdp.agency.scout.plist    # start
#   launchctl unload ~/Library/LaunchAgents/com.mdp.agency.scout.plist  # stop
#
# This drives YOUR Chrome with YOUR Depop session — it is not a scraper and does
# not evade anything. It reads a page you are already logged into, the way you
# would, and hands what it finds to the bridge for scoring.
#
# It never messages a seller, makes an offer, or buys. Buying stays manual.
#
# Requires: Chrome open, logged into Depop, Mac awake, bridge running,
# and scout-config.json to have a watchUrl.

cd /Users/mariodelpietro/agency || exit 1
mkdir -p logs

STAMP=$(date "+%Y-%m-%d %H:%M")
LOG=logs/scout.log

WATCH=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync("scout-config.json","utf8")).watchUrl||"")}catch(e){console.log("")}')
if [ -z "$WATCH" ]; then
  echo "$STAMP  no watchUrl set in scout-config.json — nothing to watch" >> $LOG
  exit 0
fi

# Bridge must be up; without it there is nowhere to send findings.
if ! curl -s -m 5 -o /dev/null http://localhost:8787/health; then
  echo "$STAMP  bridge offline — skipping this run" >> $LOG
  exit 0
fi

echo "\n===== $STAMP =====" >> $LOG

# caffeinate keeps the Mac awake for the duration of this run only — it does not
# stop the machine sleeping between runs.
/usr/bin/caffeinate -i /opt/homebrew/bin/claude -p \
  "Use Chrome to open this Depop search page: $WATCH

   Read the listings visible on that page. For each one collect: title, brand,
   size, condition, price, shipping cost, image URL, and the listing URL
   (which looks like https://www.depop.com/products/<id>/).

   Then POST them to the local bridge as JSON:
     curl -s -X POST http://localhost:8787/scout/ingest \
       -H 'Content-Type: application/json' \
       -d '{\"listings\":[ ... ]}'

   Rules:
   - Read only. Do not click Buy, Make Offer, or Message. Do not contact anyone.
   - Do not reload repeatedly or open more than the one search page.
   - If Chrome is not logged into Depop, or the page did not load, write exactly
     NOT_LOGGED_IN and stop — do not try to log in.
   - Reply with one line: how many listings you sent, or NOT_LOGGED_IN." \
  --model claude-sonnet-5 \
  --permission-mode bypassPermissions \
  >> $LOG 2>&1

echo "exit: $? at $(date '+%H:%M')" >> $LOG
