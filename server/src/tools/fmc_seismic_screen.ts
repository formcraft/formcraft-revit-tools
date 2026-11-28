import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, isInside, loadConfig } from "../fmc/policy.js";
import { kitPaths } from "../fmc/context.js";
import { formcraftDir } from "../fmc/aiuse_io.js";
import { startedByFrom } from "../fmc/ledger.js";
import { StandardsFile, resolve } from "../fmc/standards.js";
import {
  CHECKLIST, CSV_HEAD, DEMO_INPUTS, KitLookup, ModelFacts, ScreeningDb, ScreeningInput, ScreeningRecord, buildRecord, buildingReport, csvRows,
  demoModelFields, emptyDb, fieldsFromModel, formView, kitLookup, nextId, parseDb, registerReport, toGeoJson, toHtml, toMarkdown, upsert, validateInput,
} from "../fmc/seismic.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

const win = path.win32;
const DB_NAME = "FMC_Seismic_Screening.json";

export const FMC_SEISMIC_SCREEN_DESCRIPTION =
  "Formcraft NBRB seismic screening form and building database (G028). Read-only on the Revit model; it writes only its own " +
  "database and report files (dry run first). action form: the blank screening form (fields, checklist, the kit's seismic " +
  "choices). prefill {id?, fields?, checklist?, link?}: a draft record from the open model (storeys, height, floor area, " +
  "plan, wall material, columns, beams, foundations) and the kit, with every value marked model, entered, worked out or " +
  "TBC; writes nothing. save {id? (update), fields, checklist, status?, from_model?}: puts the record in the database, " +
  "a dry run unless dry_run is false. list / get {id}: the register or one record. report {id?}: a building committee " +
  "report (Markdown and HTML) for one building, or with no id the whole register plus CSV and GeoJSON for the map; dry run " +
  "unless dry_run is false. seed_demo: three fictional demo buildings for the NBRB demo (dry run first). Seismic factors " +
  "(zone, coefficient, importance, K) come only from the kit's seismic.* standards (US 319:2003); a value the kit lacks is " +
  "TBC, never guessed. Cd is indicative, for screening only. The outcome is the inspector's choice. The database lives in " +
  "<project>\\01_WIP\\_Screening when project_folder is given and allowed, else in the reports folder's Screening; never in a model.";

const ANSWER = z.enum(["yes", "no", "unknown", "n/a"]);

export const FMC_SEISMIC_SCREEN_SHAPE = {
  action: z.enum(["form", "prefill", "save", "list", "get", "report", "seed_demo"]).optional().default("form"),
  id: z.string().optional().describe("A record id (SS-0001, DEMO-0001). save with an id updates that record; get and report read it."),
  fields: z.record(z.any()).optional().describe("Form values the person entered, by field key (action form lists them). null clears a value."),
  checklist: z.record(z.union([ANSWER, z.object({ answer: ANSWER, note: z.string().optional() })])).optional()
    .describe("Checklist answers by item key: yes, no, unknown or n/a, optionally with a note"),
  status: z.enum(["draft", "submitted", "archived"]).optional().describe("save: the record's status. Nothing is deleted: archive hides a record from the register."),
  from_model: z.boolean().optional().describe("Read the open model (fmc_struct_facts, read-only). Default true for prefill and a new record, false when updating a record."),
  link: z.string().optional().describe("Read a linked model instead of the host (part of its name)"),
  database: z.string().optional().describe("Absolute path of the database .json (default: see the description)"),
  project_folder: z.string().optional().describe("The project folder holding 01_WIP: the database goes in 01_WIP\\_Screening"),
  expected_revision: z.number().int().optional().describe("save: refuse when the database changed since this revision"),
  include_archived: z.boolean().optional().default(false),
  dry_run: z.boolean().optional().default(true),
};

export type FmcSeismicArgs = z.infer<z.ZodObject<typeof FMC_SEISMIC_SCREEN_SHAPE>>;

export interface SeismicDeps {
  config?: GuardConfig;
  facts?: (link?: string) => Promise<ModelFacts>;
  kit?: { file: string; data: StandardsFile | null; project?: Record<string, unknown> | null };
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T; } catch { return null; }
}

function log(cfg: GuardConfig, action: string, dryRun: boolean, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = win.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dryRun, target, result, detail]));
  } catch {
    // logging must never block the work
  }
}

