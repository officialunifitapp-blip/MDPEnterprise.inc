// Headless render check for index.html. Loads the real page script against a
// minimal DOM shim and real pipeline.md / drafts data, then renders every
// panel and every filter. Catches the class of bug that only shows up when a
// panel is actually opened on the phone.
const fs = require("fs");
const ROOT = require("path").join(__dirname, "..");
const js = fs.readFileSync(ROOT + "/index.html", "utf8").match(/<script>([\s\S]*)<\/script>/)[1];

let won = false, inUn = false, unreach = 0;
const leads = [];
for (const line of fs.readFileSync(ROOT + "/pipeline.md", "utf8").split("\n")) {
  if (/^##\s*Unreachable/i.test(line)) { inUn = true; continue; }
  if (inUn) {
    if (line.startsWith("| ")) { const c = line.split("|").map(x => x.trim()); if (c[1] && c[1] !== "Company") unreach++; }
    continue;
  }
  if (/^##\s*Won/i.test(line)) won = true;
  if (won || !line.startsWith("| ")) continue;
  const c = line.split("|").map(x => x.trim());
  if (!c[1] || c[1] === "Company") continue;
  const st = (c[3] || "").toLowerCase();
  if (!["new","contacted","replied","booked","call held","proposal","won","lost"].includes(st)) continue;
  const m = (c[2] || "").match(/\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}/);
  const lt = c[4] || "", tail = lt.slice(10).trim(), em = (c[8] || "").trim();
  leads.push({ co: c[1], c: c[2], who: "", p: m ? m[0] : "", st, last: lt, next: c[5] || "",
               due: c[6] || "", niche: c[7] || "Restoration", em: /@/.test(em) ? em : "",
               out: (tail && tail !== "sourced") ? tail : "" });
}

const drafts = fs.existsSync(ROOT + "/drafts")
  ? fs.readdirSync(ROOT + "/drafts").filter(f => f.endsWith(".md")).map(f => {
      const raw = fs.readFileSync(ROOT + "/drafts/" + f, "utf8");
      const g = re => (raw.match(re) || [, ""])[1].trim();
      return { file: f, company: g(/^#\s*(.+)$/m), to: g(/^To:\s*(.+)$/m),
               subject: g(/^Subject:\s*(.+)$/m), needs: g(/^NEEDS:\s*(.+)$/m) };
    })
  : [];

const el = () => ({
  classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
  textContent: "", innerHTML: "", value: "", style: {}, dataset: {},
  querySelector: () => null, querySelectorAll: () => [], appendChild() {},
  focus() {}, select() {}, setAttribute() {}, addEventListener() {}, removeEventListener() {},
  getContext: () => ({
    setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
    moveTo() {}, lineTo() {}, fillText() {}, closePath() {}, rect() {},
    measureText: () => ({ width: 10 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
  }),
  getBoundingClientRect: () => ({ width: 900, height: 600, top: 0, left: 0 }),
  scrollTop: 0, scrollHeight: 0, width: 0, height: 0,
});

for (const [k, v] of Object.entries({
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { search: "", hostname: "localhost", pathname: "/", href: "" },
  history: { replaceState() {} },
  fetch: () => Promise.reject(new Error("offline")),
  document: { getElementById: el, querySelector: el, querySelectorAll: () => [],
              createElement: el, body: el(), addEventListener() {} },
  addEventListener() {}, devicePixelRatio: 1, requestAnimationFrame() {}, alert() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
})) { try { globalThis[k] = v; } catch (e) {} }

let mod;
try {
  mod = new Function(js + `
    DATA.leads=arguments[0];DATA.unreachable=arguments[1];DATA.status=null;DATA.counts={};
    DATA.drafts={items:arguments[2],open:null,text:"",busy:false,err:null};
    DATA.prep={items:[],open:null,text:"",busy:false,err:null};
    return {leadTable,emailPanel,managerPanel,notesPanel,scriptsPanel,prepPanel,
            setEMF:v=>{EMF=v},setCALLED:v=>{CALLED=v},setSCF:v=>{SCF=v},OFFER};
  `)(leads, unreach, drafts);
} catch (e) { console.log("SETUP FAILED:", e.message); process.exit(1); }

let bad = 0;
const run = (label, fn) => {
  try {
    const o = fn();
    const ok = typeof o === "string" && o.length > 50;
    console.log((ok ? "  OK   " : "  THIN ") + label.padEnd(14) + String(o.length).padStart(7) + " chars");
    if (!ok) bad++;
    return o;
  } catch (e) { console.log("  FAIL  " + label.padEnd(14) + e.message); bad++; return ""; }
};

console.log(`leads ${leads.length} · with email ${leads.filter(l => l.em).length} · no phone ${leads.filter(l => !l.p).length} · drafts ${drafts.length} · quarantined ${unreach}`);
console.log("\n--- panels ---");
["leadTable","emailPanel","managerPanel","notesPanel","scriptsPanel","prepPanel"]
  .forEach(p => run(p, mod[p]));

console.log("\n--- email filters ---");
["all","ready","todo","noaddr"].forEach(f => { mod.setEMF(f); run("EMF=" + f, mod.emailPanel); });

console.log("\n--- lead filters ---");
["all","no","yes","due","em"].forEach(f => { mod.setCALLED(f); run("CALLED=" + f, mod.leadTable); });

console.log("\n--- scripts tabs ---");
["offer","openers","objections"].forEach(f => { mod.setSCF(f); run("SCF=" + f, mod.scriptsPanel); });

// The offer panel has to carry all six systems, or a call is being made from
// a shorter list than the one that was agreed.
mod.setSCF("offer");
const offerPanel = mod.scriptsPanel();
// Names are HTML-escaped in the panel ("&" -> "&amp;"), so compare escaped.
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const missing = mod.OFFER.filter(o => !offerPanel.includes(esc(o[0])));
console.log(`  six systems rendered: ${mod.OFFER.length - missing.length}/6`);
if (missing.length || mod.OFFER.length !== 6) { console.log("  MISSING:", missing.map(o => o[0]).join(", ")); bad++; }

// The dashboard must not drift from business-context.md.
const bc = fs.readFileSync(ROOT + "/business-context.md", "utf8");
const drift = mod.OFFER.filter(o => !bc.includes(o[0]));
console.log(`  matching business-context.md: ${mod.OFFER.length - drift.length}/6`);
if (drift.length) { console.log("  NOT IN business-context.md:", drift.map(o => o[0]).join(", ")); bad++; }

// The join that makes "tap a lead, see its draft" work at all.
mod.setEMF("all");
const panel = mod.emailPanel();
const linked = drafts.filter(d => panel.includes(`data-draft="${d.file}"`)).length;
console.log(`\n--- draft links wired into the panel: ${linked}/${drafts.length} ---`);
if (linked !== drafts.length) { console.log("  MISSING:", drafts.filter(d => !panel.includes(d.file)).map(d => d.file).join(", ")); bad++; }

console.log(bad ? `\n${bad} FAILURES` : "\nEVERY PANEL, FILTER AND DRAFT LINK RENDERS CLEAN");
process.exit(bad ? 1 : 0);
