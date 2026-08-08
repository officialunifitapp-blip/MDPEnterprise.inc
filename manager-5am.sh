#!/bin/zsh
# The Manager's 5:00 run. Fired by launchd — see
# ~/Library/LaunchAgents/com.mdp.agency.manager.plist
#
# Runs unattended, so permissions are bypassed. The prompt is fixed and lives
# here, not passed in from anywhere: nothing outside this file decides what the
# 5am job does.

cd /Users/mariodelpietro/agency || exit 1
mkdir -p logs

STAMP=$(date "+%Y-%m-%d %H:%M")
echo "\n===== $STAMP =====" >> logs/manager.log

/opt/homebrew/bin/claude -p \
  "Run the 5:00 Manager routine from CLAUDE.md, in order:
   1. Delegate to lead-research for today's new prospects. Add them to pipeline.md.
   2. Delegate to lead-research to enrich up to 15 leads, filling BOTH the
      owner/manager name in Column 2 and the Email column in the same visit —
      they come off the same about/contact page, so do not make two trips.
      Prioritise leads that have already been dialled and hit a gatekeeper:
      those are the ones a name unblocks. Then the rest, missing-both first.
      Never guess an address and never guess a person. Blank beats wrong: a
      fabricated name burns the call, a fabricated address burns the domain.
      Skip any lead whose Niche is Other.
      Report how many names and how many emails were filled, and how many of
      each remain blank.
   3. Delegate to notes: push everything that changed since the last run into the
      Notion Call Log — calls logged, stage moves, and any new leads as rows.
      Notion must not be more than a day behind pipeline.md.
   4. Print the dial list for today: the specific companies to call, hottest first.
   Be brief. This runs unattended and the output goes to a log file." \
  --model claude-sonnet-5 \
  --permission-mode bypassPermissions \
  >> logs/manager.log 2>&1

echo "exit: $? at $(date '+%H:%M')" >> logs/manager.log
