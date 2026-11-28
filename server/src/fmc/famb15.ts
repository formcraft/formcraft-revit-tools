/**
 * B15 family editor tools: fmc_fam_dim, fmc_fam_visibility, fmc_fam_material, fmc_fam_category.
 *
 * Thin wrappers over fmc_doc, on the same pattern as the FE-01..05 tools (feat/family-editor-tools, famtools.ts): each
 * tool turns its items into fmc_doc ops (pure planners below), checks them with opsProblems as fmc_doc apply does, and
 * runs them in an fmc_doc session. A dry run by default (fmc_doc's dry run is the real run rolled back); with no session
 * or template only the planned ops come back; a save goes only into the family staging root, and replacing an .rfa needs
 * overwrite: true and first moves the file, its .000N backups and its .build.json to _Archive (archivePlan).
 * The runner is a copy of famtools.ts's famRun/famSave because that file is not on this branch's base (cf71214); when
 * both branches are merged the two can become one.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { GuardConfig, archivePlan, checkTemplatePath, expandEnv, isInside } from "./policy.js";
import { saveProblems } from "./doc.js";
import { OP, Op, opsProblems, splitProblems } from "./ops.js";
import { SpParam } from "./specs.js";
import { MaterialDb } from "./materials.js";
import { B15, DETAIL_LEVELS } from "./ops_b15.js";

const win = path.win32;

// ---------- common arguments ----------

export const FAM_B15_COMMON = {
  session: z.string().optional().default("").describe("an fmc_doc session id (fmc_doc open). Without one, a dry run returns the planned ops only"),
  template: z.string().optional().default("").describe("open a new family from this .rft (template roots) when no session is given"),
  dry_run: z.boolean().optional().default(true).describe("a dry run unless false: the real run rolled back in Revit"),
  save_path: z.string().optional().default("").describe("after a real apply: save the family here (.rfa inside the family staging root)"),
  overwrite: z.boolean().optional().default(false)
    .describe("save over an existing .rfa (a person decided): the old file, its backups and its .build.json are archived to _Archive first"),
};
export interface FamB15Common { session: string; template: string; dry_run: boolean; save_path: string; overwrite: boolean }

/** Items: fmc_doc ops (with `op`), checked against each tool's own list. */
export const itemsShape = (ops: readonly string[]) =>
  z.array(z.object({ op: z.string().min(1) }).passthrough()).min(1).max(300).describe(`the ops, in order: ${ops.join(", ")}`);

/** What a tool needs from the outside world; tests pass fakes. doc() is fmc_doc (runFmcDoc's JSON body). */
export interface FamB15Io {
  config: GuardConfig;
  dictionary: Map<string, SpParam> | null;
  /** the kit's material library: null when unreadable, undefined when not loaded (no add_material in the batch) */
  materials?: MaterialDb | null;
  doc: (args: Record<string, unknown>) => Promise<{ body: any; isError: boolean }>;
  exists: (p: string) => boolean;
  readdir: (dir: string) => string[];
  rename: (from: string, to: string) => void;
  mkdir: (dir: string) => void;
  now?: () => Date;
}

export interface FamB15Result { refused?: boolean; reasons?: string[]; [k: string]: unknown }
export interface Planned { ops: Array<Record<string, unknown>>; problems: string[]; notes: string[]; extra?: Record<string, unknown> }

/** Checks a batch as fmc_doc apply would (schema, then opsProblems with the kit dictionary and material library). */
export function checkB15Ops(ops: unknown[], io: Pick<FamB15Io, "config" | "dictionary" | "materials">): { ops: Op[]; errors: string[]; notes: string[] } {
  const parsed = z.array(OP).safeParse(ops);
  if (!parsed.success) return { ops: [], errors: parsed.error.issues.map((i) => `ops[${i.path.join(".")}]: ${i.message}`), notes: [] };
  const familiesRoot = io.config.family_staging_root ? win.dirname(expandEnv(io.config.family_staging_root)) : undefined;
  const { errors, notes } = splitProblems(opsProblems(parsed.data, io.dictionary, familiesRoot, io.materials,
    { libraryRoots: (io.config.library_roots ?? []).map((r) => expandEnv(r)) }));
  return { ops: parsed.data, errors, notes };
}

/** Where a save may go: fmc_doc's save rules, and inside the family staging root (scratch/staging only). */
export function famB15SaveProblems(target: string, cfg: GuardConfig): string[] {
  const p = saveProblems(target, cfg);
  const staging = expandEnv(cfg.family_staging_root ?? "");
  if (!staging) p.push("No family_staging_root is configured: the family tools save only into staging");
  else if (!isInside(target, staging)) p.push(`${target} isn't inside the family staging root (${staging}): the family tools save only into staging`);
  return p;
}

