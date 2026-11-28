/**
 * Family editor tools (FE-01 to FE-05): fmc_fam_template, fmc_fam_form, fmc_fam_2d, fmc_fam_light, fmc_fam_annotation.
 *
 * Each tool is a thin wrapper over fmc_doc: it turns its own arguments into fmc_doc ops (pure planners below), checks
 * them with opsProblems like fmc_doc apply does, and runs them in an fmc_doc session. Writes only ever go into a family
 * document: a dry run by default (fmc_doc's dry run is the real run rolled back), a save only into the family staging
 * root (and the write roots fmc_doc save checks), and a save over an existing .rfa only with overwrite: true and only
 * after the file, its .000N backups and its .build.json are moved to _Archive (archivePlan, the same move as
 * fmc_file archive). Nothing here changes the F134 family approval gate: loading or binding still goes through it.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { GuardConfig, archivePlan, checkTemplatePath, expandEnv, isInside } from "./policy.js";
import { saveProblems } from "./doc.js";
import { OP, Op, opsProblems, splitProblems } from "./ops.js";
import { SpParam } from "./specs.js";

const win = path.win32;

// ---------- common arguments ----------

export const FAM_COMMON = {
  session: z.string().optional().default("").describe("an fmc_doc session id (fmc_doc open). Without one, a dry run returns the planned ops only"),
  template: z.string().optional().default("").describe("open a new family from this .rft (template roots) when no session is given"),
  dry_run: z.boolean().optional().default(true).describe("a dry run unless false: the real run rolled back in Revit"),
  save_path: z.string().optional().default("").describe("after a real apply: save the family here (.rfa inside the family staging root)"),
  overwrite: z.boolean().optional().default(false)
    .describe("save over an existing .rfa (a person decided): the old file, its backups and its .build.json are archived to _Archive first"),
};
export interface FamCommon { session: string; template: string; dry_run: boolean; save_path: string; overwrite: boolean }

/** What a tool needs from the outside world; tests pass fakes. doc() is fmc_doc (runFmcDoc's JSON body). */
export interface FamIo {
  config: GuardConfig;
  dictionary: Map<string, SpParam> | null;
  doc: (args: Record<string, unknown>) => Promise<{ body: any; isError: boolean }>;
  exists: (p: string) => boolean;
  readdir: (dir: string) => string[];
  rename: (from: string, to: string) => void;
  mkdir: (dir: string) => void;
  now?: () => Date;
}

export const realFs = {
  exists: (p: string) => fs.existsSync(p),
  readdir: (d: string) => { try { return fs.readdirSync(d); } catch { return []; } },
  rename: (a: string, b: string) => fs.renameSync(a, b),
  mkdir: (d: string) => { fs.mkdirSync(d, { recursive: true }); },
};

export interface FamResult { refused?: boolean; reasons?: string[]; [k: string]: unknown }

/** Checks a batch as fmc_doc apply would (schema, then opsProblems with the kit dictionary). */
export function checkOps(ops: unknown[], io: Pick<FamIo, "config" | "dictionary">): { ops: Op[]; errors: string[]; notes: string[] } {
  const parsed = z.array(OP).safeParse(ops);
  if (!parsed.success) return { ops: [], errors: parsed.error.issues.map((i) => `ops[${i.path.join(".")}]: ${i.message}`), notes: [] };
  const familiesRoot = io.config.family_staging_root ? win.dirname(expandEnv(io.config.family_staging_root)) : undefined;
  const { errors, notes } = splitProblems(opsProblems(parsed.data, io.dictionary, familiesRoot, undefined,
    { libraryRoots: (io.config.library_roots ?? []).map((r) => expandEnv(r)) }));
  return { ops: parsed.data, errors, notes };
}

/** Where a save may go: fmc_doc's save rules, and inside the family staging root (scratch/staging only). */
export function famSaveProblems(target: string, cfg: GuardConfig): string[] {
  const p = saveProblems(target, cfg);
  const staging = expandEnv(cfg.family_staging_root ?? "");
  if (!staging) p.push("No family_staging_root is configured: the family tools save only into staging");
  else if (!isInside(target, staging)) p.push(`${target} isn't inside the family staging root (${staging}): the family tools save only into staging`);
  return p;
}

