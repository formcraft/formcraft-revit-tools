/**
 * Summarise a Run-FmcBatch log. Place this file next to Run-FmcBatch.mjs.
 * Usage: node Run-FmcRunlog.mjs <RUN_ALL_log.txt | folder of result JSON>
 * Read-only. Prints one line per batch: PASS or FAIL, id, ops, ok, failed, FMC codes.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node Run-FmcRunlog.mjs <RUN_ALL_log.txt | folder>");
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.resolve(here, "..", "server", "build", "fmc", "runlog.js");
const mod = await import(pathToFileURL(built).href);
const summary = mod.summarisePath(path.resolve(target));
for (const error of summary.errors) console.error(error);
console.log(mod.formatRows(summary.rows));
process.exit(summary.rows.some((row) => row.failed > 0) ? 1 : summary.errors.length ? 2 : 0);
