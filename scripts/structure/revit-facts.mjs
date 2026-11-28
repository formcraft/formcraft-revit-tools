// Read the open Revit model's structure facts (fmc_struct_facts) and save them in full: the audit compares the
// analysed frame against what is in the model now.
//   node scripts/structure/revit-facts.mjs <out json> ['<json params>']
import fs from "node:fs";
const B = new URL("../../server/build/", import.meta.url);
const { withRevitConnection } = await import(new URL("utils/ConnectionManager.js", B).href);
const r = await withRevitConnection((c) => c.sendCommand("fmc_struct_facts", JSON.parse(process.argv[3] || "{}"), 600000));
fs.writeFileSync(process.argv[2], JSON.stringify(r, null, 1)); setTimeout(() => process.exit(0), 50);
console.log(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Array.isArray(v) ? v.length : typeof v === "object" ? Object.keys(v ?? {}).length : v])));
