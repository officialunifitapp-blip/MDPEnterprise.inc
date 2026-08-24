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

/* --fresh: never-called only, uncapped, unpinned.
   The default sheet is a day's dialling — everything owed first, cold leads
   filling what is left under TARGET. A cold-only session is a different job:
   no callbacks to honour, no order to match, just the untouched backlog in
   full. Both the sheet and TODAY.csv come out of this flag together, so the
   row numbers still line up across the two screens. */
const FRESH_ONLY = process.argv.includes("--fresh");

/* --called: the mirror image — everything already touched and owed something,
   and no cold leads at all. The four owed buckets are what dial-list has always
   computed; this flag just stops the never-called pile filling the rest of the
   sheet. A session spent clearing promises is not the same session as a cold
   block, and mixing them is how a verbal yes ends up on page four. */
const CALLED_ONLY = process.argv.includes("--called");

/* Both sheets are written under leads/ and read back by dial-csv.js, so they
   need separate names or the second run silently overwrites the first. */
const outArg = process.argv.indexOf("--out");
const OUT = outArg > -1 && process.argv[outArg + 1] ? process.argv[outArg + 1] : "dial-today.md";

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
/* MedSpa was killed as a niche on 2026-07-31 — zero sales, owners unreachable —
   and the pivot to restoration happened the same day. But 200 medspa rows stayed
   in pipeline.md, and because they carry outcomes like any other lead they kept
   surfacing in the dial buckets: Radiance, Natural Beauty, Wayzata and American
   Eyecare were all sitting in this morning's no-answer list. Dialling a niche
   this business decided against three weeks ago is the most expensive kind of
   wasted dial, because it looks like work.

   The rows stay in the file — they are history, and deleting a lead only means
   sourcing re-adds it later. They just never reach a call sheet again.

   The name test is a fallback for rows written before the Niche column existed;
   the 5am job appends without it. */
const MEDSPA = /med ?spa|aesthetic|botox|derm|skin|laser|salon|injectable|eyecare|beauty/i;

/* Not restoration at all. Marketing agencies, a law firm and a CPA practice
   were sitting on the dial list, sourced into pipeline.md as Restoration and
   never caught — twelve of them reached the dialer. These are not bad leads,
   they are not leads: nobody here loses a 4-figure job to a missed 2am call.
   Word-boundaries matter — "Remediation" contains "media" and "Joplin Mold
   Inspection and Remediation" is a real prospect. */
const OFF_ICP = /marketing|\bcpas?\b|lawyer|\bllp\b|attorney|\bdigital\b|\bcreative\b|studios|\bportal\b|lead to conversion/i;
// Named outright because the name alone gives nothing away.
const OFF_ICP_NAMED = /^(neoconcepts|pinch|haled|qnity|smith & crawford|dapper market)/i;

/* Adjacent trades, which is a different mistake from OFF_ICP above. A marketing
   agency is obviously not a lead; a general contractor or a carpet cleaner
   looks exactly like one on a sourcing page and 34 of them reached the file
   labelled Niche = Restoration. They are not buying an emergency-call answering
   service — nobody loses a 3am flood job to a missed call when they do kitchen
   remodels or truck-mount carpet cleaning.

   RESTORATION wins over TRADE wherever both appear, because the real prospects
   are full of both words: "Grethey Rose Construction & Restoration", "Cleanway
   Restoration & Construction", "Pride Cleaning & Restoration". Testing TRADE
   alone would have killed those. 'fire' and 'emergency' are in the signal list
   for the same reason — "Fire Reconstruction Inc" contains "construction" and
   is precisely the company we want. */
const RESTORATION = /restorat|restore\b|restorer|water ?damage|flood|disaster|mitigat|catastrophe|steamatic|dry ?out|\bmold\b|remediat|abatement|smoke|soot|\bfire\b|reconstruction|\bemergency\b|extract/i;
const OFF_TRADE = /construction|contracting|contractors|\bbuilders?\b|roofing|exteriors?\b|renovations?\b|remodel|carpet|upholstery|janitorial/i;
const isDeadNiche = l => /medspa/i.test(l.niche)
  || (!l.niche && MEDSPA.test(l.co))
  || OFF_ICP.test(l.co) || OFF_ICP_NAMED.test(l.co)
  || (OFF_TRADE.test(l.co) && !RESTORATION.test(l.co));