/** The archive-before-replace moves: archivePlan's (file and .000N backups) plus the .build.json beside it. */
export function replacePlan(target: string, siblings: string[], now: Date): Array<[string, string]> {
  const moves = archivePlan(target, siblings, now).moves;
  const build = win.basename(target).replace(/\.rfa$/i, ".build.json");
  const hit = siblings.find((s) => s.toLowerCase() === build.toLowerCase());
  if (hit) moves.push([win.join(win.dirname(moves[0][0]), hit), win.join(win.dirname(moves[0][1]), win.basename(moves[0][1]).replace(win.basename(target), hit))]);
  return moves;
}

/**
 * Runs a planned batch: refuses bad ops, returns the plan alone when there is no session (dry run), opens the template
 * when one is given, applies (dry run by default), then on a real run saves with archive-before-replace.
 */
export async function famRun(tool: string, planned: { ops: unknown[]; notes?: string[]; extra?: Record<string, unknown> }, a: FamCommon, io: FamIo): Promise<FamResult> {
  const checked = checkOps(planned.ops, io);
  const notes = [...(planned.notes ?? []), ...checked.notes];
  if (checked.errors.length) return { refused: true, reasons: checked.errors, tool, planned_ops: planned.ops, notes };
  const dry = a.dry_run !== false;
  const session0 = (a.session ?? "").trim(), template = (a.template ?? "").trim();
  if (a.save_path?.trim()) {
    const sp = famSaveProblems(a.save_path.trim(), io.config);
    if (sp.length) return { refused: true, reasons: sp, tool, planned_ops: checked.ops };
    if (io.exists(a.save_path.trim()) && !a.overwrite)
      return { refused: true, reasons: [`${a.save_path.trim()} exists: a person decides to replace it (overwrite: true; it is archived to _Archive first)`], tool };
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
  const out: FamResult = { tool, session, dry_run: dry, applied: r.body, notes, ...planned.extra };
  if (dry || !a.save_path?.trim()) {
    out.next = dry ? "Run again with dry_run: false to apply" : "fmc_doc save (or pass save_path) writes it to staging";
    return out;
  }
  out.saved = await famSave(session, a.save_path.trim(), a.overwrite, io);
  return out;
}

/** Save into staging; an existing file is archived first (archive-before-replace), then saved as new. */
export async function famSave(session: string, target: string, overwrite: boolean, io: FamIo): Promise<Record<string, unknown>> {
  const sp = famSaveProblems(target, io.config);
  if (sp.length) return { refused: true, reasons: sp };
  let archived: Array<[string, string]> = [];
  if (io.exists(target)) {
    if (!overwrite) return { refused: true, reasons: [`${target} exists: a person decides to replace it (overwrite: true)`] };
    archived = replacePlan(target, io.readdir(win.dirname(target)), (io.now ?? (() => new Date()))());
    io.mkdir(win.dirname(archived[0][1]));
    for (const [from, to] of archived) io.rename(from, to);
    if (io.exists(target)) return { refused: true, reasons: [`${target} is still there after archiving; nothing saved`], archived };
  }
  const s = await io.doc({ action: "save", session, path: target, overwrite: false });
  if (s.isError) return { refused: true, reasons: s.body?.reasons ?? [s.body?.error ?? "fmc_doc save failed"], archived };
  return { ...s.body, archived };
}

// ---------- FE-01 fmc_fam_template ----------

/** .rft files under the template roots and the family template folder (read-only), up to depth folders down. */
export function listTemplates(cfg: GuardConfig, io: Pick<FamIo, "readdir" | "exists">, depth = 3): Array<{ path: string; root: string; formcraft: boolean }> {
  const roots = [...new Set([...(cfg.template_roots ?? []), cfg.family_template_dir].filter(Boolean).map((r) => expandEnv(r!)))];
  const out: Array<{ path: string; root: string; formcraft: boolean }> = [];
  const walk = (dir: string, root: string, d: number) => {
    for (const n of io.readdir(dir)) {
      const p = win.join(dir, n);
      if (win.extname(n).toLowerCase() === ".rft") out.push({ path: p, root, formcraft: isFormcraftTemplate(n) });
      else if (d > 0 && !win.extname(n) && !n.startsWith("_")) walk(p, root, d - 1);
    }
  };
  for (const r of roots) walk(r, r, depth);
  const seen = new Set<string>();
  return out.filter((t) => !seen.has(t.path.toLowerCase()) && !!seen.add(t.path.toLowerCase())).sort((x, y) => x.path.localeCompare(y.path));
}

/** The kit's own templates are named FMC_* (assumed: the .rft naming rule isn't written down; reported as a spec gap). */
export const isFormcraftTemplate = (name: string) => /^FMC[_-]/i.test(win.basename(name));

export function auditTemplate(template: string, cfg: GuardConfig, io: Pick<FamIo, "exists">): { template: string; ok: boolean; problems: string[]; notes: string[] } {
  const t = expandEnv(template.trim());
  const problems = [...checkTemplatePath(t, cfg).reasons];
  if (win.extname(t).toLowerCase() !== ".rft") problems.push("Not a family template (.rft); project templates (.rte) stay with fmc_template");
  if (!io.exists(t)) problems.push(`Not found: ${t}`);
  const notes = isFormcraftTemplate(t) ? [] : ["Not named FMC_*: an Autodesk or third-party template, not one of the kit's"];
  return { template: t, ok: problems.length === 0, problems, notes };
}

export const SIZE = z.object({ param: z.string().min(1), mm: z.number().positive() });
export interface TemplateCreate { category?: string; width?: { param: string; mm: number }; depth?: { param: string; mm: number }; height?: { param: string; mm: number };
  mounting?: { param: string; mm: number }; shared_params?: string[]; instance_params?: string[] }

/** The standard planes and parameters a new family gets: category, skeleton (Width/Depth/Height planes), kit parameters. */
export function templateCreateOps(c: TemplateCreate, dictionary: Map<string, SpParam> | null): { ops: Array<Record<string, unknown>>; notes: string[]; missing: string[] } {
  const ops: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  const missing: string[] = [];
  if (c.category) ops.push({ op: "set_category", name: c.category });
  if (c.width || c.depth || c.height) {
    if (!(c.width && c.depth && c.height)) notes.push("Standard planes need width, depth and height together; none were added");
    else ops.push({ op: "skeleton", name: "Skeleton", width: c.width, depth: c.depth, height: c.height, ...(c.mounting ? { mounting: c.mounting } : {}) });
  }
  const inst = new Set((c.instance_params ?? []).map((n) => n.toLowerCase()));
  for (const n of c.shared_params ?? []) {
    const sp = dictionary?.get(n);
    if (!sp) { missing.push(n); continue; }
    ops.push({ op: "add_shared_param", name: sp.name, guid: sp.guid, instance: inst.has(n.toLowerCase()) });
  }
  if (missing.length) notes.push(`Not in the kit's shared parameter dictionary, so not added: ${missing.join(", ")}`);
  return { ops, notes, missing };
}

// ---------- FE-02 fmc_fam_form ----------

export const FORM_OPS = ["extrusion", "void_extrusion", "sweep", "void_sweep", "revolution", "blend", "array", "swept_blend", "void_swept_blend"] as const;
export const LOFT = z.object({ op: z.literal("loft"), name: z.string().min(1),
  sections: z.array(z.object({ z: z.number().finite().describe("height of this section, mm"), outline: z.array(z.any()).min(2).describe("closed outline in plan, mm") })).min(2)
    .describe("two or more horizontal sections, bottom to top"),
  subcategory: z.string().optional() });
export type Loft = z.infer<typeof LOFT>;

/** A loft is drawn as one blend per pair of sections, named "<name> 1", "<name> 2", ... (Revit has no loft in a family). */
export function loftOps(l: Loft): { ops: Array<Record<string, unknown>>; problems: string[] } {
  const problems: string[] = [];
  const s = l.sections;
  for (let i = 1; i < s.length; i++) if (!(s[i].z > s[i - 1].z)) problems.push(`loft ${l.name}: section ${i + 1} (z ${s[i].z}) isn't above section ${i} (z ${s[i - 1].z})`);
  const ops = s.slice(1).map((top, i) => ({ op: "blend", name: s.length === 2 ? l.name : `${l.name} ${i + 1}`, base: s[i].outline, top: top.outline,
    start: s[i].z, end: top.z, ...(l.subcategory ? { subcategory: l.subcategory } : {}) }));
  return { ops, problems };
}

export function formOps(forms: Array<Record<string, unknown>>): { ops: Array<Record<string, unknown>>; problems: string[]; notes: string[] } {
  const ops: Array<Record<string, unknown>> = [], problems: string[] = [], notes: string[] = [];
  forms.forEach((f, i) => {
    if (f.op === "loft") {
      const p = LOFT.safeParse(f);
      if (!p.success) { problems.push(`forms[${i}] loft: ${p.error.issues.map((x) => x.path.join(".") + " " + x.message).join("; ")}`); return; }
      const l = loftOps(p.data);
      problems.push(...l.problems);
      ops.push(...l.ops);
      notes.push(`loft ${p.data.name}: ${l.ops.length} blend(s) between ${p.data.sections.length} sections`);
    } else if ((FORM_OPS as readonly string[]).includes(String(f.op))) ops.push(f);
    else problems.push(`forms[${i}]: ${String(f.op)} isn't a form op (${[...FORM_OPS, "loft"].join(", ")}); other ops go through fmc_doc apply`);
  });
  return { ops, problems, notes };
}

// ---------- FE-03 fmc_fam_2d ----------

// builder16: model_lines, model_text and add_subcategory (FAM-044 checked by opsProblems) added; view-only ops refuse
// visibility flags instead of dropping them.
export const TWO_D_OPS = ["masking_region", "filled_region", "detail_lines", "symbolic_lines", "model_lines", "model_text", "add_subcategory"] as const;
/** Ops drawn in one view only: Revit's API has no detail-level or view visibility for them (FamilyElementVisibility is for model and symbolic elements). */
export const VIEW_ONLY_2D = ["masking_region", "filled_region", "detail_lines"] as const;
const VIS_FLAGS = ["coarse", "medium", "fine", "plan_rcp", "front_back", "left_right"] as const;
export function twoDOps(items: Array<Record<string, unknown>>): { ops: Array<Record<string, unknown>>; problems: string[] } {
  const problems: string[] = [];
  items.forEach((f, i) => {
    const op = String(f.op);
    if (!(TWO_D_OPS as readonly string[]).includes(op)) { problems.push(`items[${i}]: ${op} isn't a 2D op (${TWO_D_OPS.join(", ")})`); return; }
    const flags = VIS_FLAGS.filter((k) => f[k] !== undefined);
    if ((VIEW_ONLY_2D as readonly string[]).includes(op) && flags.length)
      problems.push(`items[${i}]: ${op} shows only in its own view; Revit's API can't set ${flags.join(", ")} on it (use symbolic_lines or model_lines for detail-level visibility)`);
    if (op === "symbolic_lines" && flags.some((k) => !["coarse", "medium", "fine"].includes(k)))
      problems.push(`items[${i}]: symbolic_lines take coarse, medium and fine; the view they show in is their view (plan, front or right)`);
  });
  return { ops: problems.length ? [] : items, problems };
}

// ---------- FE-04 fmc_fam_light ----------

export const SPOT_DEFAULT = { beam_deg: 60, field_deg: 90 } as const;
export interface LightArgs { name?: string; shape?: string; distribution?: string; lumens?: number; lumens_by_type?: Record<string, number>; kelvin?: number;
  beam_deg?: number; field_deg?: number; source_z_mm?: number; ensure_category?: boolean }
export function lightOps(a: LightArgs): Array<Record<string, unknown>> {
  const ops: Array<Record<string, unknown>> = [];
  if (a.ensure_category !== false) ops.push({ op: "set_category", name: "Lighting Fixtures" });
  const l: Record<string, unknown> = { op: "light_source", name: a.name || "Light source" };
  for (const k of ["shape", "distribution", "lumens", "lumens_by_type", "kelvin", "beam_deg", "field_deg", "source_z_mm"] as const)
    if (a[k] !== undefined) l[k] = a[k];
  // builder16: a spot gets the angles the C# op would use (60° beam, 90° field) written into the plan, so the plan shows
  // what Revit will get and opsProblems checks field >= beam on the real values.
  if (a.distribution === "spot") { l.beam_deg ??= SPOT_DEFAULT.beam_deg; l.field_deg ??= SPOT_DEFAULT.field_deg; }
  ops.push(l);
  return ops;
}

// ---------- FE-05 fmc_fam_annotation ----------

export const ANNOTATION_KINDS = ["tag", "annotation", "title_block", "detail_component", "keynote_tag"] as const;
export type AnnotationKind = typeof ANNOTATION_KINDS[number];
export const KIND_CATEGORY: Record<Exclude<AnnotationKind, "tag">, string> = {
  annotation: "Generic Annotations", title_block: "Title Blocks", detail_component: "Detail Items", keynote_tag: "Keynote Tags",
};
// builder16: keynote tags read Revit's own keynote parameters (Key Value, Keynote Text; Keynote Number for user
// keynotes), never kit shared parameters; the keynote table itself is the kit's and is loaded in the project.
export const KEYNOTE_LABELS = ["Key Value", "Keynote Text", "Keynote Number"] as const;
export const REPEAT_LAYOUTS = ["fixed_distance", "fixed_number", "maximum_spacing", "fill_available"] as const;
/** A repeating detail type in a project uses a detail component; its spacing lives in that project type, not in the family. */
export interface RepeatingDetail { layout: typeof REPEAT_LAYOUTS[number]; spacing_mm?: number; number?: number; inside?: boolean; rotation?: "none" | "across" }
export interface RepeatPlan { project_type: string; detail: string; layout: string; spacing_mm?: number; number?: number; inside: boolean;
  rotation: string; parameters: Record<string, string | number | boolean>; step: string }

/** builder16: the repeating detail spacing plan for a detail component (a person, or a project tool, makes the type). */
export function repeatPlan(r: RepeatingDetail, family: string): { plan: RepeatPlan | null; problems: string[] } {
  const problems: string[] = [];
  if ((r.layout === "fixed_distance" || r.layout === "maximum_spacing") && !(r.spacing_mm && r.spacing_mm > 0))
    problems.push(`repeating_detail: layout ${r.layout} needs spacing_mm above 0`);
  if (r.layout === "fixed_number" && !(r.number && r.number >= 2)) problems.push("repeating_detail: layout fixed_number needs number, 2 or more");
  if (r.layout === "fill_available" && r.spacing_mm !== undefined) problems.push("repeating_detail: fill_available spaces by the component's width; leave spacing_mm out");
  if (problems.length) return { plan: null, problems };
  const name = family || "<this family>";
  const params: Record<string, string | number | boolean> = { "Detail (REPEATING_DETAIL_ELEMENT)": name,
    "Layout (REPEATING_DETAIL_LAYOUT)": r.layout.replace(/_/g, " "), "Inside (REPEATING_DETAIL_INSIDE)": r.inside ?? true,
    "Detail Rotation (REPEATING_DETAIL_ROTATION)": r.rotation ?? "none" };
  if (r.spacing_mm !== undefined) params["Spacing (REPEATING_DETAIL_SPACING), mm"] = r.spacing_mm;
  if (r.number !== undefined) params["Number (REPEATING_DETAIL_NUMBER)"] = r.number;
  return { problems, plan: { project_type: `${name} Repeating`, detail: name, layout: r.layout, ...(r.spacing_mm !== undefined ? { spacing_mm: r.spacing_mm } : {}),
    ...(r.number !== undefined ? { number: r.number } : {}), inside: r.inside ?? true, rotation: r.rotation ?? "none", parameters: params,
    step: "In the project, after this family is loaded through the F134 gate: duplicate a Repeating Detail type and set these values. " +
      "Not done here: the family tools never open or change a project." } };
}
export const DRAW_OPS = ["detail_lines", "filled_region", "masking_region", "text_note", "symbolic_lines"] as const;

export interface AnnotationArgs { kind: AnnotationKind; tag_category?: string; label_params?: string[]; draw?: Array<Record<string, unknown>>;
  repeating_detail?: RepeatingDetail; family_name?: string }
export interface LabelStep { param: string; in_dictionary: boolean; guid?: string; added: boolean; step: string }

/**
 * The ops for an annotation-type family and the label plan: labels themselves are placed by a person (the API can't
 * make a label), so each parameter is prepared (added from the kit dictionary where the family carries it) and checked.
 */
export function annotationOps(a: AnnotationArgs, dictionary: Map<string, SpParam> | null):
  { ops: Array<Record<string, unknown>>; problems: string[]; notes: string[]; label_plan: LabelStep[]; repeat_plan?: RepeatPlan } {
  const ops: Array<Record<string, unknown>> = [], problems: string[] = [], notes: string[] = [];
  let category = "";
  let repeat_plan: RepeatPlan | undefined;
  if (a.kind === "keynote_tag") {
    // builder16: a keynote tag labels Revit's keynote parameters; anything else is refused rather than half-made
    const bad = (a.label_params ?? []).filter((n) => !(KEYNOTE_LABELS as readonly string[]).includes(n));
    if (bad.length) problems.push(`A keynote tag labels ${KEYNOTE_LABELS.join(", ")} only, not ${bad.join(", ")}`);
    if (a.tag_category) problems.push("A keynote tag's category is Keynote Tags; leave tag_category out");
    if (!a.label_params?.length) a = { ...a, label_params: ["Key Value"] };
  }
  if (a.repeating_detail) {
    if (a.kind !== "detail_component") problems.push("repeating_detail is for a detail_component family only");
    else { const r = repeatPlan(a.repeating_detail, (a.family_name ?? "").trim()); problems.push(...r.problems); repeat_plan = r.plan ?? undefined; }
  }
  if (a.kind === "tag") {
    const t = (a.tag_category ?? "").trim();
    if (!t) problems.push("A tag needs tag_category, e.g. Door Tags or Lighting Fixture Tags");
    else if (!/tags$/i.test(t) && !/^OST_.*Tags$/i.test(t)) problems.push(`${t} isn't a tag category (a tag category ends in Tags)`);
    category = t;
  } else category = KIND_CATEGORY[a.kind];
  if (category) ops.push({ op: "set_category", name: category });
  const label_plan: LabelStep[] = [];
  const addable = a.kind === "annotation" || a.kind === "title_block";
  for (const n of a.label_params ?? []) {
    const sp = dictionary?.get(n);
    const step = a.kind === "keynote_tag"
      ? `Place a label in the tag view and pick ${n} (Revit's keynote parameter, filled from the project's keynote table)`
      : a.kind === "tag"
      ? `Place a label in the tag view and pick ${n} (it reads from the tagged element${sp ? ", a kit shared parameter" : ""})`
      : `Place a label in the family's view and pick ${n}`;
    if (addable && sp) ops.push({ op: "add_shared_param", name: sp.name, guid: sp.guid, instance: a.kind === "annotation" });
    label_plan.push({ param: n, in_dictionary: !!sp, ...(sp ? { guid: sp.guid } : {}), added: addable && !!sp, step });
  }
  const missing = a.kind === "keynote_tag" ? [] : label_plan.filter((l) => !l.in_dictionary).map((l) => l.param);
  if (missing.length) notes.push(`Not in the kit's shared parameter dictionary: ${missing.join(", ")} (a built-in parameter is fine for a tag label; anything else needs a kit parameter first)`);
  (a.draw ?? []).forEach((d, i) => {
    if (!(DRAW_OPS as readonly string[]).includes(String(d.op))) problems.push(`draw[${i}]: ${String(d.op)} isn't a drawing op (${DRAW_OPS.join(", ")})`);
    else ops.push(d.op === "symbolic_lines" ? d : { view: "annotation", ...d });
  });
  if (a.kind === "detail_component") notes.push(repeat_plan
    ? "A detail component draws in its plan view; repeat_plan holds the repeating detail type's values for the project (not set here)"
    : "A detail component draws in its plan view; repeating detail spacing is set in the project's repeating detail type (pass repeating_detail for a repeat_plan)");
  if (a.kind === "keynote_tag") notes.push("Keynote tags: the keynote table is the kit's (196 keynotes) and is set in the project; this family only shows the value");
  return { ops, problems, notes, label_plan, ...(repeat_plan ? { repeat_plan } : {}) };
}

// ---------- the real io ----------

/** The real io: fmc_doc's own runner (all its guards, ledger and logs) and the real file system. */
export async function realIo(): Promise<FamIo> {
  const { loadConfig } = await import("./policy.js");
  const { parseSharedParameters } = await import("./specs.js");
  const { runFmcDoc } = await import("../tools/fmc_doc.js");
  const { config } = loadConfig();
  let dictionary: Map<string, SpParam> | null = null;
  try { dictionary = parseSharedParameters(fs.readFileSync(expandEnv(config.shared_parameter_file), "utf8")); } catch { dictionary = null; }
  return {
    config, dictionary, ...realFs,
    doc: async (args) => {
      const r = await runFmcDoc(args as any);
      let body: any = null;
      try { body = JSON.parse(r.content[0].text); } catch { body = { error: r.content?.[0]?.text }; }
      return { body, isError: !!r.isError };
    },
  };
}

export function famReply(body: object) {
  const isError = !!(body as FamResult).refused;
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}
