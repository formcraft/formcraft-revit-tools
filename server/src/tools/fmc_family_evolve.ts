import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, csvLine, expandEnv, isInside, loadConfig } from "../fmc/policy.js";
import { FamilySpec, SpParam, SpecFile, parseSharedParameters } from "../fmc/specs.js";
import { decodeKeynoteFile, parseKeynotes } from "../fmc/library.js";
import {
  EVOLVE_FOLDER, EvolveFacts, EvolveKit, EvolveOptions, Evaluation, Fix, GateResult, ParamFact, PlaneFact, VersionEntry, applyProblems, diffFacts,
  diffGates, evaluateGates, expectedAfter, flexRegressions, orderedOps, planVersions, proposalToken, readVersions, vName,
} from "../fmc/evolve.js";
import { runFmcDoc } from "./fmc_doc.js";
import { runFmcLibrary } from "./fmc_library.js";

const win = path.win32;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_FAMILY_EVOLVE_DESCRIPTION =
  "Formcraft evolve-in-place for an existing family (.rfa). check (a dry run, the default): runs five quality gates on the family " +
  "(naming FMC_[Role]_[CategoryToken]_[Description]; the kit's shared parameters present and bound by GUID; reference planes named; flex: " +
  "every type regenerates and, with follow, each size parameter moves the solids; keynote X.YYY_ZZ on every type) and proposes fixes as " +
  "fmc_doc ops (add_shared_param, bind_shared_param, name_template_plane, set_type_value Keynote) or a new file name, with Revit's own " +
  "dry run of the ops (the real run rolled back) and the expected gates after. Nothing is written but the proposal in the reports folder; " +
  "it answers a token. apply (token from check, optionally accept: the fix ids to make): checks the file hasn't changed, copies the " +
  "original byte for byte to <folder>\\_Evolve\\<family>\\v001 (verified by sha256), opens that copy, applies the ops, flexes again (a type " +
  "that flexed before and fails now stops it: nothing saved), saves a NEW version vNNN\\<name>.rfa with its build report, re-runs the gates " +
  "and returns before/after and what changed. The original is never written; replace_original: true copies the new version over it only " +
  "after the backup is verified, and only for a file in staging. versions: the backups and versions of a family. Geometry, constraints " +
  "and a shared parameter carrying another GUID are never decided by the tool: they are listed as needs_person.";

export const FMC_FAMILY_EVOLVE_SHAPE = {
  action: z.enum(["check", "apply", "versions"]).default("check"),
  file: z.string().optional().default("").describe("check, versions: the family file (.rfa)"),
  token: z.string().optional().default("").describe("apply: the token check returned"),
  accept: z.array(z.string()).optional().describe("apply: the fix ids to make (default: every fix in the proposal)"),
  new_name: z.string().optional().describe("check: the new version's family name, when the current one breaks the naming rule"),
  keynote: z.union([z.string(), z.record(z.string())]).optional().describe("check: one keynote X.YYY_ZZ for every type, or { type: keynote }"),
  plane_names: z.array(z.object({ axis: z.enum(["x", "y", "z"]), at_mm: z.number(), name: z.string().min(1) })).optional()
    .describe("check: names for unnamed reference planes, by the axis they are square to and where they are (mm)"),
  auto_name_planes: z.boolean().optional().default(false).describe("check: name every other unnamed plane by its position (RP_X+450)"),
  required_parameters: z.array(z.string()).optional().describe("check: kit shared parameters (by name) the family must carry beyond its spec"),
  follow: z.array(z.object({ param: z.string().min(1), low_mm: z.number(), high_mm: z.number(), stepped: z.boolean().optional() })).optional()
    .describe("check and apply: size parameters to flex from low to high, reporting which solids move with each"),
  replace_original: z.boolean().optional().default(false).describe("apply: after the backup is verified, copy the new version over the original (staging only)"),
};

export type FmcFamilyEvolveArgs = z.infer<z.ZodObject<typeof FMC_FAMILY_EVOLVE_SHAPE>>;

