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
   2. Delegate to notes: push everything that changed since the last run into the
      Notion Call Log — calls logged, stage moves, and any new leads as rows.
      Notion must not be more than a day behind pipeline.md.
   3. Print the dial list for today: the specific companies to call, hottest first.
   Be brief. This runs unattended and the output goes to a log file." \
  --model claude-sonnet-5 \
  --permission-mode bypassPermissions \
  >> logs/manager.log 2>&1

echo "exit: $? at $(date '+%H:%M')" >> logs/manager.log
