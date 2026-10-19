// Runs the real server CLI for each tool against the fake Revit, with a guard file and folders of its own.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const repo = path.resolve(here, "..", "..");
const kit = process.env.FMC_KIT || "D:\\Fomcraft\\FMC_BIM_27\\FMC_Kit_v2.2\\FMC_Kit_v2.2";
if (!fs.existsSync(path.join(kit, "FMC_Kit.json"))) { console.log(`No kit at ${kit}: set FMC_KIT. Skipped.`); process.exit(0); }
const work = path.join(process.env.TEMP || process.env.TMPDIR || here, "fmc-e2e");
fs.rmSync(work, { recursive: true, force: true });
const proj = path.join(work, "Projects", "F26001");
for (const d of ["01_WIP", "02_Shared", "06_QA"]) fs.mkdirSync(path.join(proj, d), { recursive: true });
const guard = {
  write_roots: [path.join(work, "Projects", "*", "01_WIP")], template_roots: [path.join(kit, "06_Templates")], library_roots: [],
  blocked_segments: ["02_Shared", "03_Published", "04_Archive", "05_Incoming"], live_model_lock: true, reports_dir: path.join(work, "reports"), max_backups: 3,
  specs_path: path.join(kit, "03_Master_Data", "FMC_Family_Specs.json"), shared_parameter_file: path.join(kit, "01_Shared_Parameters", "FMC_SharedParameters.txt"),
  family_staging_root: path.join(kit, "04_Families", "_Staging"), rulebooks_dir: path.join(kit, "03_Master_Data", "FMC_Rulebook"),
  keynote_file: path.join(kit, "02_Keynotes", "FMC_Keynotes.txt"),
};
fs.writeFileSync(path.join(work, "fmc_guard.json"), JSON.stringify(guard, null, 2));
const cis = path.join(repo, "tests", "brief", "F26001_CIS_sample.json");

const cases = [
  ["fmc_selftest", {}], ["fmc_revit", { action: "list" }],
  ["fmc_brief", { action: "plan", cis_file: cis, kit_folder: kit }], ["fmc_brief", { action: "apply", cis_file: cis, kit_folder: kit }],
  ["fmc_brief", { action: "apply", cis_file: cis, kit_folder: kit, dry_run: false }],
  ["fmc_scripts", { action: "list", kit_folder: kit }],
  ["fmc_scripts", { action: "run", name: "Before sync", steps: ["selftest", "qa", "workshare"], kit_folder: kit, project_folder: proj }],
  ["fmc_scripts", { action: "run", name: "Friday", steps: ["qa", "review", "report"], kit_folder: kit, project_folder: proj, project_code: "F26001" }],
  ["fmc_systems", { action: "electrical", project_folder: proj, save: true }], ["fmc_systems", { action: "structural", kit_folder: kit, project_folder: proj, save: true }],
  ["fmc_calc", { action: "list", kit_folder: kit }], ["fmc_calc", { action: "run", kit_folder: kit }],
  ["fmc_calc", { action: "sheet", kit_folder: kit, project_folder: proj }], ["fmc_calc", { action: "sheet", kit_folder: kit, project_folder: proj, dry_run: false }],
  ["fmc_build", { action: "quantities", kit_folder: kit, project_folder: proj }], ["fmc_build", { action: "baseline", kit_folder: kit, project_folder: proj }],
  ["fmc_build", { action: "quantities", kit_folder: kit, project_folder: proj }],
  ["fmc_links", { action: "audit", link_from: path.join(proj, "02_Shared") }], ["fmc_workshare", { action: "facts" }],
  ["fmc_annotate", { action: "check" }], ["fmc_annotate", { action: "standard" }],
  ["fmc_qa", { action: "rules" }], ["fmc_qa", { action: "run", project_folder: proj }],
  ["fmc_review", { action: "list", project_folder: proj }], ["fmc_report", { action: "make", project_folder: proj, project_code: "F26001" }],
  ["fmc_report", { action: "make", project_folder: proj, project_code: "F26001", dry_run: false }], ["fmc_report", { action: "list", project_folder: proj }],
  ["fmc_issue", { action: "check", register: path.join(kit, "03_Master_Data", "FMC_Sheet_Register.csv"), project_folder: proj }],
  ["fmc_sheets", { action: "compare", register: path.join(kit, "03_Master_Data", "FMC_Sheet_Register.csv") }],
  ["fmc_material", { action: "database" }], ["fmc_material", { action: "audit" }],
  ["fmc_library", { action: "parameters" }], ["fmc_library", { action: "keynotes" }],
  ["fmc_project", { action: "plan", project_folder: path.join(work, "Projects", "F26002"), code: "F26002", roles: ["A", "S"] }],
  ["fmc_file", { action: "list_open" }], ["fmc_template", { action: "recipe", template_path: "base.rte", kit_folder: kit }], ["fmc_ai", { action: "status" }], ["fmc_recipe", { action: "check", recipe_file: path.join(repo, "tests", "doc", "FMC_P_MechEq_WaterHeater_Instant.ops.json") }], ["fmc_doc", { action: "list" }], ["ask_status", {}],
  ["fmc_robot", { action: "status" }], ["fmc_navis", { action: "status" }], ["fmc_robot", { action: "send", supports: "Fixed", engineer: "E2E", cases: [{ name: "G", nature: "PERMANENT", self_weight: true }] }],
];

