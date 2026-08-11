#!/bin/zsh
# Everything that broke on 2026-08-11, turned into a check that runs in a second.
#   test/render.js   — every dashboard panel and filter renders without throwing
#   test/outcomes.js — pipeline.md write-back, including "send an email"
# Run before pushing index.html or notes-bridge.js.
cd "$(dirname "$0")/.." || exit 1
FAIL=0
echo "── shell scripts ──"
for f in *.sh; do zsh -n "$f" && echo "  OK   $f" || { echo "  FAIL $f"; FAIL=1; }; done
echo "── node syntax ──"
node --check notes-bridge.js && echo "  OK   notes-bridge.js" || FAIL=1
node -e 'const j=require("fs").readFileSync("index.html","utf8").match(/<script>([\s\S]*)<\/script>/)[1];new Function(j)' \
  && echo "  OK   index.html" || FAIL=1
echo "── render ──";   node test/render.js   || FAIL=1
echo "── outcomes ──"; node test/outcomes.js || FAIL=1
[ $FAIL -eq 0 ] && echo "\nALL GREEN" || echo "\nSOMETHING IS BROKEN"
exit $FAIL