function buckets(all) {
  const live = all.filter(l => l.phone && !["lost", "won"].includes(l.stage) && !isDeadNiche(l));
  const t = today();

  /* Match the outcome text, don't compare it.
     This used to test l.outcome === "no answer". That works for an outcome
     tapped on the phone, which is one of eight fixed values, but every outcome
     written into pipeline.md by hand is a sentence — "gatekeeper (Delores) —
     she says Mike is reachable any time after 9am". Exact comparison put every
     hand-written row in NO bucket at all: not a callback, not warm, not a
     gatekeeper, and not "never called" either, because the outcome column was
     not empty. They simply vanished off the list.
     That is why Monday's calls disappeared from Tuesday's list the moment they
     were finally written down. The richer the note, the more certain the lead
     was to fall through. */
  const has = (l, re) => re.test(((l.outcome || "") + " " + (l.next || "")).toLowerCase());

  /* Oldest touch first, inside every bucket. The list used to come out in
     pipeline.md's row order, which is fixed, so the same names sat at the top
     every single morning and the same names never got reached. Sorting by how
     long it has been means yesterday's attempts sink and the ones going stale
     rise. */
  const stalest = (a, b) => (a.when || "").localeCompare(b.when || "");

  // Nothing touched today comes back today. One dial per lead per day.
  // And nothing scheduled for a future date: Kevin at St. Louis Cleaning said
  // call back in October, so putting him on today's sheet is a dial he already
  // told you not to make. A due date in the future is a promise to wait.
  const notToday = l => l.when !== t && !(l.due && l.due > t);

  /* A callback is something THEY asked for. Deliberately not matched on "call
     back" appearing in the next-action column — almost every next action says
     "call back, ask for X", which is just the instruction for a cold dial and
     dragged gatekeepers in here on the first pass. Past-tense "asked" is the
     tell: it only appears where a request was actually made. */
  const asked = l => /callback|promised/.test((l.outcome || "").toLowerCase())
                  || /asked/.test((l.next || "").toLowerCase());
  const callback = live.filter(l => notToday(l) && asked(l))
    .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  /* "spoke to" ANYONE, not a hardcoded list of names.
     This matched `spoke to owner|manager|marlena|melanie|tyler|victor`, so the
     moment a real name was written into the outcome — "spoke to Kevin",
     "spoke to Brandon (PM)", "spoke to Matt" — the lead matched no bucket at
     all and dropped straight off the sheet. Three warm leads vanished that way
     within an hour of the notes being written up properly. Same failure as the
     exact-match bug, one layer down: never enumerate values that a human types
     freely. */
  const talked = live.filter(l => notToday(l) &&
      ((has(l, /spoke to/) && !has(l, /gatekeeper|receptionist/)) || l.stage === "replied"))
    .sort(stalest);
  const gate = live.filter(l => notToday(l) && has(l, /gatekeeper|receptionist|voicemail|left message/)).sort(stalest);
  // A no-answer is worth another try, but not on the same day.
  const retry = live.filter(l => notToday(l) && has(l, /no answer|didn'?t answer|no contact/)).sort(stalest);
  /* Newest-sourced first. The never-called bucket is capped at whatever is left
     under TARGET, and `fresh` came out in pipeline.md row order — so leads
     sourced today land at the bottom of a 299-deep pile and never reach the
     sheet. Sourcing that never gets dialled is the same as no sourcing. */
  const fresh = live.filter(l => !l.outcome)
    .sort((a, b) => (b.when || "").localeCompare(a.when || ""));

  const seen = new Set();
  const dedupe = list => list.filter(l => !seen.has(l.co) && seen.add(l.co));

  // Cold-only: the whole never-called backlog, not a slice of it. Nothing is
  // owed a call on this sheet, so nothing outranks anything and TARGET has
  // nothing to protect.
  if (FRESH_ONLY) return [["Never called", dedupe(fresh), "Ask for the name where you have one."]];

  // Owed-only: same four buckets, same priority, cold pile withheld.
  if (CALLED_ONLY) return [
    ["Callbacks owed", dedupe(callback), "They asked you to call. Overdue ones first."],
    ["Already spoke to the owner", dedupe(talked), "Warm. Pick up where the last call ended."],
    ["Beat the gatekeeper", dedupe(gate), "Call after 6pm — the owner answers his own line."],
    ["No answer last time", dedupe(retry), "Different time of day than you tried before."],
  ];

  // A day's dialling. Everything owed comes first and in full; never-called
  // fills whatever is left.
  const TARGET = 150;
  const owed = new Set([...callback, ...talked, ...gate, ...retry].map(l => l.co)).size;

  return [
    ["Callbacks owed", dedupe(callback), "They asked you to call. Overdue ones first."],
    ["Already spoke to the owner", dedupe(talked), "Warm. Pick up where the last call ended."],
    ["Beat the gatekeeper", dedupe(gate), "Call after 6pm — the owner answers his own line."],
    ["No answer last time", dedupe(retry), "Different time of day than you tried before."],
    // Never-called fills the day up to TARGET rather than a fixed 25. The old
    // cap was set when the other buckets were fat with MedSpa rows; with those
    // gone the list came out at 100 and the fixed 25 was the thing capping it.
    // Warm leads are never truncated — only this bucket flexes, because it is
    // the only one where the next name is as good as the last.
    ["Never called", dedupe(fresh).slice(0, Math.max(0, TARGET - owed)), "Ask for the name where you have one."],
  ];
}

/* The notes typed on the phone live in state.json, keyed by company name.
   This sheet is read side-by-side with the dialer — the whole point is to see
   who you are calling AND what happened last time without opening anything
   else. A line that says "last: spoke to owner" does not do that. */
function notes() {
  const norm = x => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const map = new Map();
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8")).notes || {};
    for (const [co, v] of Object.entries(s)) {
      if (!v) continue;
      // Every note ever written for this company, newest first and dated, not
      // just the latest one. On a second or third call the earlier notes are
      // the ones that say what was already agreed.
      const log = Array.isArray(v.log) && v.log.length ? v.log : (v.text ? [{ text: v.text, at: v.at }] : []);
      const entries = log
        .map(e => ({ at: String(e.at || "").slice(0, 10), text: String(e.text || "").replace(/\s+/g, " ").trim() }))
        .filter(e => e.text)
        .sort((a, b) => b.at.localeCompare(a.at));
      if (entries.length) map.set(norm(co), entries);
    }
  } catch (e) { /* no bridge state yet — the sheet still builds */ }
  return map;
}
const NOTE = notes();
const noteFor = co => NOTE.get(String(co || "").toLowerCase().replace(/[^a-z0-9]/g, ""));

/* Flat and numbered, not grouped under headings.
   The sheet is read beside the dialer, and the dialer holds one flat list in
   the order TODAY.csv was imported — which is this order, because both files
   are generated from the same pass. Grouping under five headings meant the
   numbers on the two screens never matched and every lookup mid-call was a
   scan. The bucket still shows, as a tag on the row, because WHY you are
   calling changes how you open. */
const TAG = {
  "Callbacks owed": "CALLBACK",
  "Already spoke to the owner": "WARM",
  "Beat the gatekeeper": "GATEKEEPER",
  "No answer last time": "RETRY",
  "Never called": "COLD",
};

function render(groups, all, tags) {
  const t = today();
  const called = all.filter(l => l.outcome).length;
  const lines = [
    `# Dial list — ${t}`, "",
    `${all.length} leads · ${called} with a logged outcome · ${all.length - called} never called`,
    "",
    `Same order as dialer/TODAY.csv — row numbers match the dialer.`, "",
  ];
  let n = 0;
  for (const [title, rows] of groups) {
    for (const l of rows) {
      const tag = TAG[(tags ? tags[n] : title)] || TAG[title] || "COLD";
      n++;
      const who = l.who ? ` — ask for ${l.who}` : "";
      lines.push(`**${n}. ${l.co}** ${l.phone}${who} · \`${tag}\``);
      const extra = [l.due ? `due ${l.due}` : "", l.next ? `→ ${l.next}` : ""].filter(Boolean).join(" · ");
      if (extra) lines.push(`   ${extra}`);
      const note = noteFor(l.co);
      if (note && note.length) note.forEach(e => lines.push(`   > **${e.at || "—"}** ${e.text}`));
      else if (l.outcome) lines.push(`   > last: ${l.outcome} (${l.when})`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function renderGrouped(groups, all) {
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
      const extra = [l.due ? `due ${l.due}` : "",
                     l.next ? `→ ${l.next}` : ""].filter(Boolean).join(" · ");
      lines.push(`- **${l.co}** ${l.phone}${who}${extra ? `  \n  ${extra}` : ""}`);
      // Your own words, indented under the lead. This is the line that decides
      // how the call opens.
      const n = noteFor(l.co);
      if (n) lines.push(`  > ${n}`);
      else if (l.outcome) lines.push(`  > last: ${l.outcome} (${l.when})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/* dialer/order.txt pins the sheet to the dialer's own sequence, so the two
   screens line up without re-importing anything. Keyed on the phone number —
   company names differ in punctuation between the two, digits never do.
   Leads the dialer doesn't have are appended after, so nothing owed a call is
   dropped just because it wasn't in the last import. */
function pinned(all, groups) {
  const f = path.join(__dirname, "dialer", "order.txt");
  if (!fs.existsSync(f)) return null;
  const order = [];
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = line.match(/\(?(\d{3})\)?[ .-]?(\d{3})[ .-]?(\d{4})/);
    if (m) order.push(m[1] + m[2] + m[3]);
  }
  if (!order.length) return null;

  const tagOf = new Map();
  for (const [title, rows] of groups) for (const l of rows) tagOf.set(l.phone.replace(/\D/g, ""), title);
  const byPhone = new Map(all.map(l => [l.phone.replace(/\D/g, ""), l]));

  const out = [], seen = new Set();
  for (const p of order) {
    if (seen.has(p)) continue;
    seen.add(p);
    const l = byPhone.get(p);
    // A lead past `contacted` is not a cold dial. Heartland said yes on
    // 2026-08-20 and stayed on the sheet because the pinned order is read
    // straight from the dialer — a closed deal getting a prospecting call is
    // the fastest way to unclose it.
    if (l && !["new", "contacted", "replied"].includes(l.stage)) continue;
    if (l) out.push([tagOf.get(p) || "Never called", l]);
    else out.push(["Never called", { co: `(${p.slice(0,3)}) ${p.slice(3,6)}-${p.slice(6)}`,
      phone: `(${p.slice(0,3)}) ${p.slice(3,6)}-${p.slice(6)}`, who: "", next: "Not in pipeline.md", due: "", outcome: "", when: "" }]);
  }
  for (const [title, rows] of groups)
    for (const l of rows) if (!seen.has(l.phone.replace(/\D/g, ""))) { seen.add(l.phone.replace(/\D/g, "")); out.push([title, l]); }
  return out;
}

const all = leads();
const groups = buckets(all);
// order.txt is the last dialer import, which is mostly leads that have been
// called. Pinning to it would drag them straight back onto a cold-only sheet.
const pin = (FRESH_ONLY || CALLED_ONLY) ? null : pinned(all, groups);
const md = pin ? render([["", pin.map(x => x[1])]], all, pin.map(x => x[0]))
               : render(groups, all);
fs.writeFileSync(path.join(__dirname, "leads", OUT), md);

/* Say what was dropped. Every exclusion in this file is a lead that silently
   stops existing, and a sheet that shrinks without saying why reads as
   "sourcing is slow" rather than "the filter ate them". */
const cut = all.filter(l => l.phone && !["lost", "won"].includes(l.stage)
  && OFF_TRADE.test(l.co) && !RESTORATION.test(l.co));
console.log(`dial list written — ${today()}`);
if (cut.length) console.log(`  ${cut.length.toString().padStart(3)}  excluded — other trade, no restoration signal`);
for (const [title, rows] of groups) if (rows.length) console.log(`  ${rows.length.toString().padStart(3)}  ${title}`);
