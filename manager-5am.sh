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

# The sourcing agent dispatches lead-research as a BACKGROUND subagent and then
# waits for it. Print mode gives background work 600 seconds and then kills the
# session — which is what "Background tasks still running after 600s;
# terminating" in this log means, twice a morning, on the step that is supposed
# to produce the leads. Sourcing has returned zero for two straight days this
# way and the RESULT line never said so, because it only reports enrichment and
# the dial list.
#
# 45 minutes, not 0. The log suggests 0 (wait forever), but a daily unattended
# job that can hang indefinitely is worse than one that gives up: nothing else
# in the morning runs until it returns.
export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=2700000

log() { echo "$1" >> logs/manager.log; }

# Row count before the agent touches anything. The RESULT line has been
# reporting enrichment and the dial list but never the one number the morning
# exists to produce, so two days of zero-lead runs both ended in a log line
# that said "ok".
ROWS_BEFORE=$(grep -c '^| ' pipeline.md 2>/dev/null || echo 0)

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
   3. Delegate to leads-manager to clean pipeline.md before anything reads it:
      stage hygiene, duplicates, franchise and network tells, contacts a call
      proved wrong, and due dates that mean nothing. It runs LAST of the three
      so the file it tidies is the one sourcing and enrichment just wrote. It
      must not hand-write the dial list.
   4. Delegate to notes: push everything that changed since the last run into the
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
#
# caffeinate on every step below, not just run_agent. These three each spawn
# their own claude process, and only the main agent was being held awake — so
# the Mac slept underneath them and both of this morning's email drafts died
# with "Your computer went to sleep mid-response".
caffeinate -ims ./prep-appointments.sh >> logs/manager.log 2>&1

# No lead should reach the dial list without a number on it. Researches the
# gaps, then moves anything still unreachable below the Won heading.
caffeinate -ims ./check-phones.sh >> logs/manager.log 2>&1

# One draft per lead the enrichment just gave an address to. Runs after
# enrichment on purpose — yesterday's new addresses are drafted this morning.
caffeinate -ims ./draft-emails.sh >> logs/manager.log 2>&1

# One line that says whether the morning worked, so the log does not have to
# be read to find out.
NAMED=$(/opt/homebrew/bin/node -e '
const l=require("fs").readFileSync("pipeline.md","utf8").split("\n");let w=false,y=0,n=0;
for(const x of l){if(/^##\s*Won/i.test(x))w=true;if(w||!x.startsWith("| "))continue;
const a=x.split("|").map(s=>s.trim());if(!a[1]||a[1]==="Company")continue;
const f=(a[2]||"").split("·")[0].trim();
(/[A-Za-z]{2}/.test(f)&&!/^\(?\d/.test(f)&&!/\.(com|net|org|co|us|in|health|bar)\b/i.test(f))?y++:n++;}
console.log(y+" named, "+n+" unnamed");')

ROWS_AFTER=$(grep -c '^| ' pipeline.md 2>/dev/null || echo 0)
SOURCED=$(( ROWS_AFTER - ROWS_BEFORE ))
[ "$SOURCED" -le 0 ] && SOURCED="0 — SOURCING PRODUCED NOTHING" || SOURCED="+$SOURCED"

log "RESULT: sourced=$SOURCED · enrichment=$STATUS · dial-list=$LIST · $NAMED · finished $(date '+%H:%M')"

# Push whatever the night produced. The bridge writes outcomes straight into
# pipeline.md the moment a lead is tapped on the phone, but nothing ever
# pushed them — so the phone kept rendering a pipeline table as old as the
# last time someone remembered to run git by hand. Outcomes were being saved
# and then not shown.
#
# Rebase before pushing: the cloud trigger commits to this same branch, so a
# straight push loses to it and the whole morning's work sits local until the
# next run. --autostash so an edit in progress is never swept into the commit.
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git -c user.name="Agency Manager" -c user.email="mariodel2005@icloud.com" \
    commit -q -m "5am: outcomes, dial list and enrichment for $(date '+%Y-%m-%d')" \
    >> logs/manager.log 2>&1 || true
fi
if git pull --rebase --autostash -q origin main >> logs/manager.log 2>&1 \
   && git push -q origin main >> logs/manager.log 2>&1; then
  log "PUSH: ok"
else
  log "PUSH: FAILED — outcomes are committed locally but the phone is showing stale data"
fi
