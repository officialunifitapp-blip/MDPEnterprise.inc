#!/bin/zsh
# Makes sure no lead sits in the dial pool without a number to dial.
#
# A phoneless lead is worse than no lead: it inflates the pipeline count, it
# survives every filter, and it is discovered at the moment it was going to be
# called. 26 of 419 were in that state when this was written.
#
# Two passes, and the order matters. Research first — most missing numbers are
# findable in one page visit and deleting a real prospect to tidy a column is
# the expensive mistake. Only what survives the research gets moved out.
#
# Nothing is deleted. Rows move below the "## Won" heading, which every reader
# of this file (dial-list.js, the dashboard, prep, drafts) stops at. They are
# recoverable by moving the line back.

cd /Users/mariodelpietro/agency || exit 1
mkdir -p logs

log() { echo "$1" >> logs/manager.log; }

# Open leads with no dialable number. Stages that are already in conversation
# are exempt — someone talking to us is not a data-quality problem, and the
# number may simply live in the note rather than the column.
scan() {
  /opt/homebrew/bin/node -e '
const fs=require("fs");let won=false;
for(const line of fs.readFileSync("pipeline.md","utf8").split("\n")){
  if(/^##\s*Won/i.test(line))won=true;
  if(won||!line.startsWith("| "))continue;
  const c=line.split("|").map(x=>x.trim());
  if(!c[1]||c[1]==="Company")continue;
  const stage=(c[3]||"").toLowerCase();
  if(["lost","won","booked","contacted","replied","call held","proposal"].includes(stage))continue;
  if(/\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}/.test(c[2]||""))continue;
  console.log(c[1]);
}'
}

BEFORE=$(scan)
N=$(echo "$BEFORE" | grep -c . || true)

if [ "$N" -eq 0 ]; then
  log "phones: every open lead has a number"
  echo "every open lead has a number"
  exit 0
fi

log "phones: $N lead(s) with no number — researching"
echo "$N without a number, researching…"

# Pass 1 — try to find the real numbers. The agent may edit Column 2 and
# nothing else; it is explicitly not allowed to invent or to remove a row.
/opt/homebrew/bin/claude -p "These leads in pipeline.md have no phone number in
Column 2:

$BEFORE

Use the lead-research subagent to find the main business number for each one.
For every number you actually verify on the company's own site or a listing
that names them, write it into Column 2 of that company's row in the format
'Name (Owner) · (314) 555-1234', keeping whatever name is already there.

Rules, in order of importance:
1. Never invent or pattern-guess a number. A wrong number is a call to a
   stranger and it burns the lead permanently. Blank beats wrong.
2. Do not delete any row. Do not change any column except Column 2.
3. Keep every row at exactly 8 columns.
4. If a company appears to be closed or out of business, leave the number
   blank and say so in your report — do not act on it yourself.

Report one line per lead: company, number found or NOT FOUND, and the source." \
  --model claude-sonnet-5 \
  --permission-mode bypassPermissions \
  >> logs/manager.log 2>&1

# Pass 2 — quarantine whatever research could not fix. Plain code, because a
# row move is a mutation and it should not depend on an agent behaving.
AFTER=$(scan)
M=$(echo "$AFTER" | grep -c . || true)
log "phones: research filled $(( N - M )) of $N"

if [ "$M" -eq 0 ]; then
  echo "all $N filled by research"
  exit 0
fi

MOVED=$(/opt/homebrew/bin/node -e '
const fs=require("fs");
const names=new Set(process.argv[1].split("\n").map(s=>s.trim()).filter(Boolean));
const lines=fs.readFileSync("pipeline.md","utf8").split("\n");
const keep=[],moved=[];let won=false;
for(const line of lines){
  if(/^##\s*Won/i.test(line))won=true;
  if(!won&&line.startsWith("| ")){
    const c=line.split("|").map(x=>x.trim());
    if(c[1]&&c[1]!=="Company"&&names.has(c[1])){moved.push(line);continue;}
  }
  keep.push(line);
}
if(!moved.length){console.log("0");process.exit(0);}
let out=keep.join("\n").replace(/\s*$/,"\n");
if(!/^##\s*Unreachable/m.test(out)){
  out+="\n## Unreachable\n"
     + "<!-- No phone number could be verified. Below the Won heading, so every\n"
     + "     reader of this file stops before here. Move a row back up if a\n"
     + "     number turns up. -->\n"
     + "| Company | Contact | Stage | Last touch | Next action | Due | Niche | Email |\n"
     + "|---|---|---|---|---|---|---|---|\n";
}
// Unreachable is always the final section, so the rows go on the end.
out+=moved.join("\n")+"\n";
fs.writeFileSync("pipeline.md",out);
console.log(String(moved.length));
' "$AFTER")

log "phones: quarantined $MOVED lead(s) under ## Unreachable"
echo "researched $(( N - M )) · quarantined $MOVED with no findable number"
