#!/bin/zsh
# Finds every booked appointment and produces a reviewed brief for each.
#
# Appointments get written down wherever the founder was standing when he made
# them — usually the note on the lead ("Wednesday 10 AM"), not the pipeline
# column. So detection reads the notes, not just the table, and repairs the
# table when it finds a meeting the table does not know about.
#
# The review agent gates the output: nothing files until it approves, up to
# three rounds. Runs from the 5am job and by hand.

cd /Users/mariodelpietro/agency || exit 1
mkdir -p prep logs

log() { echo "$1" >> logs/manager.log; }
log "prep: starting appointment sweep"

/opt/homebrew/bin/claude -p "Find every booked appointment and produce a reviewed brief for each. Work in this order and do not skip steps.

STEP 1 — FIND THE APPOINTMENTS
Read state.json (the .notes object: one note per company, written on the phone
during or after the call) and read pipeline.md.

A lead has an appointment if EITHER source names a specific meeting: a weekday,
a date, a time, or wording like 'zoom', 'scheduled', 'set up a call',
'meeting', 'call him back at 2'. A note saying 'Wednesday 10 AM' is an
appointment. 'Cold call → demo #' is the default next action on every
untouched lead and is NOT an appointment. Neither is 'call back' with no time.

Resolve relative days against today's date. Ignore anything already in the past.

STEP 2 — REPAIR THE PIPELINE
For each appointment found only in a note, update that row in pipeline.md so
the table agrees with reality: put the meeting and its purpose in Next action,
and the resolved date in Due. Keep the row at exactly 8 columns. Change nothing
else on the row. If the table already matches, leave it alone.

STEP 3 — BRIEF EACH ONE
For each appointment in the next 3 days, the file is
prep/<due-date>-<company-slug>.md — slug is lowercase, non-alphanumerics
collapsed to single hyphens, no ampersands. If that file already exists, skip
the company entirely.

Otherwise:
  a. Use the call-prep subagent to research and write the brief to that path.
  b. Use the prep-review subagent to review the file.
  c. If it returns REVISE, apply every numbered item and review again.
  d. Repeat until APPROVED, up to 3 review rounds total.
  e. If round 3 still returns REVISE, apply the notes and append a section
     '## Unresolved' listing exactly what review still objected to.

STEP 4 — REPORT
One line per appointment: company, date, whether review approved it and in how
many rounds, and the single system being recommended. If there were no
appointments, say only that. No preamble, no summary paragraph." \
  --model claude-sonnet-5 \
  --permission-mode bypassPermissions \
  >> logs/manager.log 2>&1

RC=$?
COUNT=$(ls -1 prep/*.md 2>/dev/null | wc -l | tr -d ' ')
if [ $RC -eq 0 ]; then
  log "prep: sweep finished · $COUNT briefs on file"
else
  log "prep: sweep FAILED (exit $RC) · $COUNT briefs on file"
fi
echo "prep sweep done — $COUNT briefs on file"