/** The archive-before-replace moves: archivePlan's (file and .000N backups) plus the .build.json beside it. */
export function replacePlanB15(target: string, siblings: string[], now: Date): Array<[string, string]> {
  const moves = archivePlan(target, siblings, now).moves;
  const build = win.basename(target).replace(/\.rfa$/i, ".build.json");
  const hit = siblings.find((s) => s.toLowerCase() === build.toLowerCase());
  if (hit && moves.length) moves.push([win.join(win.dirname(moves[0][0]), hit), win.join(win.dirname(moves[0][1]), win.basename(moves[0][1]).replace(win.basename(target), hit))]);
  return moves;
}

/** Runs a planned batch: refuse bad ops; no session: the plan alone; open the template; apply (dry by default); save. */
export async function famB15Run(tool: string, planned: Planned, a: FamB15Common, io: FamB15Io): Promise<FamB15Result> {
  if (planned.problems.length) return { refused: true, reasons: planned.problems, tool, notes: planned.notes };
  const checked = checkB15Ops(planned.ops, io);
  const notes = [...planned.notes, ...checked.notes];
  if (checked.errors.length) return { refused: true, reasons: checked.errors, tool, planned_ops: planned.ops, notes };
  const dry = a.dry_run !== false;
  const session0 = (a.session ?? "").trim(), template = (a.template ?? "").trim(), savePath = (a.save_path ?? "").trim();
  if (savePath) {
    const sp = famB15SaveProblems(savePath, io.config);
    if (sp.length) return { refused: true, reasons: sp, tool, planned_ops: checked.ops };
    if (io.exists(savePath) && !a.overwrite)
      return { refused: true, reasons: [`${savePath} exists: a person decides to replace it (overwrite: true; it is archived to _Archive first)`], tool };
  }
  if (!session0 && !template) {
    if (!dry) return { refused: true, reasons: [`${tool} with dry_run false needs a session (fmc_doc open) or a template`], tool };
    return { tool, dry_run: true, planned_ops: checked.ops, notes, ...planned.extra,
      next: "Pass a session (fmc_doc open) or a template to try it in Revit (still a dry run), then dry_run: false" };
  }
  let session = session0;
  if (!session) {
    const tp = checkTemplatePath(expandEnv(template), io.config).reasons;
    if (win.extname(template).toLowerCase() !== ".rft") tp.push("A family is opened from a family template (.rft)");
    if (tp.length) return { refused: true, reasons: tp, tool };
    const o = await io.doc({ action: "open", template });
    if (o.isError || !o.body?.session) return { refused: true, reasons: [`fmc_doc open failed: ${JSON.stringify(o.body)}`], tool };
    session = String(o.body.session);
  }
  const r = await io.doc({ action: "apply", session, ops: checked.ops, dry_run: dry });
  if (r.isError) return { refused: true, reasons: r.body?.reasons ?? [r.body?.error ?? "fmc_doc apply failed"], tool, session };
  const out: FamB15Result = { tool, session, dry_run: dry, applied: r.body, notes, ...planned.extra };
  if (dry || !savePath) {
    out.next = dry ? "Run again with dry_run: false to apply" : "fmc_doc save (or pass save_path) writes it to staging";
    return out;
  }
  out.saved = await famB15Save(session, savePath, a.overwrite, io);
  return out;
}

/** Save into staging; an existing file is archived first (archive-before-replace), then saved as new. */
export async function famB15Save(session: string, target: string, overwrite: boolean, io: FamB15Io): Promise<Record<string, unknown>> {
  const sp = famB15SaveProblems(target, io.config);
  if (sp.length) return { refused: true, reasons: sp };
  let archived: Array<[string, string]> = [];
  if (io.exists(target)) {
    if (!overwrite) return { refused: true, reasons: [`${target} exists: a person decides to replace it (overwrite: true)`] };
    archived = replacePlanB15(target, io.readdir(win.dirname(target)), (io.now ?? (() => new Date()))());
    if (!archived.length) return { refused: true, reasons: [`${target}: no archive plan; nothing saved`] };
    io.mkdir(win.dirname(archived[0][1]));
    for (const [from, to] of archived) io.rename(from, to);
    if (io.exists(target)) return { refused: true, reasons: [`${target} is still there after archiving; nothing saved`], archived };
  }
  const s = await io.doc({ action: "save", session, path: target, overwrite: false });
  if (s.isError) return { refused: true, reasons: s.body?.reasons ?? [s.body?.error ?? "fmc_doc save failed"], archived };
  return { ...s.body, archived };
}

