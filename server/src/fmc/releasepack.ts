/**
 * Release step (L001 build plan item 3, 28 Nov 2026): a generated family goes from staging to a release-READY package,
 * validated, with a manifest. It prepares; it never publishes. Hard rule 2 / Part 9.12: only the Family Librarian
 * releases (the pane's Families › Quality and release, with a reviewer and a note: fmc_recipe.ts paneRelease). So this
 * step:
 *   - reads the staged family (<family_staging_root>\<Role>\<family>.rfa), its Gate A result, recipe and build record;
 *   - checks them (RP-01 … RP-09 below) and plans a package folder under <family_staging_root>\_ReleasePackages\<Role>\;
 *   - on a confirmed run copies those files there with a manifest.json (hashes, gate, checks, where the pane will
 *     release it to) and nothing else.
 * It never moves, renames or deletes the staged file, never writes to 04_Families\<Role> (the library), a library root,
 * a Revit or Autodesk add-ins folder or a project folder, and never loads a family into Revit. Pure planning here; the
 * tool (tools/fmc_release_package.ts) does the file work.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { GuardConfig, checkWritePath, expandEnv, isInside } from "./policy.js";
import { parseRecipe, releasePath, roleOf, stagingPath } from "./recipes.js";
import { expandSkeletons, opsProblems, splitProblems } from "./ops.js";
import type { SpParam } from "./specs.js";
import type { MaterialDb } from "./materials.js";

const win = path.win32;

export const RELEASE_SCHEMA = "fmc-release-package/1";
export const PACKAGES_FOLDER = "_ReleasePackages";
const NAME = /^FMC_[A-Z]{1,2}_[A-Za-z0-9]+_[A-Za-z0-9_]+$/;
const PROJECT_WORDS = /hebert|a-0001/i;
/** Folders a package may never go into, by path segment: Revit add-ins live under Autodesk\...\Addins (the library is checked by path). */
const FORBIDDEN_SEGMENTS = ["addins", "autodesk"];

export type CheckState = "Pass" | "Warn" | "Fail";
export interface ReleaseCheck { id: string; check: string; state: CheckState; detail: string }
export interface PackageFile { kind: "family" | "recipe" | "gate" | "build" | "type_image"; from: string; name: string; bytes: number; sha256: string }

/** What the planner reads; the tool gives the real file system, tests give a map. */
export interface ReleaseIo {
  exists(p: string): boolean;
  stat(p: string): { size: number; mtimeMs: number } | null;
  readText(p: string): string | null;
  sha256(p: string): string | null;
}

export interface ReleaseInput { family?: string; file?: string; note?: string }

export interface ReleasePlan {
  family: string;
  role: string;
  staged_file: string;
  package_dir: string;
  release_to: string;
  files: PackageFile[];
  checks: ReleaseCheck[];
  ready: boolean;
  blockers: string[];
  warnings: string[];
  plan_id: string;
  manifest: Record<string, unknown>;
}

type Cfg = Pick<GuardConfig, "family_staging_root" | "write_roots" | "blocked_segments" | "library_roots">;

const readJson = (io: ReleaseIo, p: string): any => {
  const t = io.readText(p);
  if (t == null) return null;
  try { return JSON.parse(t.replace(/^\uFEFF/, "")); } catch { return undefined; }
};

/** The same hash fmc_doc's build record keeps (doc.ts buildReport): the ops as [op, name] pairs. */
export function namesHash(ops: Array<{ op: string; name?: unknown }>): string {
  return createHash("sha256").update(JSON.stringify(ops.map((o) => [o.op, o.name]))).digest("hex").slice(0, 16);
}

/** The package folder: <staging>\_ReleasePackages\<Role>\<family>__<first 12 of the family file's sha256>. */
export function packageDir(stagingRoot: string, family: string, sha: string): string {
  return win.join(expandEnv(stagingRoot), PACKAGES_FOLDER, roleOf(family) || "_Unsorted", `${family}__${sha.slice(0, 12)}`);
}