const port = 8099;
const results = [];
const writes = [
  ["fmc_brief", { action: "apply", cis_file: cis, kit_folder: kit, dry_run: false }],
  ["fmc_sheets", { action: "create", register: path.join(kit, "03_Master_Data", "FMC_Sheet_Register.csv"), dry_run: false }],
  ["fmc_links", { action: "pin", dry_run: false }],
  ["fmc_material", { action: "purge", dry_run: false }],
  ["fmc_review", { action: "cloud", project_folder: proj, dry_run: false }],
  ["fmc_workshare", { action: "create", dry_run: false }],
];
for (const mode of ["rich", "empty", "live"]) {
  const list = mode === "live" ? writes : cases;
  const fake = spawn(process.execPath, [path.join(here, "fake_revit.mjs")], { env: { ...process.env, FAKE_PORT: String(port), FAKE_MODE: mode === "live" ? "rich" : mode, FAKE_LIVE: mode === "live" ? "1" : "0", KIT: kit, FAKE_LOG: path.join(work, `calls_${mode}.jsonl`) } });
  await new Promise((r) => setTimeout(r, 700));
  for (const [tool, args] of list) {
    const r = spawnSync(process.execPath, [path.join(repo, "server", "build", "fmc", "cli.js"), tool], {
      input: JSON.stringify(args), encoding: "utf8", timeout: 120000,
      env: { ...process.env, REVIT_PORT: String(port), FMC_GUARD_CONFIG: path.join(work, "fmc_guard.json"), ANTHROPIC_API_KEY: "", APPDATA: path.join(work, "appdata") },
    });
    let body = null, parse = "";
    try { body = JSON.parse(r.stdout); } catch (e) { parse = "NOT JSON: " + (r.stdout || "").slice(0, 200) + " | " + (r.stderr || "").slice(-300); }
    const text = JSON.stringify(body ?? {});
    const crash = /TypeError|ReferenceError|Cannot read properties|is not a function|undefined is not|NaN/.test(text + parse);
    const err = body?.error ?? (body?.refused ? "refused: " + (body.reasons || []).join(" ") : "");
    results.push({ mode, tool, action: args.action ?? "", exit: r.status, crash, parse, err: String(err).slice(0, 220), keys: body ? Object.keys(body).slice(0, 8).join(",") : "" });
  }
  fake.kill();
}
for (const x of results) console.log(`${x.mode.padEnd(5)} ${x.crash ? "CRASH" : x.parse ? "BADJSON" : x.err ? "error" : "ok   "} ${(x.tool + " " + x.action).padEnd(26)} exit=${x.exit} ${x.parse || x.err || x.keys}`);
fs.writeFileSync(path.join(work, "results.json"), JSON.stringify(results, null, 2));
// Fails on a crash or an unreadable reply anywhere, or on any real write reaching Revit while a live model is open.
const writeCmd = /"method":"(fmc_brief_apply|fmc_sheet_create|fmc_sheet_rename|fmc_link_pin|fmc_link_add|fmc_material_assign|fmc_material_purge|fmc_review_cloud|fmc_workset_create)"/;
const liveLog = path.join(work, "calls_live.jsonl");
const liveWrites = fs.existsSync(liveLog)
  ? fs.readFileSync(liveLog, "utf8").split("\n").filter((l) => writeCmd.test(l) && !l.includes('"dry_run":true'))
  : [];
const bad = results.filter((x) => x.crash || x.parse).length + liveWrites.length;
console.log(`\n${results.length} runs, ${bad} problems${liveWrites.length ? ` (${liveWrites.length} writes reached Revit on a live model)` : ""}`);
process.exit(bad ? 1 : 0);
