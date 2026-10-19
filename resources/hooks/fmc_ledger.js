// Formcraft ledger hook for JavaScript / Node (CommonJS or ESM). docs/AUTOMATION_BALANCE.md
// Records one run in %APPDATA%\Formcraft\ledger\external-YYYY-MM.jsonl: kind, script, ok, ms. No names, no data.
// Paste the function, then: const t0 = Date.now(); let ok = false; try { await main(); ok = true; } finally { fmcLedger("js", "tidy", ok, Date.now() - t0); }
// Or from any shell: node fmc_ledger.js <kind> <script> [ok|error] [ms]
// It never fails the script: any problem writing the line is ignored. The ledger stays on this PC.

function fmcLedger(kind, script, ok, ms, project = "") {
  try {
    const fs = process.getBuiltinModule ? process.getBuiltinModule("node:fs") : require("node:fs");
    const path = process.getBuiltinModule ? process.getBuiltinModule("node:path") : require("node:path");
    const dir = process.env.FMC_LEDGER_DIR || path.join(process.env.APPDATA || "", "Formcraft", "ledger");
    fs.mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    const line = { at, kind, script, ok: !!ok, ms: Math.round(ms), project, started_by: process.env.FMC_STARTED_BY || "person" };
    fs.appendFileSync(path.join(dir, `external-${at.slice(0, 7)}.jsonl`), JSON.stringify(line) + "\n");
  } catch {
    // never fail the script
  }
}

if (typeof process !== "undefined" && process.argv[1] && /fmc_ledger\.js$/i.test(process.argv[1])) {
  const [kind = "js", script = "(unnamed)", ok = "ok", ms = "0"] = process.argv.slice(2);
  fmcLedger(kind, script, ok !== "error", Number(ms) || 0);
}
