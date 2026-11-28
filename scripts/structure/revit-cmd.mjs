// Run one add-in command on the open Revit model: node scripts/structure/revit-cmd.mjs <command> '<json params>'
// e.g. revit-cmd.mjs fmc_revit_file '{"action":"save"}'
const B = new URL("../../server/build/", import.meta.url);
const { withRevitConnection } = await import(new URL("utils/ConnectionManager.js", B).href);
const r = await withRevitConnection((c) => c.sendCommand(process.argv[2], JSON.parse(process.argv[3] || "{}"), 600000));
console.log(JSON.stringify(r).slice(0, 4000)); process.exit(0);