/** The kit's seismic.* values with the project's standards on top (the same files fmc_standards reads). */
function loadKit(cfg: GuardConfig, projectFolder: string, deps: SeismicDeps): { kit: KitLookup; file: string; version: string; status: string; found: boolean } {
  let file: string; let data: StandardsFile | null; let project: Record<string, unknown> | null = null;
  if (deps.kit) { file = deps.kit.file; data = deps.kit.data; project = deps.kit.project ?? null; }
  else {
    file = win.join(win.dirname(kitPaths(cfg).recipesDir), "FMC_Standards_Building.json");
    data = readJson<StandardsFile>(file);
    if (projectFolder) project = readJson<Record<string, unknown>>(win.join(projectFolder, "01_WIP", "FMC_Project_Standards.json"));
  }
  return { kit: kitLookup(resolve(data, project)), file, version: data?.version ?? "missing", status: data?.status?.split(":")[0] ?? "missing", found: !!data };
}

/** Where the database lives: the given file, the project's 01_WIP\_Screening, or the reports folder. Never a model file. */
export function databasePath(args: Pick<FmcSeismicArgs, "database" | "project_folder">, cfg: GuardConfig): { file?: string; reasons?: string[]; note?: string } {
  const reportsRoot = expandEnv(cfg.reports_dir);
  if (args.database?.trim()) {
    const file = args.database.trim();
    const reasons: string[] = [];
    if (!/\.json$/i.test(file)) reasons.push("The database is a .json file");
    if (!win.isAbsolute(expandEnv(file))) reasons.push(`Path must be absolute: ${file}`);
    const verdict = checkWritePath(file, cfg, { checkName: false });
    if (!verdict.ok && !isInside(file, reportsRoot)) reasons.push(...verdict.reasons);
    return reasons.length ? { reasons } : { file };
  }
  const project = args.project_folder?.trim() ?? "";
  if (project) {
    const file = win.join(project, "01_WIP", "_Screening", DB_NAME);
    if (checkWritePath(file, cfg, { checkName: false }).ok) return { file };
    return { file: win.join(reportsRoot, "Screening", DB_NAME), note: `${win.dirname(file)} is not an allowed write folder: the reports folder is used` };
  }
  return { file: win.join(reportsRoot, "Screening", DB_NAME) };
}

/** Every write passes here: dry run is the default, Stop AI holds an AI's writes, and only our own files in allowed folders. */
export function writeGate(target: string, cfg: GuardConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const reasons: string[] = [];
  if (!/\.(json|md|html|csv|geojson)$/i.test(target)) reasons.push(`Only the screening database and reports are written, not ${win.basename(target)}`);
  const by = startedByFrom(env, "ai");
  if (by !== "pane" && by !== "person" && fs.existsSync(win.join(formcraftDir(env), "ai_stop"))) reasons.push("Stop AI is on: the person turns it off in the pane before an AI writes");
  const verdict = checkWritePath(target, cfg, { checkName: false });
  if (!verdict.ok && !isInside(target, expandEnv(cfg.reports_dir))) reasons.push(...verdict.reasons);
  return reasons;
}

function readDb(file: string, now: Date): { db?: ScreeningDb; error?: string; fresh?: boolean } {
  if (!fs.existsSync(file)) return { db: emptyDb(now), fresh: true };
  return parseDb(fs.readFileSync(file, "utf8"));
}