/**
 * Why a package folder isn't a place this step may write: outside the write roots or in a CDE gate folder
 * (checkWritePath), inside the library (04_Families\<Role>, the folder the pane releases to) or a library root, in a
 * Revit / Autodesk add-ins folder, or in a project folder. Empty when it's fine.
 */
export function packagePlaceProblems(dir: string, family: string, cfg: Cfg): string[] {
  const p: string[] = [];
  const v = checkWritePath(win.join(dir, "manifest.json"), cfg as GuardConfig, { checkName: false });
  p.push(...v.reasons);
  const staging = expandEnv(cfg.family_staging_root);
  if (!isInside(dir, staging)) p.push(`${dir} isn't inside the family staging root (${staging})`);
  const libraryRole = win.dirname(releasePath(staging, family));
  if (isInside(dir, libraryRole)) p.push(`${dir} is inside the library folder ${libraryRole}: only the Family Librarian writes there (Part 9.12)`);
  for (const r of cfg.library_roots ?? []) if (r && isInside(dir, expandEnv(r))) p.push(`${dir} is inside the library root ${r}`);
  const segs = win.normalize(dir).toLowerCase().split("\\").filter(Boolean);
  const bad = FORBIDDEN_SEGMENTS.filter((s) => segs.includes(s));
  if (bad.length) p.push(`${dir} is in a ${bad.join(" / ")} folder: a release package never goes near Revit add-ins or project folders`);
  if (PROJECT_WORDS.test(dir)) p.push(`${dir} names a project folder: never touched`);
  return p;
}

const fmtMb = (b: number) => `${Math.round((b / 1048576) * 100) / 100} MB`;

/**
 * Plans the package for one staged family: the checks, the files and their hashes, where it goes, the manifest and a
 * plan_id that changes when any of those change (so a confirmed run is the run the person saw).
 */
