#!/usr/bin/env node
/*
 * Notes bridge — the dashboard's way into Notion.
 *
 * The browser cannot call Notion directly: the API rejects browser origins,
 * and a token embedded in index.html would be published with the site. This
 * process holds the token instead. The dashboard posts plain JSON to it over
 * localhost; the token never leaves this machine.
 *
 *   NOTION_TOKEN=ntn_xxx NOTION_PARENT_PAGE=<page-id> node notes-bridge.js
 *
 * NOTION_PARENT_PAGE is only needed on the first run, to create the database.
 * After that the bridge prints a NOTION_DB id — set it to skip the lookup.
 */

const http = require("http");
const { execFile } = require("child_process");

/* The CEO chat runs Claude Code headless in this directory, so it inherits
   CLAUDE.md, the three subagents, and the Notion MCP connection. Opus answers
   at roughly $0.19 and 40s per message; MODEL is here so that is a choice. */
const MODEL    = process.env.CEO_MODEL || "claude-sonnet-5";
const PERMS    = process.env.CEO_PERMS || "bypassPermissions";
const CEO_WAIT = Number(process.env.CEO_TIMEOUT || 180000);

function askCeo(message, session) {
  return new Promise(resolve => {
    const args = ["-p", message, "--output-format", "json",
                  "--model", MODEL, "--permission-mode", PERMS];
    if (session) args.push("--resume", session);
    execFile("claude", args, { cwd: __dirname, timeout: CEO_WAIT, maxBuffer: 8e6 },
      (err, stdout) => {
        if (err && !stdout) return resolve({ error: err.killed ? "timed out" : err.message });
        try {
          const j = JSON.parse(stdout);
          resolve({ text: j.result || "(no reply)", session: j.session_id, cost: j.total_cost_usd });
        } catch { resolve({ error: "could not parse Claude output" }); }
      });
  });
}

const TOKEN  = process.env.NOTION_TOKEN || "";
const PARENT = (process.env.NOTION_PARENT_PAGE || "").replace(/-/g, "");
const PORT   = Number(process.env.PORT || 8787);
const NV     = "2022-06-28";
let   DB     = process.env.NOTION_DB || "";

const STAGES   = ["new","contacted","replied","booked","call held","proposal","won","lost"];
// Notion's Outcome column is a single-select, so it carries the furthest one.
// pipeline.md keeps the full list. Retired values stay so old rows still parse.
const OUTCOMES = ["no answer","phone disconnected","gatekeeper","send an email","spoke to owner",
                  "not interested","already has a system","appointment booked",
                  "voicemail","callback set","demo sent"];

const today = () => new Date().toISOString().slice(0, 10);

