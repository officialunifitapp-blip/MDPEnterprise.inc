#!/bin/zsh
# The Manager's 5:00 run. Fired by launchd — see
# ~/Library/LaunchAgents/com.mdp.agency.manager.plist
#
# Runs unattended, so permissions are bypassed. The prompt is fixed and lives
# here, not passed in from anywhere: nothing outside this file decides what the
# 5am job does.
#
# Two failures shaped this script. The Mac is waking from sleep at 5:00 and the
# network is not up yet, so the first API call dies mid-response. And when the
# agent died, the whole morning produced nothing at all — no list, no signal,
# and the log had to be read to find out. So: wait for the network, retry once,
# and build the dial list with plain code afterwards either way.

cd /Users/mariodelpietro/agency || exit 1
mkdir -p logs

log() { echo "$1" >> logs/manager.log; }

log "\n===== $(date '+%Y-%m-%d %H:%M') ====="

# Wait up to 5 minutes for the network. A wake-from-sleep run that starts
# before Wi-Fi associates fails every time.
for i in $(seq 1 30); do
  if curl -s --max-time 5 -o /dev/null https://api.anthropic.com/ 2>/dev/null; then break; fi
  [ "$i" = "1" ] && log "waiting for network…"
  sleep 10
done
if ! curl -s --max-time 5 -o /dev/null https://api.anthropic.com/ 2>/dev/null; then
  log "NETWORK: never came up after 5 minutes — skipping enrichment"
else
  log "network up after $(( (i-1) * 10 ))s"
fi

PROMPT="NOBODY IS READING THIS. You are running unattended at 5am and your
   output goes to a log file. There is no one to answer a question. Do not ask
   one, do not offer options, do not pause for confirmation, do not stop before
   a step to check. Every judgement call is yours to make and act on. If
   something is ambiguous, pick the option that produces leads and say in one
   line what you picked.

   This instruction exists because ten consecutive runs produced zero new leads
   while the agent asked whether it should source them.

   Run the 5:00 Manager routine from CLAUDE.md, in order:
   1. Delegate to lead-research for today's new prospects. Add them to
      pipeline.md. TARGET: at least 150 new restoration companies with a real
      phone number, every day, until pipeline.md holds 1000+ never-called leads.
      This is the number the whole business runs on — 150 dials a day eats 150
      leads a day, so anything less than 150 sourced is the pipeline shrinking.
      Do not stop at 5 or 10 because a city looks covered. Widen the map
      instead: MO, KS, IL, IA, AR, OK, NE, WI, MN, TN, TX. Work outward from
      St. Louis. If one metro is exhausted, move to the next and say which.
      Never invent a phone number — a lead without one is not a lead.
   2. Delegate to lead-research to enrich up to 15 leads, filling BOTH the
      owner/manager name in Column 2 and the Email column in the same visit —
      they come off the same about/contact page, so do not make two trips.
      Prioritise leads that have already been dialled and hit a gatekeeper.
      Then the rest, missing-both first. Skip any lead whose Niche is Other.
      Never guess an address and never guess a person. Blank beats wrong.
   3. Delegate to notes: push everything that changed since the last run into the
      Notion Call Log — calls logged, stage moves, and any new leads as rows.
   Do not print a dial list; that is generated separately.
   Be brief. This runs unattended and the output goes to a log file."

run_agent() {
  # The run takes the better part of an hour and the Mac falls asleep
  # mid-response. caffeinate holds it awake for exactly as long as the agent
  # is running and lets it sleep again the moment it finishes.
  caffeinate -ims /opt/homebrew/bin/claude -p "$PROMPT" \
    --model claude-sonnet-5 \
    --permission-mode bypassPermissions \
    >> logs/manager.log 2>&1
}

STATUS=fail
if curl -s --max-time 5 -o /dev/null https://api.anthropic.com/ 2>/dev/null; then
  if run_agent; then
    STATUS=ok
  else
    log "--- first attempt failed, retrying in 60s ---"
    sleep 60
    if run_agent; then STATUS="ok (on retry)"; fi
  fi
fi

# Always runs, agent or no agent. Plain code, no API, cannot fail for the
# reasons the agent fails.
/opt/homebrew/bin/node dial-list.js >> logs/manager.log 2>&1 \
  && LIST=ok || LIST=fail

# Briefs for anything booked in the next 3 days. Also safe to run by hand.
./prep-appointments.sh >> logs/manager.log 2>&1

# No lead should reach the dial list without a number on it. Researches the
# gaps, then moves anything still unreachable below the Won heading.
./check-phones.sh >> logs/manager.log 2>&1

# One draft per lead the enrichment just gave an address to. Runs after
# enrichment on purpose — yesterday's new addresses are drafted this morning.
./draft-emails.sh >> logs/manager.log 2>&1

# One line that says whether the morning worked, so the log does not have to
# be read to find out.
NAMED=$(/opt/homebrew/bin/node -e '
const l=require("fs").readFileSync("pipeline.md","utf8").split("\n");let w=false,y=0,n=0;
for(const x of l){if(/^##\s*Won/i.test(x))w=true;if(w||!x.startsWith("| "))continue;
const a=x.split("|").map(s=>s.trim());if(!a[1]||a[1]==="Company")continue;
const f=(a[2]||"").split("·")[0].trim();
(/[A-Za-z]{2}/.test(f)&&!/^\(?\d/.test(f)&&!/\.(com|net|org|co|us|in|health|bar)\b/i.test(f))?y++:n++;}
console.log(y+" named, "+n+" unnamed");')

log "RESULT: enrichment=$STATUS · dial-list=$LIST · $NAMED · finished $(date '+%H:%M')"
