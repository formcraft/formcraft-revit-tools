// Copies the repo data the server reads at run time into build/, so an installed server (staged from build/) has it
// too: docs/tracker/mep_matrix.json, the engineering grid (E0). From a checkout the server reads docs/tracker first.
import fs from "node:fs";

for (const [from, to] of [["../docs/tracker/mep_matrix.json", "build/mep_matrix.json"]]) {
  if (!fs.existsSync(from)) throw new Error(`ship-data: ${from} is missing`);
  fs.mkdirSync("build", { recursive: true });
  fs.copyFileSync(from, to);
}
