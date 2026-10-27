// Copies the repo data the server reads at run time into build/, so an installed server (staged from build/) has it
// too: docs/tracker/mep_matrix.json, the engineering grid (E0). From a checkout the server reads docs/tracker first.
import fs from "node:fs";

for (const [from, to] of [["../docs/tracker/mep_matrix.json", "build/mep_matrix.json"]]) {
  if (!fs.existsSync(from)) throw new Error(`ship-data: ${from} is missing`);
  fs.mkdirSync("build", { recursive: true });
  fs.copyFileSync(from, to);
}

// owner 27 Oct: the PDF reader's pdf.js (Apache-2.0) travels inside build/ too: the installed server gets build/ only
const pdfjs = "node_modules/pdfjs-dist";
if (!fs.existsSync(`${pdfjs}/legacy/build/pdf.mjs`)) throw new Error("ship-data: pdfjs-dist is missing (npm ci)");
fs.mkdirSync("build/vendor/pdfjs", { recursive: true });
for (const f of ["pdf.mjs", "pdf.worker.mjs"]) fs.copyFileSync(`${pdfjs}/legacy/build/${f}`, `build/vendor/pdfjs/${f}`);
for (const d of ["cmaps", "standard_fonts"]) fs.cpSync(`${pdfjs}/${d}`, `build/vendor/pdfjs/${d}`, { recursive: true });
fs.copyFileSync(`${pdfjs}/LICENSE`, "build/vendor/pdfjs/LICENSE");
