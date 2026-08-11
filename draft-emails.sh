#!/bin/zsh
# Writes one ready-to-send email per lead that has a real address.
#
# The queue is the Email column, not a guess. 419 leads are in pipeline.md and
# 7 of them have an address — so this is not the outreach channel yet, it is
# the thing that stops the 7 from going to waste while enrichment fills the
# rest. Every lead the 5am run enriches lands here the next morning.
#
# Leads tapped "send an email" with no address are not drafted and not
# silently dropped: they are printed as blocked, because the fix for them is
# research, not writing.

cd /Users/mariodelpietro/agency || exit 1
mkdir -p drafts logs

log() { echo "$1" >> logs/manager.log; }

SCAN=$(/opt/homebrew/bin/node -e '
const fs=require("fs");
const slug=s=>s.toLowerCase().replace(/&/g," ").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
let won=false;
for(const line of fs.readFileSync("pipeline.md","utf8").split("\n")){
  if(/^##\s*Won/i.test(line))won=true;
  if(won||!line.startsWith("| "))continue;
  const c=line.split("|").map(x=>x.trim());
  if(!c[1]||c[1]==="Company")continue;
  const stage=(c[3]||"").toLowerCase();
  if(stage==="lost"||stage==="won")continue;          // do not email a closed file
  const outs=(c[4]||"").slice(10).split(",").map(s=>s.trim());
  const email=(c[8]||"").trim();
  const asked=outs.includes("send an email");
  if(!/@/.test(email)){ if(asked)console.log(["BLOCKED",c[1],"",""].join("\t")); continue; }
  const file="drafts/"+slug(c[1])+".md";
  if(fs.existsSync(file))continue;                    // already drafted
  console.log(["DRAFT",c[1],email,file].join("\t"));
}')

DRAFTS=$(echo "$SCAN" | grep "^DRAFT" || true)
BLOCKED=$(echo "$SCAN" | grep "^BLOCKED" || true)

if [ -n "$BLOCKED" ]; then
  N=$(echo "$BLOCKED" | wc -l | tr -d ' ')
  log "drafts: $N lead(s) marked 'send an email' with no address — needs enrichment, not drafting"
  echo "$BLOCKED" | while IFS=$'\t' read -r _ CO _ _; do
    [ -n "$CO" ] && echo "blocked (no address): $CO"
  done
fi

if [ -z "$DRAFTS" ]; then
  log "drafts: nothing to write"
  echo "nothing to draft"
  exit 0
fi

echo "$DRAFTS" | while IFS=$'\t' read -r _ CO EMAIL FILE; do
  [ -z "$CO" ] && continue
  log "drafts: writing $CO <$EMAIL>"

  /opt/homebrew/bin/claude -p "Use the email-drafter subagent to write the cold
  email for '$CO'.

  The address in the Email column of pipeline.md is '$EMAIL'. Use exactly that
  string. Do not look for a different one and do not correct it.

  Write the draft to $FILE in the exact format the agent file specifies.
  Personalise it on something real about this company — read their row in
  pipeline.md and any file in leads/ that mentions them. If there is no
  specific signal to open on, say so in a NEEDS: line rather than inventing
  one or falling back to a generic opener.

  Change nothing else. Do not edit pipeline.md.

  Report one line: company, address used, touch number, signal." \
    --model claude-sonnet-5 \
    --permission-mode bypassPermissions \
    >> logs/manager.log 2>&1

  if [ -f "$FILE" ]; then
    log "drafts: filed $FILE"
    echo "filed $FILE"
  else
    log "drafts: FAILED to produce $FILE for $CO"
    echo "failed: $CO"
  fi
done