/** Everything the tool touches, so the flow can be tested without Revit or the kit (evolve.test.ts). */
export interface EvolveIo {
  config: GuardConfig;
  now(): Date;
  exists(p: string): boolean;
  sha256(p: string): string | null;
  /** A copy that never replaces a file. */
  copy(from: string, to: string): void;
  /** replace_original only: a copy over an existing file. */
  replace(from: string, to: string): void;
  mkdir(dir: string): void;
  readText(p: string): string | null;
  writeText(p: string, text: string): void;
  list(dir: string): Array<{ folder: string; files: string[] }>;
  kit(): EvolveKit & { problems: string[] };
  /** fmc_library inspect's answer (the body). */
  inspect(file: string): Promise<Record<string, any>>;
  /** fmc_doc's answer (the body) for open, report, flex, apply, save, close. */
  doc(args: Record<string, unknown>): Promise<Record<string, any>>;
  log(action: string, target: string, result: string, detail: string): void;
}

const bodyOf = (r: { content?: Array<{ text?: string }> }) => { try { return JSON.parse(r?.content?.[0]?.text ?? "{}"); } catch { return {}; } };
const DOC_DEFAULTS = { template: "", file: "", session: "", ops: [], dry_run: true, path: "", overwrite: false, detail_level: "fine", style: "shaded", views: ["3d"] };

function readKit(cfg: GuardConfig): EvolveKit & { problems: string[] } {
  const problems: string[] = [];
  let specs: FamilySpec[] = [];
  let dictionary: Map<string, SpParam> | null = null;
  let keynotes: Set<string> | null = null;
  try { specs = (JSON.parse(fs.readFileSync(expandEnv(cfg.specs_path), "utf8").replace(/^\uFEFF/, "")) as SpecFile).families ?? []; }
  catch { problems.push(`Family specs not readable at ${cfg.specs_path}`); }
  try { dictionary = parseSharedParameters(fs.readFileSync(expandEnv(cfg.shared_parameter_file), "utf8")); }
  catch { problems.push(`Shared parameter file not readable at ${cfg.shared_parameter_file}`); }
  try { keynotes = new Set(parseKeynotes(decodeKeynoteFile(fs.readFileSync(expandEnv(cfg.keynote_file)))).map((k) => k.code)); }
  catch { problems.push(`Keynote file not readable at ${cfg.keynote_file}`); }
  return { specs: new Map(specs.map((s) => [s.family, s])), dictionary, keynotes, problems };
}

export function defaultIo(): EvolveIo {
  const { config } = loadConfig();
  return {
    config,
    now: () => new Date(),
    exists: (p) => fs.existsSync(p),
    sha256: (p) => { try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } catch { return null; } },
    copy: (a, b) => fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL),
    replace: (a, b) => fs.copyFileSync(a, b),
    mkdir: (d) => fs.mkdirSync(d, { recursive: true }),
    readText: (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } },
    writeText: (p, t) => { fs.mkdirSync(win.dirname(p), { recursive: true }); fs.writeFileSync(p, t); },
    list: (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => ({ folder: e.name, files: fs.readdirSync(win.join(dir, e.name)) })); } catch { return []; } },
    kit: () => readKit(config),
    inspect: async (file) => bodyOf(await runFmcLibrary({ action: "inspect", path: file, overwrite: false, dry_run: true, document: file } as any)),
    doc: async (args) => bodyOf(await runFmcDoc({ ...DOC_DEFAULTS, ...args } as any)),
    log: (action, target, result, detail) => {
      try {
        const dir = expandEnv(config.reports_dir);
        fs.mkdirSync(dir, { recursive: true });
        const file = win.join(dir, "FMC_MCP_FileLog.csv");
        if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
        fs.appendFileSync(file, csvLine([new Date().toISOString(), action, action === "evolve_check", target, result, detail]));
      } catch { /* logging never blocks the work */ }
    },
  };
}

const proposalsDir = (io: EvolveIo) => win.join(expandEnv(io.config.reports_dir), "Evolve");
const proposalFile = (io: EvolveIo, token: string) => win.join(proposalsDir(io), token.replace(/[^A-Za-z0-9-]/g, "") + ".json");

