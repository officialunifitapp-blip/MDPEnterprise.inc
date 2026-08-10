#!/bin/zsh
# Briefs every lead marked "appointment booked" that does not have one yet.
#
# The trigger is deliberately a button, not an inference. Reading meetings out
# of note text guessed wrong — "asked when the owner would be in" is not an
# appointment — and a brief written for a meeting that does not exist is worse
# than no brief. Marking the outcome is the confirmation.

cd /Users/mariodelpietro/agency || exit 1
mkdir -p prep logs

log() { echo "$1" >> logs/manager.log; }

BOOKED=$(/opt/homebrew/bin/node -e '
const fs=require("fs");
const slug=s=>s.toLowerCase().replace(/&/g," ").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
let won=false;
for(const line of fs.readFileSync("pipeline.md","utf8").split("\n")){
  if(/^##\s*Won/i.test(line))won=true;
  if(won||!line.startsWith("| "))continue;
  const c=line.split("|").map(x=>x.trim());
  if(!c[1]||c[1]==="Company")continue;
  const outs=(c[4]||"").slice(10).split(",").map(s=>s.trim());
  if(!outs.includes("appointment booked"))continue;
  const due=c[6]||"";
  const file="prep/"+(due||"undated")+"-"+slug(c[1])+".md";
  if(fs.existsSync(file))continue;      // already briefed
  console.log([c[1],due,file].join("|"));
}')

if [ -z "$BOOKED" ]; then
  log "prep: no unbriefed appointments"
  echo "no unbriefed appointments"
  exit 0
fi

echo "$BOOKED" | while IFS='|' read -r CO DUE FILE; do
  [ -z "$CO" ] && continue
  log "prep: briefing $CO ($DUE)"

  /opt/homebrew/bin/claude -p "$CO has a confirmed appointment. Write the pre-call brief.

  The date on the row is '${DUE:-not set}'. Read the note for this company in
  state.json for the day and time it was actually booked for, and if the Due
  column is empty or disagrees with the note, correct that row in pipeline.md.
  Keep the row at exactly 8 columns and change nothing else on it.

  Then:
  1. Use the call-prep subagent to research them and write the brief to $FILE.
  2. Use the prep-review subagent to review that file.
  3. If it returns REVISE, apply every numbered item and review again.
  4. Repeat until APPROVED, up to 3 rounds.
  5. If round 3 still returns REVISE, apply the notes and append a section
     '## Unresolved' listing exactly what review still objected to.

  Report one line: company, appointment date, rounds to approval, and the one
  system being recommended. Nothing else." \
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
