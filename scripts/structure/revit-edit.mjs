// Send a batch of fmc_model_edit ops to the open Revit model (dry run unless "apply"); the reply is saved beside the ops.
//   node scripts/structure/revit-edit.mjs <ops.json> [dry|apply] ["why"]
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const B = new URL("../../server/build/", import.meta.url);
const { withRevitConnection } = await import(new URL("utils/ConnectionManager.js", B).href);
const [file, mode = "dry", why = "Formcraft structure (preliminary)"] = process.argv.slice(2);
const ops = JSON.parse(fs.readFileSync(file, "utf8")), dry = mode !== "apply";
const r = await withRevitConnection((c) => c.sendCommand("fmc_model_edit", { ops, dry_run: dry, why }, 1800000));
fs.writeFileSync(file.replace(/\.json$/, dry ? ".dry.out.json" : ".out.json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify({ applied: r.applied, batch: r.batch_id, failed_op: r.failed_op, reason: r.reason, ops: (r.ops ?? []).length }));
process.exit(r.failed_op ? 1 : 0);