/** The facts of one family: fmc_library inspect (keynotes, shared GUIDs) and an fmc_doc session (parameters, planes, flex). */
async function gather(io: EvolveIo, file: string, follow: FmcFamilyEvolveArgs["follow"], session?: string) {
  const notes: string[] = [];
  let inspect: Record<string, any> = {};
  try { inspect = await io.inspect(file); } catch (e) { inspect = { error: e instanceof Error ? e.message : String(e) }; }
  const plan = inspect.plan ?? null;
  if (!plan) notes.push(`fmc_library inspect gave no plan: ${inspect.error ?? (inspect.reasons ?? []).join("; ") ?? "no reason"}`);
  let report: Record<string, any> | null = null, flex: Record<string, any> | null = null, flexError = "", opened = session ?? "", alreadyOpen = false;
  if (!opened) {
    const open = await io.doc({ action: "open", file });
    if (open.session) { opened = String(open.session); report = open.document ?? null; alreadyOpen = !!open.document?.already_open; }
    else { flexError = String(open.error ?? (open.reasons ?? []).join("; ") ?? "the session didn't open"); notes.push(`No session: ${flexError}`); }
  }
  if (opened) {
    if (!report) report = (await io.doc({ action: "report", session: opened })).document ?? null;
    flex = await io.doc({ action: "flex", session: opened, ...(follow?.length ? { follow } : {}) });
    if (flex?.error) flexError = String(flex.error);
  }
  const params: ParamFact[] = Array.isArray(report?.parameters)
    ? report!.parameters.map((p: any) => ({ name: String(p.name), shared: !!p.shared, guid: String(p.guid ?? ""), instance: p.instance, formula: p.formula }))
    : (plan?.shared_parameters ?? []).map((p: any) => ({ name: String(p.name), shared: true, guid: String(p.guid ?? "") }));
  if (!Array.isArray(report?.parameters)) notes.push("Only the shared parameters are known (no session): a family parameter that should be bound isn't seen");
  const detail: PlaneFact[] | null = Array.isArray(report?.reference_planes_detail)
    ? report!.reference_planes_detail.map((p: any) => ({ name: String(p.name ?? ""), axis: (["x", "y", "z"].includes(p.axis) ? p.axis : "") as PlaneFact["axis"], at_mm: Number(p.at_mm ?? 0), is_reference: p.is_reference }))
    : null;
  const facts: EvolveFacts = {
    file, family: String(plan?.family || report?.title || win.basename(file)).replace(/\.rfa$/i, ""), category: String(plan?.category ?? report?.category ?? ""),
    parameters: params, types: (plan?.types ?? report?.types ?? []).map(String),
    type_keynotes: Array.isArray(plan?.type_keynotes) ? plan.type_keynotes.map((t: any) => ({ type: String(t.type), keynote: String(t.keynote ?? "") })) : null,
    reference_planes: Array.isArray(report?.reference_planes) ? report!.reference_planes.map(String) : [],
    reference_planes_detail: detail, flex: (flex as any) ?? null, flexError,
  };
  return { facts, session: opened, notes, alreadyOpen, inspectPlan: plan };
}

function optionsOf(a: FmcFamilyEvolveArgs): EvolveOptions {
  return { new_name: a.new_name, keynote: a.keynote, plane_names: a.plane_names, auto_name_planes: a.auto_name_planes, required_parameters: a.required_parameters };
}

interface StoredProposal {
  token: string; created: string; source: string; source_sha256: string; family: string; target_name: string; follow?: FmcFamilyEvolveArgs["follow"];
  fixes: Fix[]; needs_person: Evaluation["needs_person"]; gates: GateResult[]; before: EvolveFacts; source_open?: boolean; options?: EvolveOptions;
}