export function planRelease(input: ReleaseInput, cfg: Cfg, io: ReleaseIo,
  kit: { dictionary?: Map<string, SpParam> | null; materials?: MaterialDb | null } = {}): ReleasePlan {
  const staging = expandEnv(cfg.family_staging_root);
  const checks: ReleaseCheck[] = [];
  const add = (id: string, check: string, state: CheckState, detail: string) => checks.push({ id, check, state, detail });

  // ---- which family
  let file = (input.file ?? "").trim();
  let family = (input.family ?? "").trim();
  if (!family && file) family = win.basename(file).replace(/\.rfa$/i, "");
  if (!file && family) file = stagingPath(staging, family);
  const role = roleOf(family);

  // RP-01 name
  if (!NAME.test(family) || !role) add("RP-01", "Name follows FMC_<Role>_<Token>_<Description>", "Fail", family || "(no family named)");
  else if (PROJECT_WORDS.test(family) || PROJECT_WORDS.test(file)) add("RP-01", "Name follows FMC_<Role>_<Token>_<Description>", "Fail", `${family}: a project name, never packaged here`);
  else add("RP-01", "Name follows FMC_<Role>_<Token>_<Description>", "Pass", family);

  // RP-02 staged file
  const want = family ? stagingPath(staging, family) : "";
  const st = file ? io.stat(file) : null;
  if (!file || !st) add("RP-02", "Staged family file", "Fail", `not found: ${file || "(none)"}`);
  else if (/\.\d{4}\.rfa$/i.test(file)) add("RP-02", "Staged family file", "Fail", `${win.basename(file)} is a Revit backup, not the family`);
  else if (win.normalize(file).toLowerCase() !== win.normalize(want).toLowerCase())
    add("RP-02", "Staged family file", "Fail", `only a family staged at ${want} is packaged (given ${file})`);
  else add("RP-02", "Staged family file", "Pass", `${file} · ${fmtMb(st.size)}`);

  const stem = file.replace(/\.rfa$/i, "");
  const files: PackageFile[] = [];
  const sha = st ? io.sha256(file) ?? "" : "";
  if (st && sha) files.push({ kind: "family", from: file, name: win.basename(file), bytes: st.size, sha256: sha });

  // RP-03 Gate A
  const gateFile = stem + ".gate.json";
  const gate = readJson(io, gateFile);
  let gateSummary: Record<string, unknown> = { file: gateFile, found: false };
  if (gate === null) add("RP-03", "Gate A passed on this file", "Fail", `no Gate A result (${win.basename(gateFile)}): run fmc_recipe gate first`);
  else if (gate === undefined) add("RP-03", "Gate A passed on this file", "Fail", `${win.basename(gateFile)} isn't readable JSON`);
  else {
    const lines = (gate.lines ?? []) as Array<{ check: string; state: string; detail?: string }>;
    const fails = lines.filter((l) => l.state === "Fail").map((l) => l.check);
    const warns = lines.filter((l) => l.state === "Warn").map((l) => l.check);
    const notChecked = lines.filter((l) => /not checked/i.test(l.state)).map((l) => l.check);
    const at = Date.parse(String(gate.at ?? ""));
    gateSummary = { file: gateFile, found: true, verdict: gate.verdict, at: gate.at, fails, warns, not_checked: notChecked };
    if (String(gate.verdict) !== "Pass") add("RP-03", "Gate A passed on this file", "Fail", `verdict ${JSON.stringify(gate.verdict)}${fails.length ? `: ${fails.join("; ")}` : ""}`);
    else if (gate.family && gate.family !== family) add("RP-03", "Gate A passed on this file", "Fail", `the gate result is for ${gate.family}`);
    else if (st && !(Number.isFinite(at) && at >= st.mtimeMs - 1000)) add("RP-03", "Gate A passed on this file", "Fail", `stale: the file changed after Gate A (${gate.at}); run fmc_recipe gate again`);
    else add("RP-03", "Gate A passed on this file", "Pass", `Pass at ${gate.at}${warns.length ? ` · warnings: ${warns.join("; ")}` : ""}`);
    if (notChecked.length) add("RP-03b", "Gate A checks a person still does", "Warn", notChecked.join("; "));
    const gs = st ? io.stat(gateFile) : null;
    const gh = gs ? io.sha256(gateFile) : null;
    if (gs && gh) files.push({ kind: "gate", from: gateFile, name: win.basename(gateFile), bytes: gs.size, sha256: gh });
  }

  // RP-04 recipe
  const recipeFile = stem + ".recipe.json";
  const recipeText = io.readText(recipeFile);
  let recipeSummary: Record<string, unknown> = { file: recipeFile, found: false };
  let recipeOps: Array<{ op: string; name?: unknown }> | null = null;
  if (recipeText == null) add("RP-04", "Recipe beside the family checks clean", "Warn", `no ${win.basename(recipeFile)}: the build can't be repeated from the package`);
  else {
    const { recipe, problems } = parseRecipe(recipeText);
    if (!recipe) add("RP-04", "Recipe beside the family checks clean", "Fail", problems.slice(0, 3).join("; "));
    else if (recipe.family !== family) add("RP-04", "Recipe beside the family checks clean", "Fail", `the recipe is for ${recipe.family}`);
    else {
      const { errors } = splitProblems(opsProblems(recipe.ops, kit.dictionary === undefined ? null : kit.dictionary, win.dirname(staging), kit.materials ?? undefined,
        { template: win.basename(recipe.template) }));
      const pending = Object.entries(recipe.values).filter(([, v]) => v.source_status === "pending").map(([k]) => k);
      const byStatus = Object.fromEntries(["verified", "EA", "assumed", "pending"].map((s) => [s, Object.values(recipe.values).filter((v) => v.source_status === s).length]));
      recipeSummary = { file: recipeFile, found: true, template: recipe.template, ops: recipe.ops.length, values: byStatus };
      recipeOps = expandSkeletons(recipe.ops) as Array<{ op: string; name?: unknown }>;
      if (kit.dictionary == null) add("RP-04", "Recipe beside the family checks clean", "Warn", "the kit's shared parameter file isn't readable here, so rule 7 GUIDs weren't checked");
      else if (errors.length) add("RP-04", "Recipe beside the family checks clean", "Fail", `${errors.length} error(s): ${errors.slice(0, 3).join(" | ")}`);
      else add("RP-04", "Recipe beside the family checks clean", "Pass", `${recipe.ops.length} ops, 0 errors`);
      if (pending.length) add("RP-04b", "No value pending a source", "Warn", `pending: ${pending.join(", ")}`);
    }
    const rs = io.stat(recipeFile), rh = io.sha256(recipeFile);
    if (rs && rh) files.push({ kind: "recipe", from: recipeFile, name: win.basename(recipeFile), bytes: rs.size, sha256: rh });
  }

  // RP-05 build record
  const buildFile = stem + ".build.json";
  const build = readJson(io, buildFile);
  let buildSummary: Record<string, unknown> = { file: buildFile, found: false };
  if (!build) add("RP-05", "Build record matches the recipe", "Warn", `no readable ${win.basename(buildFile)}`);
  else {
    buildSummary = { file: buildFile, found: true, saved_at: build.saved_at, plugin: build.plugin, kit: build.kit, ops_hash: build.ops_hash };
    if (!recipeOps) add("RP-05", "Build record matches the recipe", "Warn", `built ${build.saved_at ?? "?"} (plugin ${build.plugin ?? "?"}); no recipe to match it to`);
    else if (build.ops_hash && build.ops_hash === namesHash(recipeOps)) add("RP-05", "Build record matches the recipe", "Pass", `built ${build.saved_at} from these ${recipeOps.length} ops (plugin ${build.plugin ?? "?"}, kit ${build.kit ?? "?"})`);
    else add("RP-05", "Build record matches the recipe", "Warn", `the build record's ops (${build.ops_hash ?? "no hash"}) don't match the recipe's (${namesHash(recipeOps)}): built stepwise, or the recipe changed since`);
    const bs = io.stat(buildFile), bh = io.sha256(buildFile);
    if (bs && bh) files.push({ kind: "build", from: buildFile, name: win.basename(buildFile), bytes: bs.size, sha256: bh });
  }

  // type image (optional): <staging>\<Role>\_Images\<family>.png or <family>_3d.png
  for (const img of [win.join(win.dirname(file), "_Images", `${family}.png`), win.join(win.dirname(file), "_Images", `${family}_3d.png`)]) {
    const s = io.stat(img), h = s ? io.sha256(img) : null;
    if (s && h) { files.push({ kind: "type_image", from: img, name: win.basename(img), bytes: s.size, sha256: h }); break; }
  }

  // RP-06 where the pane will release it
  const releaseTo = family ? releasePath(staging, family) : "";
  if (releaseTo && io.exists(releaseTo)) add("RP-06", "Release target is free", "Warn", `${releaseTo} exists: the Family Librarian archives the released version first (the pane refuses until then)`);
  else add("RP-06", "Release target is free", "Pass", releaseTo ? `the pane releases to ${releaseTo}` : "-");

  // RP-07 package place
  const dir = family && sha ? packageDir(staging, family, sha) : "";
  const place = dir ? packagePlaceProblems(dir, family, cfg) : ["no package folder: the family file isn't readable"];
  add("RP-07", "Package folder is a place this step may write", place.length ? "Fail" : "Pass", place.length ? place.join("; ") : dir);

  // RP-08 not packaged already (a package is never overwritten; the same file gives the same folder)
  const already = dir ? readJson(io, win.join(dir, "manifest.json")) : null;
  if (dir && io.exists(dir)) add("RP-08", "Not packaged already", already ? "Warn" : "Fail",
    already ? `${dir} holds a package of this exact file (${already.prepared_at ?? "?"}): nothing to do; fmc_release_package verify re-checks it`
      : `${dir} exists without a manifest (an interrupted run?): a person looks at it; it is never overwritten`);
  else if (dir && io.exists(dir + ".partial")) add("RP-08", "Not packaged already", "Fail", `${dir}.partial is left from an interrupted run: a person looks at it first`);
  else add("RP-08", "Not packaged already", "Pass", "new package");

  // RP-09 the size the kit allows (Gate A checks it too; repeated so a package never carries an outsize file)
  if (st) add("RP-09", "Family file size", st.size <= 2.7 * 1048576 ? "Pass" : "Fail", `${fmtMb(st.size)} (limit 2.7 MB)`);

  const blockers = checks.filter((c) => c.state === "Fail").map((c) => `${c.id} ${c.check}: ${c.detail}`);
  const warnings = checks.filter((c) => c.state === "Warn").map((c) => `${c.id} ${c.check}: ${c.detail}`);
  const ready = blockers.length === 0 && !(dir && io.exists(dir));
  const plan_id = "rp-" + createHash("sha256").update(JSON.stringify({ family, dir, files: files.map((f) => [f.kind, f.sha256]), checks: checks.map((c) => [c.id, c.state]) })).digest("hex").slice(0, 16);
  const manifest = {
    schema: RELEASE_SCHEMA, family, role, plan_id, state: "prepared", published: false, installed: false,
    next_step: "A person releases it in the pane (Families › Quality and release): the Family Librarian, with a reviewer and a note. " +
      "This package doesn't publish, install, load or copy anything into the library, a project or a Revit folder.",
    note: (input.note ?? "").trim(),
    staged_file: { path: file, sha256: sha, bytes: st?.size ?? 0 },
    release_to: releaseTo,
    files: files.map((f) => ({ kind: f.kind, name: f.name, bytes: f.bytes, sha256: f.sha256, from: f.from })),
    gate: gateSummary, recipe: recipeSummary, build: buildSummary, checks,
  };
  return { family, role, staged_file: file, package_dir: dir, release_to: releaseTo, files, checks, ready, blockers, warnings, plan_id, manifest };
}

