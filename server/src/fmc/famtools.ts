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

/** Read-only: open the template in a background session, report it, close it without saving (close runs even on failure). */
export async function inspectTemplate(template: string, io: Pick<FamIo, "doc">): Promise<Record<string, unknown>> {
  const o = await io.doc({ action: "open", template });
  if (o.isError || !o.body?.session) return { refused: true, reasons: [`fmc_doc open failed: ${JSON.stringify(o.body)}`] };
  const session = String(o.body.session);
  try {
    const r = await io.doc({ action: "report", session });
    if (r.isError) return { refused: true, reasons: [r.body?.error ?? "fmc_doc report failed"], session };
    return { session_closed: session, report: r.body?.document ?? r.body };
  } finally {
    await io.doc({ action: "close", session });
  }
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

export const TWO_D_OPS = ["masking_region", "filled_region", "detail_lines", "symbolic_lines"] as const;
export function twoDOps(items: Array<Record<string, unknown>>): { ops: Array<Record<string, unknown>>; problems: string[] } {
  const problems: string[] = [];
  items.forEach((f, i) => { if (!(TWO_D_OPS as readonly string[]).includes(String(f.op))) problems.push(`items[${i}]: ${String(f.op)} isn't a 2D op (${TWO_D_OPS.join(", ")})`); });
  return { ops: problems.length ? [] : items, problems };
}

// ---------- FE-04 fmc_fam_light ----------

export interface LightArgs { name?: string; shape?: string; distribution?: string; lumens?: number; lumens_by_type?: Record<string, number>; kelvin?: number;
  beam_deg?: number; field_deg?: number; source_z_mm?: number; ensure_category?: boolean }
export function lightOps(a: LightArgs): Array<Record<string, unknown>> {
  const ops: Array<Record<string, unknown>> = [];
  if (a.ensure_category !== false) ops.push({ op: "set_category", name: "Lighting Fixtures" });
  const l: Record<string, unknown> = { op: "light_source", name: a.name || "Light source" };
  for (const k of ["shape", "distribution", "lumens", "lumens_by_type", "kelvin", "beam_deg", "field_deg", "source_z_mm"] as const)
    if (a[k] !== undefined) l[k] = a[k];
  ops.push(l);
  return ops;
}

// ---------- FE-05 fmc_fam_annotation ----------

export const ANNOTATION_KINDS = ["tag", "annotation", "title_block", "detail_component"] as const;
export type AnnotationKind = typeof ANNOTATION_KINDS[number];
export const KIND_CATEGORY: Record<Exclude<AnnotationKind, "tag">, string> = {
  annotation: "Generic Annotations", title_block: "Title Blocks", detail_component: "Detail Items",
};
export const DRAW_OPS = ["detail_lines", "filled_region", "masking_region", "text_note", "symbolic_lines"] as const;

export interface AnnotationArgs { kind: AnnotationKind; tag_category?: string; label_params?: string[]; draw?: Array<Record<string, unknown>> }
export interface LabelStep { param: string; in_dictionary: boolean; guid?: string; added: boolean; step: string }

/**
 * The ops for an annotation-type family and the label plan: labels themselves are placed by a person (the API can't
 * make a label), so each parameter is prepared (added from the kit dictionary where the family carries it) and checked.
 */
export function annotationOps(a: AnnotationArgs, dictionary: Map<string, SpParam> | null):
  { ops: Array<Record<string, unknown>>; problems: string[]; notes: string[]; label_plan: LabelStep[] } {
  const ops: Array<Record<string, unknown>> = [], problems: string[] = [], notes: string[] = [];
  let category = "";
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
    const step = a.kind === "tag"
      ? `Place a label in the tag view and pick ${n} (it reads from the tagged element${sp ? ", a kit shared parameter" : ""})`
      : `Place a label in the family's view and pick ${n}`;
    if (addable && sp) ops.push({ op: "add_shared_param", name: sp.name, guid: sp.guid, instance: a.kind === "annotation" });
    label_plan.push({ param: n, in_dictionary: !!sp, ...(sp ? { guid: sp.guid } : {}), added: addable && !!sp, step });
  }
  const missing = label_plan.filter((l) => !l.in_dictionary).map((l) => l.param);
  if (missing.length) notes.push(`Not in the kit's shared parameter dictionary: ${missing.join(", ")} (a built-in parameter is fine for a tag label; anything else needs a kit parameter first)`);
  (a.draw ?? []).forEach((d, i) => {
    if (!(DRAW_OPS as readonly string[]).includes(String(d.op))) problems.push(`draw[${i}]: ${String(d.op)} isn't a drawing op (${DRAW_OPS.join(", ")})`);
    else ops.push(d.op === "symbolic_lines" ? d : { view: "annotation", ...d });
  });
  if (a.kind === "detail_component") notes.push("A detail component draws in its plan view; repeating detail spacing is set in the project's repeating detail type, not here");
  return { ops, problems, notes, label_plan };
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