/** Keeps only a tool's own ops; names what isn't one. */
function only(tool: string, items: Array<Record<string, unknown>>, allowed: readonly string[]): string[] {
  return items.map((it, i) => (allowed.includes(String(it.op)) ? "" : `items[${i}]: ${tool} doesn't take op "${it.op}" (it takes ${allowed.join(", ")})`)).filter(Boolean);
}

// ---------- fmc_fam_dim ----------

/** dim_add_diameter is a planner shorthand: dim_add_radial with diameter: true. */
export const DIM_ADD_DIAMETER = "dim_add_diameter";
export const DIM_OPS = ["add_dimension", "add_eq_dimension", B15.DIM_ADD_ANGULAR, B15.DIM_ADD_RADIAL, DIM_ADD_DIAMETER, B15.DIM_UNLOCK] as const;

export function dimOps(items: Array<Record<string, unknown>>): Planned {
  const problems = only("fmc_fam_dim", items, DIM_OPS);
  const notes: string[] = [];
  const ops = items.map((it) => {
    if (it.op === DIM_ADD_DIAMETER) return { ...it, op: B15.DIM_ADD_RADIAL, diameter: true };
    if (it.op === B15.DIM_UNLOCK) notes.push(`${it.name}: unlocking lets its planes move; the apply's detail lists what then floats`);
    return { ...it };
  });
  return { ops, problems, notes };
}

// ---------- fmc_fam_visibility ----------

export const VIS_OPS = ["set_visibility", "set_visible_param", B15.VIS_SET, B15.VIS_MATRIX] as const;
/** Detail-level tiers (the generator's visibility_tier names): the levels an element shows in. */
export const TIERS: Record<string, Array<(typeof DETAIL_LEVELS)[number]>> = {
  all: ["coarse", "medium", "fine"],
  coarse: ["coarse"],
  coarse_medium: ["coarse", "medium"],
  medium_fine: ["medium", "fine"],
  fine: ["fine"],
};

/**
 * vis_set may take a tier instead of detail_levels. A vis_matrix op is added at the end unless the batch has one
 * (matrix: false leaves it out), so the dry run shows every element's visibility and the detail levels nothing shows
 * in, with the fix to propose. The planner also proposes fixes from the batch itself.
 */
export function visibilityOps(items: Array<Record<string, unknown>>, matrix = true): Planned {
  const problems = only("fmc_fam_visibility", items, VIS_OPS);
  const notes: string[] = [];
  const ops = items.map((it, i) => {
    if (it.op === B15.VIS_SET && it.tier !== undefined) {
      const t = TIERS[String(it.tier)];
      if (!t) { problems.push(`items[${i}]: tier "${it.tier}" isn't one of ${Object.keys(TIERS).join(", ")}`); return it; }
      if (it.detail_levels !== undefined) problems.push(`items[${i}]: give tier or detail_levels, not both`);
      const { tier, ...rest } = it;
      return { ...rest, detail_levels: [...t] };
    }
    return { ...it };
  });
  // proposals from the batch: a level every element it sets leaves off
  const levelSets = ops.map((o) => o.op === B15.VIS_SET ? (o.detail_levels as string[] | undefined)
    : o.op === "set_visibility" ? DETAIL_LEVELS.filter((l) => o[l] !== false) : undefined).filter((x): x is string[] => !!x);
  if (levelSets.length)
    for (const lvl of DETAIL_LEVELS)
      if (levelSets.every((l) => !l.includes(lvl)))
        notes.push(`warning: every element in this batch is off at ${lvl}: unless another element shows there, the family is empty at ${lvl} (turn ${lvl} on for the main body)`);
  if (matrix && !ops.some((o) => o.op === B15.VIS_MATRIX)) ops.push({ op: B15.VIS_MATRIX, name: "Visibility check" });
  return { ops, problems, notes };
}

// ---------- fmc_fam_material ----------

/** material_param is a planner shorthand: a Material family parameter (made if new) and a solid's Material tied to it. */
export const MATERIAL_PARAM = "material_param";
export const MAT_OPS = ["add_material", "set_material_param", MATERIAL_PARAM, B15.MATERIAL_SET, B15.MATERIAL_PAINT, B15.MATERIAL_PURGE] as const;