export interface VerifyResult { package_dir: string; manifest_found: boolean; ok: boolean; files: Array<{ name: string; ok: boolean; detail: string }>; staged_unchanged: boolean | null; problems: string[] }

/** Re-hashes a package's files (and the staged family) against its manifest. Read-only. */
export function verifyPackage(dir: string, io: ReleaseIo): VerifyResult {
  const m = readJson(io, win.join(dir, "manifest.json"));
  if (!m || m.schema !== RELEASE_SCHEMA) return { package_dir: dir, manifest_found: false, ok: false, files: [], staged_unchanged: null, problems: [`no ${RELEASE_SCHEMA} manifest in ${dir}`] };
  const files = (m.files ?? []).map((f: { name: string; sha256: string }) => {
    const h = io.sha256(win.join(dir, f.name));
    return { name: f.name, ok: h === f.sha256, detail: h == null ? "missing" : h === f.sha256 ? "sha256 matches" : "changed since it was packaged" };
  });
  const sh = m.staged_file?.path ? io.sha256(m.staged_file.path) : null;
  const stagedUnchanged = sh == null ? null : sh === m.staged_file.sha256;
  const problems = [...files.filter((f: { ok: boolean }) => !f.ok).map((f: { name: string; detail: string }) => `${f.name}: ${f.detail}`),
    ...(stagedUnchanged === false ? ["the staged family changed after it was packaged: package it again"] : []),
    ...(stagedUnchanged === null ? ["the staged family isn't there any more (released, or moved)"] : [])];
  return { package_dir: dir, manifest_found: true, ok: files.every((f: { ok: boolean }) => f.ok) && stagedUnchanged !== false, files, staged_unchanged: stagedUnchanged, problems };
}