export async function runCheck(a: FmcFamilyEvolveArgs, io: EvolveIo) {
  const file = a.file.trim();
  if (win.extname(file).toLowerCase() !== ".rfa") return reply({ refused: true, reasons: ["check needs a family file (.rfa)"] }, true);
  if (!io.exists(file)) return reply({ refused: true, reasons: [`Not found: ${file}`] }, true);
  const sha = io.sha256(file);
  if (!sha) return reply({ refused: true, reasons: [`${file} can't be read`] }, true);
  const kit = io.kit();
  const g = await gather(io, file, a.follow);
  try {
    const ev = evaluateGates(g.facts, kit, optionsOf(a));
    if (ev.problems.length) return reply({ refused: true, reasons: ev.problems, gates: ev.gates }, true);
    const ops = orderedOps(ev.fixes);
    // Revit's own dry run of the batch: the real run rolled back (create / update / skip per op)
    let preview: Record<string, any> | null = null;
    if (ops.length && g.session && g.alreadyOpen) g.notes.push("The file is open in a Revit window: Revit's dry run of the ops isn't run on the person's document; apply runs them on its backup");
    else if (ops.length && g.session) preview = await io.doc({ action: "apply", session: g.session, ops, dry_run: true });
    else if (ops.length) g.notes.push("Revit's dry run of the ops runs on apply (the file isn't in the library roots, so it opens from its backup in staging)");
    const token = proposalToken(file, sha, ev.target_name, ops);
    const stored: StoredProposal = { token, created: io.now().toISOString(), source: file, source_sha256: sha, family: g.facts.family, target_name: ev.target_name,
      follow: a.follow, fixes: ev.fixes, needs_person: ev.needs_person, gates: ev.gates, before: g.facts, source_open: g.alreadyOpen, options: optionsOf(a) };
    const versions = planVersions(file, sha, ev.target_name, io.config, existingVersions(io, file, ev.target_name));
    if (ev.fixes.length) io.writeText(proposalFile(io, token), JSON.stringify(stored, null, 2));
    io.log("evolve_check", file, "done", `${token} · ${ev.fixes.length} fixes · ${ev.needs_person.length} for a person`);
    const previewError = preview?.error ? String(preview.error) : "";
    return reply({
      dry_run: true, family: g.facts.family, file, sha256: sha, gates: ev.gates,
      fixes: ev.fixes.map((f) => ({ id: f.id, gate: f.gate, summary: f.summary, ops: f.ops.length, ...(f.rename_to ? { rename_to: f.rename_to } : {}) })),
      needs_person: ev.needs_person, ops,
      preview: preview ? { revit_dry_run: preview.error ? null : { created: preview.created ?? 0, updated: preview.updated ?? 0, skipped: preview.skipped ?? 0, ops: preview.ops ?? [], warnings: preview.warnings ?? [] },
        ...(previewError ? { error: previewError } : {}) } : null,
      expected: expectedAfter(ev, new Set(ev.fixes.map((f) => f.id))),
      versions: { backup: versions.backup.path, backup_reused: versions.backup.reuse, new_version: versions.target.path, problems: versions.problems },
      token: ev.fixes.length ? token : "", kit_problems: kit.problems, notes: g.notes,
      next: !ev.fixes.length ? (ev.needs_person.length ? "Nothing a tool can fix: the items under needs_person are for a person" : "Every gate passes: nothing to evolve")
        : previewError ? `Revit's dry run failed (${previewError}): fix the inputs and check again`
        : versions.problems.length ? `The new version can't be saved: ${versions.problems.join("; ")}`
        : `Run apply with token ${token} (and accept: [ids] for some of the fixes) to back up the original and save ${win.basename(versions.target.path)} as a new version`,
    });
  } finally {
    if (g.session) await io.doc({ action: "close", session: g.session });
  }
}

/** The versions already under the family's _Evolve folder (either place planVersions may use). */
function existingVersions(io: EvolveIo, source: string, targetName: string): VersionEntry[] {
  const probe = planVersions(source, "", targetName, io.config, []);
  const listing = io.list(probe.dir);
  const manifests = new Map<string, { backup?: boolean; sha256?: string }>();
  for (const l of listing) {
    const m = l.files.find((f) => /\.evolve\.json$/i.test(f));
    if (!m) continue;
    try { manifests.set(l.folder, JSON.parse(io.readText(win.join(probe.dir, l.folder, m)) ?? "{}")); } catch { /* unreadable manifest: sha from the file */ }
  }
  return readVersions(listing, probe.dir, manifests, (f) => io.sha256(f));
}

