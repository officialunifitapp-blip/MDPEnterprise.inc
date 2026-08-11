// Tests the pipeline.md write-back in notes-bridge.js without starting a
// server: pulls the real functions out of the file and runs them against a
// scratch copy. Covers the "send an email" outcome added today.
const fs = require("fs");
const path = require("path");
const ROOT = require("path").join(__dirname, "..");
const WORK = require("fs").mkdtempSync(require("os").tmpdir() + "/mdp-otest-");

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.copyFileSync(ROOT + "/pipeline.md", WORK + "/pipeline.md");

const src = fs.readFileSync(ROOT + "/notes-bridge.js", "utf8");
const grab = (name, kw = "function") => {
  const i = src.indexOf(`${kw} ${name}`);
  if (i < 0) throw new Error("not found: " + name);
  let d = 0;
  for (let k = src.indexOf("{", i); k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}") { d--; if (!d) return src.slice(i, k + 1); }
  }
};
const constBlock = re => (src.match(re) || [])[0];

const ctx = [
  constBlock(/const OUTCOME_STAGE = \{[\s\S]*?\n\};/),
  constBlock(/const STAGE_RANK = \{.*?\};/),
  grab("stageFor"),
  grab("markLead"),
  constBlock(/const loose  = s => .*$/m),
  constBlock(/const strict = s => .*$/m),
  "const today = () => '2026-08-11';",
].join("\n");

const mod = new Function("__dirname", "require", ctx + "\nreturn { markLead, stageFor, OUTCOME_STAGE };")(WORK, require);

const row = co => fs.readFileSync(WORK + "/pipeline.md", "utf8")
  .split("\n").find(l => l.startsWith("| " + co + " |"));
const col = (co, n) => (row(co) || "").split("|").map(s => s.trim())[n];
const cols = co => (row(co) || "").split("|").length - 2;

let fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}\n        got:  ${JSON.stringify(got)}${ok ? "" : `\n        want: ${JSON.stringify(want)}`}`);
  if (!ok) fail++;
};

console.log('"send an email" is an accepted outcome:', "send an email" in mod.OUTCOME_STAGE);
console.log('it does not move the stage:', mod.OUTCOME_STAGE["send an email"] === null);

console.log("\n--- lead WITH an address ---");
const A = "Certi-Dry";
console.log("  before:", col(A, 5), "|", col(A, 8));
mod.markLead(A, ["send an email"], "", null);
check("next action names drafting", col(A, 5), "Send email — draft it");
check("email column preserved", col(A, 8), "info@certidry.com");
check("still 8 columns", cols(A), 8);

console.log("\n--- lead WITHOUT an address ---");
const B = "Vortex Restoration";
mod.markLead(B, ["send an email"], "", null);
check("next action names research", col(B, 5), "Find email address");
check("still 8 columns", cols(B), 8);

console.log("\n--- stage rules ---");
const C = "Fast Restoration";
const before = col(C, 3);
mod.markLead(C, ["send an email"], "", null);
check("emailing alone does not advance the stage", col(C, 3), before);

const D = "Murphree Restoration Inc";
mod.markLead(D, ["gatekeeper", "send an email"], "", null);
check("gatekeeper + email still does not advance", col(D, 3), "new");

const E = "On Call Restoration (CIFAL USA)";
mod.markLead(E, ["send an email", "spoke to owner"], "", null);
check("but spoke-to-owner in the same tap does", col(E, 3), "contacted");

console.log("\n--- appointment booked still wins over everything ---");
const F = "Murphree Restoration Inc";
mod.markLead(F, ["send an email", "appointment booked"], "2026-08-20", null);
check("stage", col(F, 3), "booked");
check("due date set", col(F, 6), "2026-08-20");
check("next action is the appointment, not the email", col(F, 5), "Appointment booked");

console.log("\n--- the outcome text is recorded on the row ---");
check("last touch", col(A, 4), "2026-08-11 send an email");

console.log("\n--- nothing lost ---");
const n0 = fs.readFileSync(ROOT + "/pipeline.md", "utf8").split("\n").filter(l => l.startsWith("| ")).length;
const n1 = fs.readFileSync(WORK + "/pipeline.md", "utf8").split("\n").filter(l => l.startsWith("| ")).length;
check("row count unchanged", n1, n0);

console.log(fail ? `\n${fail} FAILURES` : "\nALL OUTCOME LOGIC CORRECT");
process.exit(fail ? 1 : 0);
