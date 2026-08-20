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
  if (section === "CALLBACK")   return (next || "CALLBACK OWED") + due;
  if (section === "WARM")       return "2nd call — " + (next || "pick up where the last call ended");
  if (section === "GATEKEEPER") return "After 6pm — " + (next || "ask for the owner by name");
  if (section === "RETRY")      return "Retry, different time of day than last";
  return next || "Cold call → demo #";
}

/* The notes typed on the phone live in state.json, keyed by company name, and
   nothing has ever copied them into pipeline.md. So the Last touch column says
   "spoke to owner" while the actual note says he wants an email because his
   current system books fake appointments — the sentence that makes the next
   call winnable. 84 notes were sitting in that file unread by every sheet.
   pipeline.md stays canonical for stage and next action. This column is the
   narrative, and the narrative is only in state.json. */
function notes() {
  const norm = x => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const map = new Map();
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8")).notes || {};
    for (const [co, v] of Object.entries(s)) {
      if (!v) continue;
      // Every note, newest first, dated — same rule as the sheet.
      const log = Array.isArray(v.log) && v.log.length ? v.log : (v.text ? [{ text: v.text, at: v.at }] : []);
      const t = log
        .map(e => ({ at: String(e.at || "").slice(0, 10), text: String(e.text || "").replace(/\s+/g, " ").trim() }))
        .filter(e => e.text)
        .sort((a, b) => b.at.localeCompare(a.at))
        .map(e => (e.at ? "[" + e.at + "] " : "") + e.text)
        .join("  ||  ");
      if (t) map.set(norm(co), t);
    }
  } catch (e) { /* no bridge state yet — the sheet still builds */ }
  return map;
}

const dial = fs.readFileSync(path.join(__dirname, "leads", "dial-today.md"), "utf8").split("\n");
const pipe = byPhone();
const note = notes();
const norm = x => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const rows = [];
let section = "", seen = new Set();
for (const line of dial) {
  // The sheet is flat and numbered now — "**12. Company** (phone) … · `TAG`".
  // The tag carries the bucket that used to be a heading.
  const head = line.match(/^\*\*\d+\.\s(.+?)\*\*/);
  if (!head) continue;
  section = (line.match(/`([A-Z]+)`\s*$/) || [])[1] || "";
  const co = head[1];
  const m = line.match(/\(?(\d{3})\)?[ .-]?(\d{3})[ .-]?(\d{4})/);
  if (!m) continue;
  const p = m[1] + m[2] + m[3];
  if (seen.has(p)) continue;
  seen.add(p);
  // Stop before the trailing tag — "— ask for Scott Ross (Owners) · `CALLBACK`"
  const who = ((line.match(/— ask for (.+?)(?:\s*·\s*`[A-Z]+`)?\s*$/) || [])[1] || "").trim();
  const row = pipe.get(p);
  rows.push([
    co,
    who,
    `(${m[1]}) ${m[2]}-${m[3]}`,
    purpose(section, row),
    // Your note first, in your words. The pipeline's last-touch line is the
    // fallback for the leads that have never been dialled.
    note.get(norm(co)) || (row ? (row.last || "").replace(/\s+/g, " ") : ""),
  ]);
}

/* Five columns, nothing you don't read mid-dial. The row number, the digits-only
   Dial column, Email and an empty Outcome column were all in here for a dialer
   import that no longer happens — they pushed the note, the one column that
   changes how the call opens, off the edge of the screen. */
const head = "Company,Ask for,Phone,What this call is,Notes";
const out = [head, ...rows.map(r => r.map(q).join(","))].join("\n") + "\n";
fs.mkdirSync(path.join(__dirname, "dialer"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "dialer", "TODAY.csv"), out);
console.log(`dialer/TODAY.csv — ${rows.length} leads`);