export async function runApply(a: FmcFamilyEvolveArgs, io: EvolveIo) {
  const token = a.token.trim();
  let p: StoredProposal | null = null;
  if (token) { try { p = JSON.parse(io.readText(proposalFile(io, token)) ?? "null"); } catch { p = null; } }
  const currentSha = p ? io.sha256(p.source) : null;
  const problems = applyProblems(p, token, currentSha, a.accept, io.now());
  if (problems.length || !p) return reply({ refused: true, reasons: problems }, true);
  const accepted = new Set(a.accept?.length ? a.accept : p.fixes.map((f) => f.id));
  const fixes = p.fixes.filter((f) => accepted.has(f.id));
  const rename = fixes.find((f) => f.rename_to)?.rename_to;
  const targetName = rename ?? p.family;
  const ops = orderedOps(fixes);
  const plan = planVersions(p.source, p.source_sha256, targetName, io.config, existingVersions(io, p.source, targetName));
  if (plan.problems.length) return reply({ refused: true, reasons: plan.problems }, true);
  if (io.exists(plan.target.path)) return reply({ refused: true, reasons: [`${plan.target.path} exists: versions are never overwritten`] }, true);
  if (a.replace_original) {
    const r: string[] = [];
    if (!io.config.write_roots.some((w) => isInside(p!.source, w)) || !io.config.library_roots.some((w) => isInside(p!.source, w))) r.push("replace_original is only for a file in staging (the library and write roots)");
    if (rename) r.push("replace_original and a new name don't go together: the original keeps its name");
    if (p.source_open) r.push("The original was open in Revit at check: it isn't replaced while a window may hold it");
    if (r.length) return reply({ refused: true, reasons: r }, true);
  }

  // 1. the backup, before anything else: a byte copy, verified
  if (!plan.backup.reuse) {
    io.mkdir(win.dirname(plan.backup.path));
    io.copy(p.source, plan.backup.path);
    io.writeText(plan.backup.path.replace(/\.rfa$/i, ".evolve.json"), JSON.stringify({ backup: true, of: p.source, sha256: p.source_sha256, at: io.now().toISOString() }, null, 2));
  }
  const backupSha = io.sha256(plan.backup.path);
  if (backupSha !== p.source_sha256) return reply({ refused: true, reasons: [`The backup ${plan.backup.path} doesn't match the original (sha256): nothing was changed`] }, true);
  io.log("evolve_backup", plan.backup.path, "done", `${p.token} · ${p.source_sha256.slice(0, 12)}`);

  // 2. the session opens the backup copy, never the original (nor a document the person has open)
  const open = await io.doc({ action: "open", file: plan.backup.path });
  if (!open.session) return reply({ refused: true, reasons: [`The backup didn't open: ${open.error ?? (open.reasons ?? []).join("; ")}`], backup: plan.backup.path }, true);
  const session = String(open.session);
  let saved = false;
  try {
    const applied = ops.length ? await io.doc({ action: "apply", session, ops, dry_run: false }) : { created: 0, updated: 0, skipped: 0, ops: [] };
    if (applied.error || applied.refused) return reply({ refused: true, reasons: [String(applied.error ?? (applied.reasons ?? []).join("; "))], backup: plan.backup.path, saved: false }, true);
    // 3. flex again: a type that regenerated before and fails now stops it, nothing is saved
    const flexAfter = await io.doc({ action: "flex", session, ...(p.follow?.length ? { follow: p.follow } : {}) });
    // with no flex from check (a released family has no session there), any type that fails now stops it: the tool can't tell it was broken before
    const baseline = p.before.flex && Array.isArray(p.before.flex.types) ? p.before.flex : null;
    const regressions = baseline ? flexRegressions(baseline, flexAfter as any)
      : ((flexAfter as any)?.types ?? []).filter((x: any) => !x.ok).map((x: any) => `${x.type}${x.errors?.length ? `: ${x.errors[0]}` : ""} (no flex from check to compare with)`);
    if (regressions.length) return reply({ refused: true, reasons: [`The fixes broke the flex: ${regressions.join("; ")}. Nothing was saved; the original and its backup are as they were`], backup: plan.backup.path, saved: false }, true);
    // 4. the new version, saved by Revit with its build report
    io.mkdir(win.dirname(plan.target.path));
    const save = await io.doc({ action: "save", session, path: plan.target.path, overwrite: false });
    if (save.error || save.refused) return reply({ refused: true, reasons: [String(save.error ?? (save.reasons ?? []).join("; "))], backup: plan.backup.path, saved: false }, true);
    saved = true;
    await io.doc({ action: "close", session });

    // 5. the gates again, on the saved version
    const after = await gather(io, plan.target.path, p.follow);
    if (after.session) await io.doc({ action: "close", session: after.session });
    const kit = io.kit();
    // the saved version against the same kit requirements; the names, keynotes and plane names it was given are now in the file
    const evAfter = evaluateGates(after.facts, kit, { required_parameters: p.options?.required_parameters });
    const diff = diffGates(p.gates, evAfter.gates);
    const changed = diffFacts(p.before, after.facts);
    const newSha = io.sha256(plan.target.path);
    // 6. the original is untouched (unless replace_original) and the backup still holds its bytes
    const checks = { original_unchanged: io.sha256(p.source) === p.source_sha256, backup_verified: io.sha256(plan.backup.path) === p.source_sha256 };
    let replaced: Record<string, unknown> | null = null;
    if (a.replace_original) {
      if (!checks.original_unchanged || !checks.backup_verified || !newSha) replaced = { done: false, reason: "the original or its backup didn't verify, so the original was left as it is" };
      else {
        io.replace(plan.target.path, p.source);
        const ok = io.sha256(p.source) === newSha;
        replaced = { done: ok, original: p.source, backup: plan.backup.path, ...(ok ? {} : { reason: "the copy over the original didn't verify: restore it from the backup" }) };
      }
    }
    const manifest = { backup: false, version: vName(plan.target.n), of: p.source, from_backup: plan.backup.path, sha256: newSha, token: p.token, at: io.now().toISOString(),
      fixes: fixes.map((f) => f.id), ops, applied: { created: applied.created ?? 0, updated: applied.updated ?? 0, skipped: applied.skipped ?? 0 }, gates_before: p.gates, gates_after: evAfter.gates, diff, changed };
    io.writeText(plan.target.path.replace(/\.rfa$/i, ".evolve.json"), JSON.stringify(manifest, null, 2));
    io.log("evolve_apply", plan.target.path, "done", `${p.token} · ${ops.length} ops · ${diff.filter((d) => d.change === "fixed").length} gates fixed`);
    return reply({
      applied: true, version: vName(plan.target.n), new_version: plan.target.path, backup: plan.backup.path, sha256: newSha, ...checks,
      ...(replaced ? { replace_original: replaced } : {}),
      ops: applied.ops ?? [], created: applied.created ?? 0, updated: applied.updated ?? 0, skipped: applied.skipped ?? 0,
      gates_before: p.gates, gates_after: evAfter.gates, diff, changed, needs_person: [...p.needs_person, ...evAfter.needs_person.filter((x) => !p!.needs_person.some((y) => y.detail === x.detail))],
      notes: after.notes,
      next: diff.some((d) => d.change === "regressed") ? "A gate got worse: compare gates_before and gates_after; the original and its backup are untouched"
        : `Saved as a new version. The original is untouched; ${win.basename(plan.target.path)} goes through Gate A (fmc_recipe gate) before a person releases it`,
    });
  } finally {
    if (!saved) await io.doc({ action: "close", session });
  }
}

export function runVersions(a: FmcFamilyEvolveArgs, io: EvolveIo) {
  const file = a.file.trim();
  if (!file) return reply({ refused: true, reasons: ["versions needs file"] }, true);
  const family = win.basename(file).replace(/\.rfa$/i, "");
  const list = existingVersions(io, file, family);
  const dir = planVersions(file, "", family, io.config, []).dir;
  return reply({ family, folder: dir, versions: list.map((v) => ({ version: vName(v.n), file: v.file, backup: v.backup, sha256: v.sha256 })), evolve_folder: EVOLVE_FOLDER });
}

export async function runFmcFamilyEvolve(args: FmcFamilyEvolveArgs, io: EvolveIo = defaultIo()) {
  try {
    if (args.action === "apply") return await runApply(args, io);
    if (args.action === "versions") return runVersions(args, io);
    return await runCheck(args, io);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    io.log("evolve_" + args.action, args.file || args.token, "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcFamilyEvolveTool(server: McpServer) {
  server.tool("fmc_family_evolve", FMC_FAMILY_EVOLVE_DESCRIPTION, FMC_FAMILY_EVOLVE_SHAPE, (args) => runFmcFamilyEvolve(args as FmcFamilyEvolveArgs));
}
