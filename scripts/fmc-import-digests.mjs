// Folds standards digests (one JSON per document) into the kit's FMC_Standards_Building.json and
// FMC_Standards_Sources.json (owner 27 Oct). Dry run by default: prints what would be added, corroborated and in
// conflict. --apply writes both files (a .bak of each first). Needs the server built (uses build/fmc/stdimport.js).
//   node scripts/fmc-import-digests.mjs <digests folder> [--kit <03_Master_Data folder>] [--resolutions <file>] [--apply] [--all]
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : d);
const dir = args.find((a) => !a.startsWith("--") && ![opt("--kit"), opt("--pdfs"), opt("--resolutions")].includes(a));
if (!dir) { console.error("usage: fmc-import-digests.mjs <digests folder> [--kit <folder>] [--pdfs <folder>] [--apply] [--all]"); process.exit(2); }
const kitDir = opt("--kit", "D:/Fomcraft/FMC_BIM_27/FMC_Kit_v2.2/FMC_Kit_v2.2/03_Master_Data");
const pdfs = opt("--pdfs");
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const { mergeDigest, applyResolutions } = await import(pathToFileURL(path.join(here, "..", "server", "build", "fmc", "stdimport.js")).href);

const read = (f) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
const kitFile = path.join(kitDir, "FMC_Standards_Building.json"), regFile = path.join(kitDir, "FMC_Standards_Sources.json");
let kit = read(kitFile), reg = read(regFile);
const totals = { docs: 0, added: 0, corroborated: 0, conflicts: 0, skipped: 0 };
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
  const d = read(path.join(dir, f));
  if (!d.id) { console.log(`skip ${f}: no id`); continue; }
  // the PDF's fingerprint ties the record to the exact file (and to read_pdf's cache)
  if (pdfs && d.file && fs.existsSync(path.join(pdfs, d.file))) d.sha256 = createHash("sha256").update(fs.readFileSync(path.join(pdfs, d.file))).digest("hex");
  const r = mergeDigest(kit, reg, d, { all: flag("--all") });
  kit = r.kit; reg = r.reg; totals.docs++;
  for (const k of ["added", "corroborated", "conflicts", "skipped"]) totals[k] += r.report[k].length;
  console.log(`${d.id.padEnd(34)} +${r.report.added.length} new  =${r.report.corroborated.length} same  !${r.report.conflicts.length} conflict  -${r.report.skipped.length} skipped`);
  for (const c of r.report.conflicts) console.log(`    ! ${c.key}: kit ${JSON.stringify(c.kit)} vs ${JSON.stringify(c.doc)} ${c.clause ?? ""}`);
}
// decisions on the conflicts (one file, kept beside the digests so a re-run repeats them)
const resFile = opt("--resolutions");
if (resFile) {
  const r = applyResolutions(kit, reg, read(resFile));
  kit = r.kit; reg = r.reg;
  console.log(`\nresolutions: ${r.applied.length} applied${r.missing.length ? `; not found: ${r.missing.join(", ")}` : ""}`);
  const open = Object.entries(kit.standards).filter(([, e]) => e.conflicts?.length).map(([k]) => k);
  console.log(open.length ? `still in conflict: ${open.join(", ")}` : "no conflicts left");
}
console.log(`\n${totals.docs} digests: ${totals.added} new keys, ${totals.corroborated} corroborated, ${totals.conflicts} conflicts, ${totals.skipped} skipped`);
if (!flag("--apply")) { console.log("dry run: nothing written (--apply writes the kit)"); process.exit(0); }
const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
for (const [f, data] of [[kitFile, kit], [regFile, reg]]) {
  fs.copyFileSync(f, `${f}.bak-${stamp}`);
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + "\n");
}
console.log(`written: ${kitFile}, ${regFile} (backups .bak-${stamp})`);
