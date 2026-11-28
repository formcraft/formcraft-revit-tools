// Run one add-in command on the open Revit model and save its whole reply as JSON (revit-cmd.mjs prints a slice only).
//   node scripts/structure/revit-cmd-save.mjs <command> '<json params>' <out json>
import fs from "node:fs";
const B = new URL("../../server/build/", import.meta.url);
const { withRevitConnection } = await import(new URL("utils/ConnectionManager.js", B).href);
const [cmd, params = "{}", out] = process.argv.slice(2);
const r = await withRevitConnection((c) => c.sendCommand(cmd, JSON.parse(params), 600000));
fs.writeFileSync(out, JSON.stringify(r, null, 1));
console.log(out, Object.keys(r ?? {}).join(", "));
setTimeout(() => process.exit(0), 50);