/** material_param {name: parameter, solid, instance?}. Materials come only from the kit (add_material checks FMC_Materials.json). */
export function materialOps(items: Array<Record<string, unknown>>): Planned {
  const problems = only("fmc_fam_material", items, MAT_OPS);
  const notes: string[] = [];
  const ops: Array<Record<string, unknown>> = [];
  items.forEach((it, i) => {
    if (it.op === MATERIAL_PARAM) {
      if (!it.name || !it.solid) { problems.push(`items[${i}]: material_param needs name (the parameter) and solid`); return; }
      ops.push({ op: "add_family_param", name: it.name, type: "Material", instance: it.instance === true, group: "Materials" });
      ops.push({ op: "set_material_param", name: it.solid, param: it.name });
      return;
    }
    if (it.op === B15.MATERIAL_PURGE && it.delete === true) notes.push(`${it.name}: delete is true: unused materials are removed from the family (the dry run lists them first)`);
    ops.push({ ...it });
  });
  return { ops, problems, notes };
}

/**
 * Texture check for the kit materials a batch brings in: every texture map must be inside the kit's materials folder
 * (07_Materials) and on disk. Outside the kit refuses; missing on disk is a warning (the material is made without it).
 */
export function textureProblems(ops: Array<Record<string, unknown>>, db: MaterialDb | null | undefined, materialsFile: string, exists: (p: string) => boolean): { errors: string[]; notes: string[] } {
  const errors: string[] = [], notes: string[] = [];
  const wanted = ops.filter((o) => o.op === "add_material").map((o) => String(o.name));
  if (!wanted.length) return { errors, notes };
  if (!db) { errors.push("the kit's material library (07_Materials\\FMC_Materials.json) isn't readable"); return { errors, notes }; }
  const kitDir = win.dirname(materialsFile);
  for (const name of wanted) {
    const m = db.materials.find((x) => x.name === name);
    if (!m) continue; // opsProblems names it
    for (const t of m.maps ?? []) {
      if (!t.file) continue;
      const full = win.isAbsolute(t.file) ? t.file : win.join(kitDir, t.file);
      if (!isInside(full, kitDir)) errors.push(`${name}: texture ${t.file} is outside the kit's materials folder (${kitDir}): kit materials use kit textures only`);
      else if (!exists(full)) notes.push(`warning: ${name}: texture ${full} isn't on disk, so the material is made without its ${t.map} map`);
    }
  }
  return { errors, notes };
}

// ---------- fmc_fam_category ----------

export const CAT_OPS = ["set_family_params", "add_subcategory", "set_subcategory", B15.CATEGORY_SET, B15.CATEGORY_FLAGS, B15.SUBCATEGORY_RENAME, B15.SUBCATEGORY_DELETE] as const;

/** category (a top-level argument) becomes a category_set op first; delete notes say what happens to the users. */
export function categoryOps(items: Array<Record<string, unknown>>, category = ""): Planned {
  const problems = only("fmc_fam_category", items, CAT_OPS);
  const notes: string[] = [];
  const ops: Array<Record<string, unknown>> = [];
  if (category.trim()) {
    if (items.some((it) => it.op === B15.CATEGORY_SET && it.category)) problems.push("give the category once: as category or in a category_set item");
    ops.push({ op: B15.CATEGORY_SET, name: "Category", category: category.trim() });
  }
  for (const it of items) {
    if (it.op === B15.SUBCATEGORY_DELETE)
      notes.push(it.reassign_to ? `${it.name}: its solids and lines move to ${it.reassign_to} first` : `${it.name}: refused in Revit if any solid or line uses it (the error lists them); pass reassign_to to move them`);
    ops.push({ ...it });
  }
  return { ops, problems, notes };
}

// ---------- real io ----------

export async function realB15Io(loadMaterials = false): Promise<FamB15Io> {
  const { loadConfig } = await import("./policy.js");
  const { parseSharedParameters } = await import("./specs.js");
  const { runFmcDoc } = await import("../tools/fmc_doc.js");
  const { config } = loadConfig();
  let dictionary: Map<string, SpParam> | null = null;
  try { dictionary = parseSharedParameters(fs.readFileSync(expandEnv(config.shared_parameter_file), "utf8")); } catch { dictionary = null; }
  let materials: MaterialDb | null | undefined;
  if (loadMaterials) {
    const { readDb } = await import("../tools/fmc_material.js");
    try { materials = readDb(config); } catch { materials = null; }
  }
  return {
    config, dictionary, materials,
    exists: (p) => fs.existsSync(p),
    readdir: (d) => { try { return fs.readdirSync(d); } catch { return []; } },
    rename: (a, b) => fs.renameSync(a, b),
    mkdir: (d) => { fs.mkdirSync(d, { recursive: true }); },
    doc: async (args) => {
      const r = await runFmcDoc(args as any);
      let body: any = null;
      try { body = JSON.parse(r.content[0].text); } catch { body = { error: r.content?.[0]?.text }; }
      return { body, isError: !!r.isError };
    },
  };
}

export function famB15Reply(body: object) {
  const isError = !!(body as FamB15Result).refused;
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}
