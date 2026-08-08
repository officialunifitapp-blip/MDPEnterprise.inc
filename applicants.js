/*
 * Applicant intake for the hiring engine.
 *
 * v1 sends nothing. The owner's own phone sends the text, via an sms: link
 * with the message already written — so there is no A2P traffic, no 10DLC
 * brand, no carrier review, and nothing to wait for. It still collapses the
 * response time from Monday afternoon to about two minutes, which is the part
 * that actually wins the candidate.
 *
 * Automated sending replaces the tap later, once registration clears. The
 * data model does not change when it does.
 */

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "applicants.json");

const load = () => {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch { return { applicants: [] }; }
};
const save = s => { fs.writeFileSync(FILE, JSON.stringify(s, null, 2)); return s; };

const STATUSES = ["new", "texted", "replied", "screened", "booked", "hired", "passed"];

/* ---- parsing ----
   Job boards each format their notification differently and change it without
   warning, so this pulls what it can and never throws. A field it cannot find
   is left blank for the owner to fill, which is visible; a guessed field is
   not. */

const strip = html => String(html || "")
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/(p|div|tr|h\d)>/gi, "\n")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
  .replace(/&#39;|&rsquo;/gi, "'").replace(/&quot;/gi, '"')
  .replace(/[ \t]+/g, " ")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const PHONE = /(?:\+1[ .-]?)?\(?(\d{3})\)?[ .-]?(\d{3})[ .-]?(\d{4})\b/;
const EMAIL = /\b[\w.+-]+@(?!indeedemail|indeed\.com|ziprecruiter|facebookmail)[\w.-]+\.\w{2,}\b/i;

function parseApplication(raw, hint = {}) {
  const text = strip(raw);
  const out = { name: "", phone: "", email: "", role: "", source: hint.source || "", raw: text.slice(0, 4000) };

  if (/indeed/i.test(raw)) out.source = out.source || "Indeed";
  else if (/ziprecruiter/i.test(raw)) out.source = out.source || "ZipRecruiter";
  else if (/facebook/i.test(raw)) out.source = out.source || "Facebook";

  const ph = text.match(PHONE);
  if (ph) out.phone = `(${ph[1]}) ${ph[2]}-${ph[3]}`;

  const em = text.match(EMAIL);
  if (em) out.email = em[0];

  // "Marcus Ellery applied to Water Damage Technician" and the handful of
  // phrasings the boards actually use.
  const pats = [
    /^\s*(.+?)\s+applied (?:to|for)\s+(?:your\s+)?(?:job[:,]?\s*)?(.+?)\s*$/mi,
    /new application (?:from|by)\s+(.+?)\s+for\s+(.+?)\s*$/mi,
    /candidate[:\s]+(.+?)\n[\s\S]{0,80}?position[:\s]+(.+?)\n/i,
  ];
  for (const p of pats) {
    const m = text.match(p);
    if (m) { out.name = m[1].trim(); out.role = m[2].trim(); break; }
  }
  if (!out.name) {
    const m = text.match(/^\s*name[:\s]+(.+?)\s*$/mi);
    if (m) out.name = m[1].trim();
  }
  if (!out.role) {
    const m = text.match(/^\s*(?:job|position|role)[:\s]+(.+?)\s*$/mi);
    if (m) out.role = m[1].trim();
  }

  // A "name" longer than a name is a sentence the pattern grabbed by accident.
  if (out.name.length > 60 || /\d/.test(out.name)) out.name = "";
  if (out.role.length > 80) out.role = "";

  return out;
}

/* ---- store ---- */

function add(entry) {
  const s = load();
  const a = {
    id: "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: (entry.name || "").trim(),
    phone: (entry.phone || "").trim(),
    email: (entry.email || "").trim(),
    role: (entry.role || "").trim(),
    source: (entry.source || "manual").trim(),
    note: (entry.note || "").trim(),
    status: "new",
    at: new Date().toISOString(),
    history: [],
  };
  if (!a.name && !a.phone) throw new Error("an applicant needs at least a name or a phone number");

  // Same person applying twice on two boards is one applicant, not two.
  const digits = p => p.replace(/\D/g, "");
  if (a.phone) {
    const dup = s.applicants.find(x => x.phone && digits(x.phone) === digits(a.phone));
    if (dup) return { action: "duplicate", applicant: dup };
  }
  s.applicants.unshift(a);
  save(s);
  return { action: "added", applicant: a };
}

function setStatus(id, status, note) {
  if (!STATUSES.includes(status)) throw new Error(`unknown status "${status}"`);
  const s = load();
  const a = s.applicants.find(x => x.id === id);
  if (!a) throw new Error("no such applicant");
  a.history.push({ from: a.status, to: status, at: new Date().toISOString() });
  a.status = status;
  if (note) a.note = note;
  save(s);
  return a;
}

const list = () => load().applicants;

module.exports = { parseApplication, add, setStatus, list, STATUSES, strip };
