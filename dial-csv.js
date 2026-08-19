#!/usr/bin/env node
/*
 * dialer/TODAY.csv — the dial list in the order the dialer imports it.
 *
 *   node dial-csv.js        writes dialer/TODAY.csv and prints the count
 *
 * Run after dial-list.js, never before: the row order here is exactly the
 * order in leads/dial-today.md, so the call sheet, the dashboard and the
 * dialer all agree on what "lead 37" means. The last CSV was hand-cut on
 * 2026-08-17 and then went stale the same day — nothing regenerated it, so the
 * dialer kept importing Monday's 90 while the list moved on.
 *
 * Plain code for the same reason dial-list.js is: the morning has to produce a
 * dial sheet even when every agent step fails, and this week all four of them
 * did.
 */

const fs = require("fs");
const path = require("path");

const q = s => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
const digits = s => String(s || "").replace(/\D/g, "");

/* pipeline.md, keyed by the phone number, so a row can be found from the dial
   list without re-parsing names — company names differ in punctuation between
   the two files and the number never does. */
function byPhone() {
  const map = new Map();
  let won = false;
  for (const line of fs.readFileSync(path.join(__dirname, "pipeline.md"), "utf8").split("\n")) {
    if (/^##\s*Won/i.test(line)) won = true;
    if (won || !line.startsWith("| ")) continue;
    const c = line.split("|").map(x => x.trim());
    if (!c[1] || c[1] === "Company") continue;
    const m = (c[2] || "").match(/\(?(\d{3})\)?[ .-]?(\d{3})[ .-]?(\d{4})/);
    if (!m) continue;
    const p = m[1] + m[2] + m[3];
    if (!map.has(p)) map.set(p, { co: c[1], last: c[4] || "", next: c[5] || "", due: c[6] || "", em: c[8] || "" });
  }
  return map;
}

/* What this call is. The bucket says how to open; the next action says what
   was promised. Both matter on the phone and neither is worth hunting for
   mid-dial, so they go in the sheet. */
function purpose(section, row) {
  const next = (row && row.next || "").replace(/\s+/g, " ").trim();
  const due = row && row.due ? ` (due ${row.due})` : "";
  if (/Callbacks owed/.test(section))     return (next || "CALLBACK OWED") + due;
  if (/spoke to the owner/.test(section)) return "2nd call — " + (next || "pick up where the last call ended");
  if (/gatekeeper/.test(section))         return "After 6pm — " + (next || "ask for the owner by name");
  if (/No answer/.test(section))          return "Retry, different time of day than last";
  return next || "Cold call → demo #";
}

const dial = fs.readFileSync(path.join(__dirname, "leads", "dial-today.md"), "utf8").split("\n");
const pipe = byPhone();

const rows = [];
let section = "", seen = new Set();
for (const line of dial) {
  if (line.startsWith("## ")) { section = line.replace(/^##\s*/, "").replace(/\s*\(\d+\)\s*$/, ""); continue; }
  if (!line.startsWith("- **")) continue;
  const co = (line.match(/^- \*\*(.+?)\*\*/) || [])[1] || "";
  const m = line.match(/\(?(\d{3})\)?[ .-]?(\d{3})[ .-]?(\d{4})/);
  if (!m) continue;
  const p = m[1] + m[2] + m[3];
  if (seen.has(p)) continue;
  seen.add(p);
  const who = (line.match(/— ask for (.+?)\s*$/) || [])[1] || "";
  const row = pipe.get(p);
  rows.push([
    rows.length + 1,
    co,
    who,
    `(${m[1]}) ${m[2]}-${m[3]}`,
    p,
    row ? row.em : "",
    purpose(section, row),
    "",
    row ? (row.last || "").replace(/\s+/g, " ").slice(0, 300) : "",
  ]);
}

const head = "#,Company,Ask for,Phone,Dial,Email,What this call is,Outcome,Notes";
const out = [head, ...rows.map(r => r.map(q).join(","))].join("\n") + "\n";
fs.mkdirSync(path.join(__dirname, "dialer"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "dialer", "TODAY.csv"), out);
console.log(`dialer/TODAY.csv — ${rows.length} leads`);
