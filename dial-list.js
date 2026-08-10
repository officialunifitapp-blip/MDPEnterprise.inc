#!/usr/bin/env node
/*
 * Today's dial list, computed from pipeline.md.
 *
 * Deliberately not an agent. The 5am subagents fail on network flakiness and
 * API hiccups, and when they do the list has to exist anyway — a morning with
 * no list is a morning of scrolling 414 rows. This is plain code: it cannot
 * hit a rate limit and cannot decide to do something else.
 *
 *   node dial-list.js            writes leads/dial-today.md and prints a summary
 */

const fs = require("fs");
const path = require("path");

const today = () => new Date().toISOString().slice(0, 10);

function leads() {
  const out = [];
  let won = false;
  for (const line of fs.readFileSync(path.join(__dirname, "pipeline.md"), "utf8").split("\n")) {
    if (/^##\s*Won/i.test(line)) won = true;
    if (won || !line.startsWith("| ")) continue;
    const c = line.split("|").map(x => x.trim());
    if (!c[1] || c[1] === "Company") continue;
    const m = (c[2] || "").match(/\(?(\d{3})\)?[ .-]?(\d{3})[ .-]?(\d{4})/);
    const head = (c[2] || "").split("·")[0].trim();
    const named = /[A-Za-z]{2}/.test(head) && !/^\(?\d/.test(head)
      && !/\.(com|net|org|co|us|in|health|bar)\b/i.test(head)
      && !/^owner tbd$/i.test(head) && !/,\s*[A-Z]{2}$/.test(head);
    const tail = (c[4] || "").slice(10).trim();
    out.push({
      co: c[1],
      who: named ? head : "",
      phone: m ? `(${m[1]}) ${m[2]}-${m[3]}` : "",
      stage: c[3] || "new",
      last: c[4] || "",
      when: (c[4] || "").slice(0, 10),
      outcome: (tail && tail !== "sourced") ? tail : "",
      next: c[5] || "",
      due: c[6] || "",
      niche: c[7] || "",
      email: c[8] || "",
    });
  }
  return out;
}

/* Priority is the whole point. Someone who asked to be called back outranks a
   name nobody has ever dialled, and a gatekeeper you can beat by calling after
   hours outranks a cold one. */
function buckets(all) {
  const live = all.filter(l => l.phone && !["lost", "won"].includes(l.stage));
  const t = today();

  const callback = live.filter(l => l.outcome === "callback set")
    .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  const talked = live.filter(l => l.outcome === "spoke to owner" || l.stage === "replied");
  const gate = live.filter(l => ["gatekeeper", "voicemail"].includes(l.outcome));
  // A no-answer is worth another try, but not on the same day.
  const retry = live.filter(l => l.outcome === "no answer" && l.when < t);
  const fresh = live.filter(l => !l.outcome);

  const seen = new Set();
  const dedupe = list => list.filter(l => !seen.has(l.co) && seen.add(l.co));

  return [
    ["Callbacks owed", dedupe(callback), "They asked you to call. Overdue ones first."],
    ["Already spoke to the owner", dedupe(talked), "Warm. Pick up where the last call ended."],
    ["Beat the gatekeeper", dedupe(gate), "Call after 6pm — the owner answers his own line."],
    ["No answer last time", dedupe(retry), "Different time of day than you tried before."],
    ["Never called", dedupe(fresh).slice(0, 25), "Ask for the name where you have one."],
  ];
}

function render(groups, all) {
  const t = today();
  const called = all.filter(l => l.outcome).length;
  const lines = [
    `# Dial list — ${t}`, "",
    `${all.length} leads · ${called} with a logged outcome · ${all.length - called} never called`, "",
  ];
  for (const [title, rows, hint] of groups) {
    if (!rows.length) continue;
    lines.push(`## ${title} (${rows.length})`, `*${hint}*`, "");
    for (const l of rows) {
      const who = l.who ? ` — ask for ${l.who}` : "";
      const extra = [l.due && l.outcome === "callback set" ? `due ${l.due}` : "",
                     l.outcome ? `last: ${l.outcome} ${l.when}` : ""].filter(Boolean).join(" · ");
      lines.push(`- **${l.co}** ${l.phone}${who}${extra ? `  \n  ${extra}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

const all = leads();
const groups = buckets(all);
const md = render(groups, all);
fs.writeFileSync(path.join(__dirname, "leads", "dial-today.md"), md);

console.log(`dial list written — ${today()}`);
for (const [title, rows] of groups) if (rows.length) console.log(`  ${rows.length.toString().padStart(3)}  ${title}`);