/** Atomic write (temp file, then rename), so a crash never leaves half a database. */
function writeAtomic(file: string, text: string) {
  fs.mkdirSync(win.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** One writer at a time: <db>.lock, taken with O_EXCL; a lock older than two minutes is a crashed writer's and is replaced. */
function withLock<T>(file: string, work: () => T): T {
  fs.mkdirSync(win.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let fd: number | null = null;
  for (let i = 0; i < 2 && fd === null; i++) {
    try { fd = fs.openSync(lock, "wx"); } catch {
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      if (age > 120_000) { try { fs.unlinkSync(lock); } catch { /* another writer took it */ } continue; }
      throw new Error(`The screening database is being written by another call (${lock}). Try again in a moment.`);
    }
  }
  if (fd === null) throw new Error(`Could not lock ${file}`);
  try { fs.writeSync(fd, String(process.pid)); return work(); }
  finally { fs.closeSync(fd); try { fs.unlinkSync(lock); } catch { /* already gone */ } }
}

async function readModel(args: FmcSeismicArgs, deps: SeismicDeps): Promise<ModelFacts> {
  if (deps.facts) return deps.facts(args.link);
  return await withRevitConnection((c) => c.sendCommand("fmc_struct_facts", { link: args.link }, 300000)) as ModelFacts;
}

const brief = (r: ScreeningRecord) => ({
  id: r.id, demo: r.demo, status: r.status, version: r.version, building: r.fields.building_name?.value, district: r.fields.district?.value,
  applies: r.seismic.applies, Cd: r.seismic.Cd, concerns: r.concerns.length, outcome: r.fields.outcome?.value, tbc: r.tbc.length, updated_at: r.updated_at,
});

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

export async function runFmcSeismicScreen(args: FmcSeismicArgs, deps: SeismicDeps = {}) {
  const config = deps.config ?? loadConfig().config;
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  const dry = args.dry_run !== false;
  const by = startedByFrom(env, "ai");
  try {
    const kit = loadKit(config, args.project_folder?.trim() ?? "", deps);
    const kitInfo = { file: kit.found ? kit.file : `missing: ${kit.file}`, version: kit.version, status: kit.status };
    if (args.action === "form") return reply({ ...formView(kit.kit), kit: kitInfo, sources: { model: "read from the Revit model", user: "entered by the person screening", derived: "worked out from the values shown", TBC: "to be confirmed" } });

    const where = databasePath(args, config);
    if (!where.file) return reply({ refused: true, reasons: where.reasons }, true);
    const dbFile = where.file;
    const loaded = readDb(dbFile, now);
    if (!loaded.db) return reply({ refused: true, reasons: [loaded.error], database: dbFile }, true);
    const db = loaded.db;
    const find = (id?: string) => (id ? db.records.find((r) => r.id === id.trim()) : undefined);

    if (args.action === "list") {
      const recs = db.records.filter((r) => args.include_archived || r.status !== "archived");
      return reply({ database: loaded.fresh ? `${dbFile} (not created yet)` : dbFile, revision: db.revision, count: recs.length, records: recs.map(brief) });
    }
    if (args.action === "get") {
      const r = find(args.id);
      return r ? reply({ database: dbFile, record: r }) : reply({ error: `No record ${args.id ?? "(no id)"} in ${dbFile}` }, true);
    }

    if (args.action === "prefill" || args.action === "save") {
      const input: ScreeningInput = { fields: args.fields, checklist: args.checklist };
      const problems = validateInput(input, kit.kit);
      if (problems.length) return reply({ refused: true, reasons: problems, next: "action form lists the fields, choices and checklist items" }, true);
      const previous = find(args.id);
      if (args.id && !previous && args.action === "save") return reply({ error: `No record ${args.id} to update; leave id out to add a new record` }, true);
      const useModel = args.from_model ?? !previous;
      let modelFields = fieldsFromModel(null, kit.kit, previous ? "kept from the earlier record" : "no model read (from_model false)");
      let model: ScreeningRecord["model"] = null;
      const warnings: string[] = [];
      if (useModel) {
        try {
          const facts = await readModel(args, deps);
          modelFields = fieldsFromModel(facts, kit.kit);
          model = { name: String(facts?.from ?? "model"), read_at: now.toISOString(), ...(args.link ? { link: args.link } : {}) };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (args.action === "save") return reply({ error: `The model could not be read (${msg}). Open the model, or save with from_model false to keep model fields TBC.` }, true);
          warnings.push(`The model could not be read (${msg}): model fields are TBC`);
          modelFields = fieldsFromModel(null, kit.kit, "model not reachable");
        }
      }
      if (previous && !useModel) for (const [k, f] of Object.entries(previous.fields)) if (f.source === "model") modelFields[k] = f;
      const id = previous?.id ?? nextId(db);
      const rec = buildRecord({ id, previous, modelFields, model, input, kit: kit.kit, now, by, status: args.status });
      const body = { id, record: rec, concerns: rec.concerns, tbc: rec.tbc, kit: kitInfo, ...(warnings.length ? { warnings } : {}), ...(where.note ? { note: where.note } : {}) };
      if (args.action === "prefill") return reply({ ...body, written: false, next: "Fill the TBC items with the person, then save (dry run first)" });

      const reasons = writeGate(dbFile, config, env);
      if (reasons.length) return reply({ refused: true, reasons, database: dbFile }, true);
      if (args.expected_revision !== undefined && args.expected_revision !== db.revision)
        return reply({ refused: true, reasons: [`The database is at revision ${db.revision}, not ${args.expected_revision}: read it again`] }, true);
      if (dry) return reply({ dry_run: true, database: dbFile, would: previous ? `update ${id} to version ${rec.version}` : `add ${id}`, changed: rec.history.at(-1)?.changed, ...body, next: "Run again with dry_run=false to save" });
      const saved = withLock(dbFile, () => {
        const fresh = readDb(dbFile, now);
        if (!fresh.db) throw new Error(fresh.error);
        if (fresh.db.revision !== db.revision) throw new Error(`The database changed while saving (revision ${fresh.db.revision}); run again`);
        const next = upsert(fresh.db, rec, now);
        writeAtomic(dbFile, JSON.stringify(next, null, 2));
        return next;
      });
      log(config, "seismic_save", false, dbFile, "done", `${id} v${rec.version}`);
      return reply({ saved: true, database: dbFile, revision: saved.revision, ...brief(rec), tbc_items: rec.tbc });
    }

    if (args.action === "seed_demo") {
      if (db.records.some((r) => r.demo)) return reply({ refused: true, reasons: ["The database already holds demo records"], database: dbFile }, true);
      let next = db;
      const added: ScreeningRecord[] = [];
      for (const d of DEMO_INPUTS) {
        const rec = buildRecord({ id: nextId(next, true), modelFields: demoModelFields(d.model), model: { name: String(d.model.model_name), read_at: now.toISOString() },
          input: d.input, kit: kit.kit, now, by, demo: true, status: "submitted" });
        added.push(rec);
        next = upsert(next, rec, now);
      }
      const reasons = writeGate(dbFile, config, env);
      if (reasons.length) return reply({ refused: true, reasons, database: dbFile }, true);
      if (dry) return reply({ dry_run: true, database: dbFile, would_add: added.map(brief), kit: kitInfo, next: "Run again with dry_run=false to add the demo buildings (all fictional)" });
      withLock(dbFile, () => {
        const fresh = readDb(dbFile, now);
        if (!fresh.db) throw new Error(fresh.error);
        if (fresh.db.records.some((r) => r.demo)) throw new Error("Demo records were added by another call");
        let out = fresh.db;
        for (const r of added) out = upsert(out, r, now);
        writeAtomic(dbFile, JSON.stringify(out, null, 2));
      });
      log(config, "seismic_seed_demo", false, dbFile, "done", `${added.length} demo records`);
      return reply({ saved: true, database: dbFile, added: added.map(brief) });
    }

    // report
    const folder = win.join(win.dirname(dbFile), "Reports");
    const files: Array<{ file: string; text: string }> = [];
    if (args.id) {
      const r = find(args.id);
      if (!r) return reply({ error: `No record ${args.id} in ${dbFile}` }, true);
      const blocks = buildingReport(r, kit.kit, now);
      const base = win.join(folder, `FMC_Seismic_Screening_${r.id}_${stamp(now)}`);
      files.push({ file: `${base}.md`, text: toMarkdown(blocks) }, { file: `${base}.html`, text: toHtml(`Seismic screening ${r.id}`, blocks) });
    } else {
      if (!db.records.length) return reply({ error: `The register is empty (${dbFile}): save a record or seed_demo first` }, true);
      const blocks = registerReport(db, now, args.include_archived);
      const base = win.join(folder, `FMC_Seismic_Register_${stamp(now)}`);
      files.push({ file: `${base}.md`, text: toMarkdown(blocks) }, { file: `${base}.html`, text: toHtml(db.title, blocks) },
        { file: `${base}.csv`, text: "\uFEFF" + csvLine(CSV_HEAD) + csvRows(db, args.include_archived).map((r) => csvLine(r)).join("") },
        { file: `${base}.geojson`, text: JSON.stringify(toGeoJson(db, args.include_archived), null, 1) });
    }
    const reasons = files.flatMap((f) => writeGate(f.file, config, env));
    if (reasons.length) return reply({ refused: true, reasons: [...new Set(reasons)] }, true);
    const clash = files.filter((f) => fs.existsSync(f.file)).map((f) => f.file);
    if (clash.length) return reply({ refused: true, reasons: [`Already there, nothing is overwritten: ${clash.join(", ")}`] }, true);
    if (dry) return reply({ dry_run: true, files: files.map((f) => f.file), preview: files[0].text.split("\n").slice(0, 30).join("\n"), next: "Run again with dry_run=false to write the report" });
    for (const f of files) writeAtomic(f.file, f.text);
    log(config, "seismic_report", false, folder, "done", files.map((f) => win.basename(f.file)).join(" "));
    return reply({ written: files.map((f) => f.file), checklist_items: CHECKLIST.length });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, `seismic_${args.action}`, dry, "", "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcSeismicScreenTool(server: McpServer) {
  server.tool("fmc_seismic_screen", FMC_SEISMIC_SCREEN_DESCRIPTION, FMC_SEISMIC_SCREEN_SHAPE, (args) => runFmcSeismicScreen(args as FmcSeismicArgs));
}