async function notion(path, method = "GET", body) {
  const r = await fetch("https://api.notion.com/v1" + path, {
    method,
    headers: {
      "Authorization": "Bearer " + TOKEN,
      "Notion-Version": NV,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Notion ${r.status}: ${j.message || r.statusText}`);
  return j;
}

/* ---- schema ---- mirrors the stage list at the top of pipeline.md ---- */
const SCHEMA = {
  "Company":     { title: {} },
  "Contact":     { rich_text: {} },
  "Phone":       { phone_number: {} },
  "Stage":       { select: { options: STAGES.map(n => ({ name: n })) } },
  "Outcome":     { select: { options: OUTCOMES.map(n => ({ name: n })) } },
  "Note":        { rich_text: {} },
  "Next action": { rich_text: {} },
  "Due":         { date: {} },
  "Last touch":  { date: {} },
};

async function ensureDb() {
  if (DB) return DB;

  const found = await notion("/search", "POST", {
    query: "Call Log",
    filter: { value: "database", property: "object" },
  });
  const hit = (found.results || []).find(d =>
    (d.title || []).map(t => t.plain_text).join("").trim() === "Call Log");
  if (hit) {
    DB = hit.id;
    console.log("Using existing Call Log database:", DB);
    return DB;
  }

  // No parent given? Use the first page shared with the integration. Saves
  // hunting a page id out of a Notion URL; the integration can only see pages
  // that were explicitly shared with it anyway.
  let parent = PARENT;
  if (!parent) {
    const pages = await notion("/search", "POST", {
      filter: { value: "page", property: "object" },
      page_size: 10,
    });
    const first = (pages.results || []).find(p => !p.in_trash);
    if (!first) {
      throw new Error(
        "The integration cannot see any pages. In Notion, open the page you " +
        "want, then ⋯ → Connections → add the integration.");
    }
    parent = first.id;
    const name = Object.values(first.properties || {})
      .find(p => p.type === "title")?.title?.map(t => t.plain_text).join("") || "(untitled)";
    console.log("Creating Call Log under:", name);
  }
  const created = await notion("/databases", "POST", {
    parent: { type: "page_id", page_id: parent },
    title: [{ type: "text", text: { content: "Call Log" } }],
    properties: SCHEMA,
  });
  DB = created.id;
  console.log("Created Call Log database:", DB);
  console.log("Set NOTION_DB=" + DB + " to skip this lookup next time.");
  return DB;
}

/* ---- matching ---- one company, one row ---- */
// Two keys per name. `loose` keeps every word; `strict` drops the generic ones
// so "Kwik Dry LLC" meets "Kwik Dry". strict can come out EMPTY for names built
// entirely from generics ("Cleaning Restoration Services") — an empty key
// matches everything, so it is never allowed to match.
const loose  = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const strict = s => loose(s).replace(/\b(llc|inc|co|corp|company|services?|restorations?|cleaning)\b/g, "").replace(/\s+/g, " ").trim();
const norm   = loose;

function detectOutcome(text) {
  const s = text.toLowerCase();
  if (/\bnot interested|no thanks|hung up|don'?t call\b/.test(s)) return "not interested";
  if (/\bdemo (sent|texted|emailed)|sent (the )?demo\b/.test(s))  return "demo sent";
  if (/\bcall ?back|callback|try (again )?(mon|tue|wed|thu|fri)/.test(s)) return "callback set";
  if (/\bgatekeep|receptionist|secretary|front desk\b/.test(s))    return "gatekeeper";
  if (/\bvoicemail|\bvm\b|left a message\b/.test(s))               return "voicemail";
  if (/\bspoke|talked to|got (the )?owner|reached\b/.test(s))      return "spoke to owner";
  if (/\bno answer|didn'?t answer|nobody (picked|answered)\b/.test(s)) return "no answer";
  return null;
}

// Only advance on evidence. A voicemail is not a contact.
function detectStage(text, outcome) {
  const s = text.toLowerCase();
  if (/\bbooked|meeting (set|booked)|calendar\b/.test(s))         return "booked";
  if (/\breplied|interested|wants (to )?(hear|see|know)\b/.test(s)) return "replied";
  if (outcome === "spoke to owner" || outcome === "callback set") return "contacted";
  return null;
}

const rt   = v => [{ type: "text", text: { content: String(v).slice(0, 1900) } }];
const text = p => (p && p.rich_text || []).map(t => t.plain_text).join("");

// Tiered match. "Rapid Dry" must find the existing "Rapid Dry STL" row —
// exact-only matching silently creates a second row for the same company,
// which is the one failure that makes this log useless.
async function findRow(company) {
  const L = loose(company), S = strict(company);
  if (!L) return null;

  const rows = [];
  let cursor;
  do {
    const page = await notion(`/databases/${DB}/query`, "POST",
      cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 });
    for (const row of page.results) {
      const title = (row.properties.Company?.title || []).map(t => t.plain_text).join("");
      rows.push({ row, title, l: loose(title), s: strict(title) });
    }
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);

  const pick = hits => {
    if (hits.length === 1) return hits[0].row;
    if (hits.length > 1) {
      const e = new Error(`"${company}" matches ${hits.length} companies: ` +
        hits.slice(0, 4).map(h => h.title).join(", ") + ". Use the full name.");
      e.ambiguous = true;
      throw e;
    }
    return null;
  };

  // Narrowest first. Each tier only runs if the one before found nothing, and
  // an ambiguous tier throws rather than guessing which company you called.
  return pick(rows.filter(r => r.l === L))
      || (S ? pick(rows.filter(r => r.s && r.s === S)) : null)
      || (L.length >= 4 ? pick(rows.filter(r => r.l.length >= 4 &&
           (r.l.startsWith(L) || L.startsWith(r.l)))) : null)
      || (L.length >= 5 ? pick(rows.filter(r => r.l.length >= 5 &&
           (r.l.includes(L) || L.includes(r.l)))) : null)
      || null;
}

/* ---- pipeline.md write-back ----
   CLAUDE.md makes pipeline.md canonical for stage, so an outcome tapped in
   the dashboard has to land here, not only in Notion. */

// Only advance on evidence, same rule the note parser follows: nobody picking
// up is not a conversation, so it records the attempt without moving anyone
// down the funnel. `null` means "leave the stage alone".
//
// "already has a system" is deliberately not a loss. The best lead in the
// pipeline came from exactly that answer — they had one, it misrouted their
// calls, and they were already shopping for a replacement.
const OUTCOME_STAGE = {
  "no answer":          null,
  "phone disconnected": "lost",
  "gatekeeper":         null,
  // Deciding to email is not a conversation, same rule as a voicemail. It sets
  // the Next action instead, which is what actually gets the email written.
  "send an email":      null,
  "spoke to owner":     "contacted",
  "not interested":     "lost",
  "already has a system": null,
  "appointment booked": "booked",

  // Retired, still on rows logged before the list changed. Accepted so old
  // outcomes keep parsing; never offered as a choice again.
  "voicemail":    null,
  "callback set": "contacted",
  "demo sent":    "contacted",
  "booked":       "booked",
};

// One call can be several things at once — a gatekeeper who also tells you
// they already have a system. The stage is whichever outcome went furthest.
const STAGE_RANK = { booked: 4, contacted: 3, lost: 2 };
function stageFor(outcomes) {
  let best = null, rank = 0;
  for (const o of outcomes) {
    const s = OUTCOME_STAGE[o];
    if (s && (STAGE_RANK[s] || 0) > rank) { best = s; rank = STAGE_RANK[s]; }
  }
  return best;
}

function markLead(company, outcomes, due, next) {
  const fs = require("fs"), path = require("path");
  const file = path.join(__dirname, "pipeline.md");
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const want = strict(company) || loose(company);

  let hit = -1, won = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s*Won/i.test(lines[i])) won = true;
    if (won || !lines[i].startsWith("| ")) continue;
    const c = lines[i].split("|").map(x => x.trim());
    if (!c[1] || c[1] === "Company") continue;
    if (loose(c[1]) === loose(company) || (want && strict(c[1]) === want)) { hit = i; break; }
  }
  if (hit < 0) throw new Error(`"${company}" is not in pipeline.md`);

  const c = lines[hit].split("|").map(x => x.trim());
  const stage = stageFor(outcomes);
  if (stage) c[3] = stage;
  // "2026-08-05 sourced" becomes "2026-08-05 gatekeeper, already has a system"
  // — the column already carries what happened, so outcomes need no new column
  // to live in. Comma-separated because a call can be several things at once.
  c[4] = `${today()} ${outcomes.join(", ")}`;

  // An appointment with no date is an appointment that gets missed. Due and
  // Next action are existing columns; this is what they were for.
  if (outcomes.includes("appointment booked")) {
    c[5] = next || (/appointment/i.test(c[5]) ? c[5] : "Appointment booked");
    c[6] = due || c[6];
  }
  // An email nobody writes is not a next action. Which of the two it becomes
  // depends on whether the Email column has anything in it — the drafter can
  // only work from a real address, and a missing one is research, not writing.
  else if (outcomes.includes("send an email")) {
    c[5] = next || (c[8] && c[8].includes("@") ? "Send email — draft it"
                                               : "Find email address");
  }
  lines[hit] = "| " + c.slice(1, 9).join(" | ") + " |";

  fs.writeFileSync(file, lines.join("\n"));
  return { company: c[1], stage: c[3], last: c[4], next: c[5], due: c[6] };
}

async function upsert(entry) {
  await ensureDb();
  const { company, note = "", contact = "", phone = "", stage, seed, due, next } = entry;
  if (!company) throw new Error("company is required");

  const outcome  = entry.outcome || (note ? detectOutcome(note) : null);
  const newStage = stage || (note ? detectStage(note, outcome) : null);
  const row      = await findRow(company);
  const dated    = note ? `${today()} — ${note}` : "";

  if (!row) {
    // A generic word that matched nothing is a typo, not a new company.
    // Creating a row called "Restoration" is worse than refusing.
    if (!seed && !strict(company)) {
      throw new Error(`"${company}" matched no company and is too generic to ` +
        `create. Use the name as it appears in Leads.`);
    }
    const props = { "Company": { title: rt(company) } };
    if (contact) props["Contact"] = { rich_text: rt(contact) };
    if (phone)   props["Phone"]   = { phone_number: phone };
    props["Stage"] = { select: { name: newStage || "new" } };
    if (outcome) props["Outcome"] = { select: { name: outcome } };
    if (dated) {
      props["Note"]       = { rich_text: rt(dated) };
      props["Last touch"] = { date: { start: today() } };
    }
    await notion("/pages", "POST", { parent: { database_id: DB }, properties: props });
    return { action: "created", company, outcome, stage: newStage || "new" };
  }

  // Seeding must never touch a row that already exists — it would clobber notes.
  if (seed) return { action: "skipped", company, reason: "already present" };

  const existing = text(row.properties.Note);
  // A repeated note must not be written twice, but the rest of the update is
  // not a duplicate: rescheduling a callback resends the same word "callback
  // set" with a new date, and returning here would drop the date on the floor.
  const dupNote = !!note && existing.includes(note);

  const props = {};
  if (dated && !dupNote) {
    props["Note"]       = { rich_text: rt(existing ? existing + "\n" + dated : dated) };
    props["Last touch"] = { date: { start: today() } };
  }
  if (outcome)  props["Outcome"] = { select: { name: outcome } };
  if (newStage) props["Stage"]   = { select: { name: newStage } };
  if (phone && !row.properties.Phone?.phone_number) props["Phone"] = { phone_number: phone };
  if (next) props["Next action"] = { rich_text: rt(next) };
  if (due && /^\d{4}-\d{2}-\d{2}$/.test(due)) props["Due"] = { date: { start: due } };

  if (!Object.keys(props).length) return { action: "skipped", company, reason: "nothing to change" };
  await notion(`/pages/${row.id}`, "PATCH", { properties: props });
  return { action: dupNote ? "updated" : "appended", company, outcome, stage: newStage || null };
}

/* ---- shared state ----
   Notes and CEO thoughts used to live in each browser's localStorage, which
   meant the phone and the laptop each kept a private copy that never met.
   They live here now — one file, one truth, both devices read it.

   Merge is last-write-wins per entry, not per document: two devices editing
   different companies both keep their work. Whole-document overwrite would
   silently drop whichever device posted first. */
const fsp   = require("fs");
const STATE = require("path").join(__dirname, "state.json");

function loadState() {
  try { return JSON.parse(fsp.readFileSync(STATE, "utf8")); }
  catch { return { notes: {}, thoughts: [] }; }
}
function saveState(s) {
  fsp.writeFileSync(STATE, JSON.stringify(s, null, 2));
  return s;
}
function mergeState(incoming) {
  const cur = loadState();

  /* Notes: {company: {text, at, log:[{text,at}]}}.
     `text` is the latest note, kept so every existing reader still works.
     `log` is every note ever written for that company, oldest first.

     This used to be newest-wins and nothing else: writing a second note on a
     company silently destroyed the first. Every call after the first on the
     same lead erased what was said on the call before it — which is the worst
     possible place to lose data, because the second call is the one where the
     history matters. Notes are the only record of what was actually said; they
     are append-only from here.

     Same-text writes do not append (the phone re-sends state on reconnect), and
     an older timestamp never overwrites `text`, but it is still logged. */
  for (const [co, n] of Object.entries(incoming.notes || {})) {
    if (!n || typeof n.text !== "string") continue;
    const txt = n.text, at = n.at || now();
    const mine = cur.notes[co];
    if (!mine) { cur.notes[co] = { text: txt, at, log: [{ text: txt, at }] }; continue; }
    // Migrate a pre-log note the first time it is touched, so its original
    // text becomes the first entry rather than being dropped.
    if (!Array.isArray(mine.log)) mine.log = [{ text: mine.text, at: mine.at || at }];
    const dup = mine.log.some(e => e.text === txt);
    if (!dup) mine.log.push({ text: txt, at });
    mine.log.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    if (String(at) >= String(mine.at || "")) { mine.text = txt; mine.at = at; }
  }

  // Thoughts: union by id so a device that has been offline re-adds its own
  // without resurrecting ones that were deleted elsewhere in the meantime.
  const byId = new Map((cur.thoughts || []).map(t => [t.id, t]));
  for (const t of incoming.thoughts || []) {
    if (t && t.id && typeof t.text === "string" && !byId.has(t.id)) byId.set(t.id, { id: t.id, text: t.text, at: t.at || now() });
  }
  cur.thoughts = [...byId.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 8);

  for (const id of incoming.deleted || []) {
    cur.thoughts = cur.thoughts.filter(t => t.id !== id);
  }
  return saveState(cur);
}
const now = () => new Date().toISOString();

/* ---- http ---- */
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Bridge-Key, ngrok-skip-browser-warning",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};
const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(obj));
};

/* Once a tunnel points at this port it is on the public internet, where it
   would otherwise be an unauthenticated write endpoint into Notion and a
   shell into Claude Code. BRIDGE_KEY is the whole fence — refuse to serve
   anything but /health without it. */
const KEY = process.env.BRIDGE_KEY || "";
function authed(req) {
  if (!KEY) return true;                       // localhost-only, no tunnel
  const hdr = req.headers["x-bridge-key"];
  if (hdr) return hdr === KEY;
  return (req.url.match(/[?&]k=([^&]+)/) || [])[1] === KEY;
}

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }

  if (req.url.startsWith("/health")) {
    return json(res, 200, { ok: !!TOKEN, db: DB || null, hasToken: !!TOKEN, locked: !!KEY });
  }

  if (!authed(req)) return json(res, 401, { error: "bad or missing bridge key" });

  /* Shared notes + thoughts. GET is the phone catching up, POST is the phone
     pushing what it wrote while it was the only one holding it. */
  if (req.url.startsWith("/state")) {
    if (req.method === "GET") return json(res, 200, loadState());
    if (req.method === "POST") {
      let raw = "";
      req.on("data", c => { raw += c; if (raw.length > 2e6) req.destroy(); });
      req.on("end", () => {
        try { json(res, 200, mergeState(JSON.parse(raw || "{}"))); }
        catch (e) { json(res, 400, { error: e.message }); }
      });
      return;
    }
  }

  // Recent real activity: rows that actually have a note on them.
  if (req.url === "/activity") {
    (async () => {
      try {
        await ensureDb();
        const q = await notion(`/databases/${DB}/query`, "POST", {
          page_size: 40,
          sorts: [{ property: "Last touch", direction: "descending" }],
        });
        const items = q.results
          .filter(r => (r.properties.Note?.rich_text || []).length)
          .slice(0, 8)
          .map(r => {
            const note = (r.properties.Note.rich_text).map(t => t.plain_text).join("");
            const lines = note.trim().split("\n");
            return {
              company: (r.properties.Company?.title || []).map(t => t.plain_text).join(""),
              last: lines[lines.length - 1],
              stage: r.properties.Stage?.select?.name || null,
              outcome: r.properties.Outcome?.select?.name || null,
              when: r.properties["Last touch"]?.date?.start || null,
            };
          });
        json(res, 200, { items });
      } catch (e) { json(res, 200, { items: [], error: e.message }); }
    })();
    return;
  }

  // Real health, not a green light that is always green.
  if (req.url === "/status") {
    const fs = require("fs"), path = require("path");
    let manager = null;
    try {
      const st = fs.statSync(path.join(__dirname, "logs", "manager.log"));
      manager = { lastRun: st.mtime.toISOString(), size: st.size };
    } catch { /* never run yet */ }
    return json(res, 200, {
      bridge: true,
      notion: !!TOKEN && !!DB,
      db: DB || null,
      model: MODEL,
      manager,
    });
  }

  if (req.method === "POST" && req.url === "/chat") {
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on("end", async () => {
      try {
        const { message, session } = JSON.parse(raw || "{}");
        if (!message) return json(res, 400, { error: "message is required" });
        console.log("chat:", message.slice(0, 60));
        json(res, 200, await askCeo(message, session));
      } catch (e) { json(res, 400, { error: e.message }); }
    });
    return;
  }

  /* ---- call prep ---- the briefs, readable from the phone.
     They are files on the Mac, and the ten minutes before a call are never
     spent at the Mac. */
  if (req.url.startsWith("/prep")) {
    const fs = require("fs"), path = require("path");
    const dir = path.join(__dirname, "prep");

    if (req.url === "/prep" && req.method === "GET") {
      let items = [];
      try {
        items = fs.readdirSync(dir).filter(f => f.endsWith(".md")).map(f => {
          const st = fs.statSync(path.join(dir, f));
          const m = f.match(/^(\d{4}-\d{2}-\d{2}|undated)-(.+)\.md$/);
          return {
            file: f,
            date: m ? m[1] : "",
            // Filenames are slugs; the brief's own H1 carries the real name.
            company: (fs.readFileSync(path.join(dir, f), "utf8")
                        .match(/^#\s*(.+?)\s*(?:—|$)/m) || [, m ? m[2] : f])[1],
            written: st.mtime.toISOString(),
          };
        }).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      } catch { /* no prep dir yet */ }
      return json(res, 200, { items });
    }

    if (req.method === "GET" && /^\/prep\/[^/]+$/.test(req.url)) {
      const name = decodeURIComponent(req.url.slice(6));
      // Never let a path out of the prep directory.
      if (name.includes("/") || name.includes("..") || !name.endsWith(".md"))
        return json(res, 400, { error: "bad brief name" });
      try { return json(res, 200, { name, text: fs.readFileSync(path.join(dir, name), "utf8") }); }
      catch { return json(res, 404, { error: "no such brief" }); }
    }

    // Writing one takes minutes, so this starts it and returns. The panel
    // finds the result by re-listing.
    if (req.url === "/prep/run" && req.method === "POST") {
      const { spawn } = require("child_process");
      const child = spawn("./prep-appointments.sh", [], {
        cwd: __dirname, detached: true, stdio: "ignore",
      });
      child.unref();
      return json(res, 200, { started: true });
    }
    return json(res, 404, { error: "unknown prep route" });
  }

  /* ---- email drafts ---- same shape as call prep, same reason: the draft is
     a file on the Mac and the moment it gets sent is not spent at the Mac. */
  if (req.url.startsWith("/drafts")) {
    const fs = require("fs"), path = require("path");
    const dir = path.join(__dirname, "drafts");

    if (req.url === "/drafts" && req.method === "GET") {
      let items = [];
      try {
        items = fs.readdirSync(dir).filter(f => f.endsWith(".md")).map(f => {
          const raw = fs.readFileSync(path.join(dir, f), "utf8");
          const grab = re => (raw.match(re) || [, ""])[1].trim();
          return {
            file: f,
            company: grab(/^#\s*(.+)$/m) || f.replace(/\.md$/, ""),
            to:      grab(/^To:\s*(.+)$/m),
            subject: grab(/^Subject:\s*(.+)$/m),
            // A draft with a NEEDS line is not sendable. The panel says so
            // rather than letting it look ready.
            needs:   grab(/^NEEDS:\s*(.+)$/m),
            written: fs.statSync(path.join(dir, f)).mtime.toISOString(),
          };
        }).sort((a, b) => a.company.localeCompare(b.company));
      } catch { /* no drafts dir yet */ }
      return json(res, 200, { items });
    }

    if (req.method === "GET" && /^\/drafts\/[^/]+$/.test(req.url)) {
      const name = decodeURIComponent(req.url.slice(8));
      if (name.includes("/") || name.includes("..") || !name.endsWith(".md"))
        return json(res, 400, { error: "bad draft name" });
      try { return json(res, 200, { name, text: fs.readFileSync(path.join(dir, name), "utf8") }); }
      catch { return json(res, 404, { error: "no such draft" }); }
    }

    if (req.url === "/drafts/run" && req.method === "POST") {
      const { spawn } = require("child_process");
      const child = spawn("./draft-emails.sh", [], {
        cwd: __dirname, detached: true, stdio: "ignore",
      });
      child.unref();
      return json(res, 200, { started: true });
    }
    return json(res, 404, { error: "unknown drafts route" });
  }

  /* ---- hiring engine ---- the client's own applicant intake. Separate from
     the pipeline: those are companies being sold to, these are people being
     hired by one of them. */
  if (req.url.startsWith("/applicant")) {
    const applicants = require("./applicants.js");
    const body = () => new Promise((ok, no) => {
      let raw = ""; req.on("data", c => { raw += c; if (raw.length > 4e6) req.destroy(); });
      req.on("end", () => { try { ok(JSON.parse(raw || "{}")); } catch (e) { no(e); } });
    });
    (async () => {
      try {
        if (req.url === "/applicants" || (req.url === "/applicant" && req.method === "GET"))
          return json(res, 200, { items: applicants.list() });

        if (req.url === "/applicant/parse" && req.method === "POST") {
          const b = await body();
          if (!b.text) return json(res, 400, { error: "text is required" });
          return json(res, 200, applicants.parseApplication(b.text, b));
        }

        // Parse and store in one call, so a forwarded email is one request.
        if (req.url === "/applicant/ingest" && req.method === "POST") {
          const b = await body();
          const parsed = b.text ? applicants.parseApplication(b.text, b) : {};
          const entry = { ...parsed, ...Object.fromEntries(
            Object.entries(b).filter(([k, v]) => k !== "text" && v)) };
          return json(res, 200, applicants.add(entry));
        }

        if (req.url === "/applicant/status" && req.method === "POST") {
          const b = await body();
          return json(res, 200, applicants.setStatus(b.id, b.status, b.note));
        }
        return json(res, 404, { error: "unknown applicant route" });
      } catch (e) { json(res, 400, { error: e.message }); }
    })();
    return;
  }

  /* One tap on a lead: record the outcome in pipeline.md, then mirror it to
     Notion. Notion failing must not lose the tap — pipeline.md is canonical
     and the 5am sync will carry it over. */
  if (req.method === "POST" && req.url === "/lead") {
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on("end", async () => {
      try {
        const body = JSON.parse(raw || "{}");
        const { company, note = "", due, next } = body;
        // One or many. A single string still works so nothing older breaks.
        const outcomes = (Array.isArray(body.outcome) ? body.outcome
                        : body.outcome ? [body.outcome] : []).filter(Boolean);
        if (!company) return json(res, 400, { error: "company is required" });
        if (!outcomes.length) return json(res, 400, { error: "at least one outcome is required" });
        const bad = outcomes.find(o => !(o in OUTCOME_STAGE));
        if (bad) return json(res, 400, { error: `unknown outcome "${bad}"` });
        if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return json(res, 400, { error: "due must be YYYY-MM-DD" });

        const local = markLead(company, outcomes, due, next);
        console.log("lead:", company, "->", outcomes.join(", "), due ? `(due ${due})` : "");

        let notion = null;
        try { notion = await upsert({ company, outcome: outcomes[0], note: note || outcomes.join(", "), stage: local.stage, due: local.due, next: local.next }); }
        catch (e) { notion = { error: e.message }; }

        json(res, 200, { ...local, notion });
      } catch (e) { json(res, 400, { error: e.message }); }
    });
    return;
  }

  if (req.method === "POST" && (req.url === "/note" || req.url === "/seed")) {
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on("end", async () => {
      try {
        const body    = JSON.parse(raw || "{}");
        const entries = Array.isArray(body) ? body : [body];
        const results = [];
        for (const e of entries) {
          try { results.push(await upsert(e)); }
          catch (err) { results.push({ action: "error", company: e.company, error: err.message }); }
        }
        json(res, 200, { results });
      } catch (err) {
        json(res, 400, { error: err.message });
      }
    });
    return;
  }

  json(res, 404, { error: "not found" });
}).listen(PORT, "127.0.0.1", async () => {
  console.log(`notes-bridge on http://localhost:${PORT}`);
  if (!TOKEN) {
    console.error("NOTION_TOKEN is not set — every write will fail.");
    return;
  }
  try { await ensureDb(); }
  catch (e) { console.error("Startup:", e.message); }
});
