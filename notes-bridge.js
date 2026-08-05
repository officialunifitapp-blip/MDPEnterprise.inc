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
let   SCOUT_DB = process.env.SCOUT_DB || "";

const STAGES   = ["new","contacted","replied","booked","call held","proposal","won","lost"];
const OUTCOMES = ["no answer","voicemail","gatekeeper","spoke to owner","callback set","demo sent","not interested"];

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

async function upsert(entry) {
  await ensureDb();
  const { company, note = "", contact = "", phone = "", stage, seed } = entry;
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
  if (note && existing.includes(note)) {
    return { action: "skipped", company, reason: "note already logged" };
  }

  const props = {};
  if (dated) {
    props["Note"]       = { rich_text: rt(existing ? existing + "\n" + dated : dated) };
    props["Last touch"] = { date: { start: today() } };
  }
  if (outcome)  props["Outcome"] = { select: { name: outcome } };
  if (newStage) props["Stage"]   = { select: { name: newStage } };
  if (phone && !row.properties.Phone?.phone_number) props["Phone"] = { phone_number: phone };

  await notion(`/pages/${row.id}`, "PATCH", { properties: props });
  return { action: "appended", company, outcome, stage: newStage || null };
}

/* ---- http ---- */
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};
const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(obj));
};

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }

  if (req.url === "/health") {
    return json(res, 200, { ok: !!TOKEN, db: DB || null, hasToken: !!TOKEN });
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

  /* ---- Depop Resale Scout ---- analyses Depop's own notification emails.
     Never scrapes Depop, never buys anything. Purchases are manual. */
  if (req.url.startsWith("/scout")) {
    const scout = require("./scout.js");
    const body = () => new Promise((ok, no) => {
      let raw = ""; req.on("data", c => { raw += c; if (raw.length > 4e6) req.destroy(); });
      req.on("end", () => { try { ok(JSON.parse(raw || "{}")); } catch (e) { no(e); } });
    });
    (async () => {
      try {
        if (req.url === "/scout/config" && req.method === "GET")  return json(res, 200, scout.loadConfig());
        if (req.url === "/scout/config" && req.method === "POST") return json(res, 200, scout.saveConfig(await body()));

        const db = SCOUT_DB || (SCOUT_DB = await scout.ensureScoutDb(notion, PARENT, process.env.SCOUT_DB));

        if (req.url.startsWith("/scout/opportunities")) {
          const rating = (req.url.match(/[?&]rating=(BUY|REVIEW|PASS)/) || [])[1];
          return json(res, 200, { items: await scout.listOpportunities(notion, db, { rating }) });
        }

        if (req.url === "/scout/analyze" && req.method === "POST") {
          const b = await body();
          if (!b.html) return json(res, 400, { error: "html is required" });
          const cfg = scout.loadConfig();
          const out = await scout.ingestEmail(b, cfg, {});
          if (out.rejected) return json(res, 200, out);
          const stored = [];
          for (const o of out.results) stored.push({ ...o, ...(await scout.upsertOpportunity(notion, db, o)) });
          const fresh = stored.filter(s => s.action === "created");
          return json(res, 200, {
            parsed: out.parsed,
            created: fresh.length,
            duplicates: stored.length - fresh.length,
            buys: fresh.filter(s => s.rating === "BUY").length,
            results: stored,
          });
        }
        return json(res, 404, { error: "unknown scout route" });
      } catch (e) { json(res, 500, { error: e.message }); }
    })();
    return;
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
