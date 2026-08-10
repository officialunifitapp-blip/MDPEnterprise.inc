#!/bin/zsh
# Pre-call briefs for every booked appointment in the next 3 days.
#
# Runs from the 5am job and can be run by hand. For each appointment it sends
# call-prep to research and write, then prep-review to try to kill it, then
# revises once and files. Two agents because the first one wants to be helpful
# and the second one's job is to stop that being expensive.

cd /Users/mariodelpietro/agency || exit 1
mkdir -p prep logs

log() { echo "$1" >> logs/manager.log; }

# Appointments come out of pipeline.md: a Next action that names a meeting,
# with a Due date inside the window. One line per appointment, pipe-separated.
APPTS=$(/opt/homebrew/bin/node -e '
const fs=require("fs");
const days=n=>{const d=new Date();d.setDate(d.getDate()+n);return d.toISOString().slice(0,10);};
const today=days(0), limit=days(3);
let won=false;
for(const line of fs.readFileSync("pipeline.md","utf8").split("\n")){
  if(/^##\s*Won/i.test(line))won=true;
  if(won||!line.startsWith("| "))continue;
  const c=line.split("|").map(x=>x.trim());
  if(!c[1]||c[1]==="Company")continue;
  const next=c[5]||"", due=c[6]||"";
  if(/cold call/i.test(next))continue;
  if(!/zoom|meeting|appt\b|appointment|scheduled|call with|demo call|consult/i.test(next))continue;
  if(!(due>=today&&due<=limit))continue;
  console.log([c[1],next,due].join("|"));
}')

if [ -z "$APPTS" ]; then
  log "prep: no appointments in the next 3 days"
  echo "no appointments in the next 3 days"
  exit 0
fi

echo "$APPTS" | while IFS='|' read -r CO NEXT DUE; do
  [ -z "$CO" ] && continue
  SLUG=$(echo "$CO" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\+/-/g;s/^-//;s/-$//')
  FILE="prep/${DUE}-${SLUG}.md"

  if [ -f "$FILE" ]; then
    log "prep: $CO already briefed ($FILE)"
    continue
  fi

  log "prep: briefing $CO for $DUE"
  /opt/homebrew/bin/claude -p "There is a booked appointment: $CO — \"$NEXT\" — due $DUE.

  1. Use the call-prep subagent to research them and write the brief to $FILE.
  2. Then use the prep-review subagent to review that file.
  3. If prep-review returns REVISE, apply every numbered item and re-run
     prep-review once more.
  4. If it still returns REVISE, apply the notes anyway and append a section
     titled '## Unresolved' listing what review still objected to.

  The brief must end up at $FILE. Report only: the company, whether review
  approved it, and the one system being recommended. Nothing else." \
    --model claude-sonnet-5 \
    --permission-mode bypassPermissions \
    >> logs/manager.log 2>&1

  if [ -f "$FILE" ]; then
    log "prep: filed $FILE"
    echo "filed $FILE"
  else
    log "prep: FAILED to produce $FILE for $CO"
    echo "failed: $CO"
  fi
done
