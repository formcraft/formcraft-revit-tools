import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { parseSharedParameters, type SpParam } from "../fmc/specs.js";
import { parseMaterialDb, type MaterialDb } from "../fmc/materials.js";
import { PACKAGES_FOLDER, ReleaseIo, packagePlaceProblems, planRelease, verifyPackage } from "../fmc/releasepack.js";
import { roleOf } from "../fmc/recipes.js";

const win = path.win32;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_RELEASE_PACKAGE_DESCRIPTION =
  "Formcraft release step (prepare only). Takes a generated family from staging (<family_staging_root>\\<Role>\\<family>.rfa) to a " +
  "release-ready package with validation: checks the name, the staged file, Gate A (passed, for this family, not older than the file), " +
  "the recipe beside it (checks clean against the kit), the build record, the size, and that the package folder is a place it may write; " +
  "then plans <family_staging_root>\\_ReleasePackages\\<Role>\\<family>__<sha12> with copies of the family, recipe, gate and build files " +
  "and a manifest.json (sha256 of each file, the checks, where the pane will release it). dry_run defaults to true and writes nothing: " +
  "it returns the checks, files, manifest and plan_id. A real run is dry_run false with confirm true and that plan_id " +
  "(FMC-RP-DRY-RUN-FIRST otherwise) and only when no check fails. action verify re-hashes an existing package. It never publishes, " +
  "never moves the staged file, never writes to 04_Families\\<Role>, a library root, a Revit or Autodesk add-ins folder or a project, " +
  "and never loads a family: release stays a person's act in the pane (Families › Quality and release, the Family Librarian).";

export const FMC_RELEASE_PACKAGE_SHAPE = {
  action: z.enum(["prepare", "verify"]).optional().default("prepare"),
  family: z.string().optional().default("").describe("FMC_<Role>_<Token>_<Description>; the staged file is <family_staging_root>\\<Role>\\<family>.rfa"),
  file: z.string().optional().default("").describe("or the staged .rfa itself"),
  package_dir: z.string().optional().default("").describe("verify: the package folder (default: the family's newest package)"),
  note: z.string().optional().default("").describe("kept in the manifest for the Family Librarian"),
  dry_run: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false),
  plan_id: z.string().optional().default(""),
};

export type FmcReleasePackageArgs = { action?: "prepare" | "verify"; family?: string; file?: string; package_dir?: string; note?: string; dry_run?: boolean; confirm?: boolean; plan_id?: string };

export interface ReleaseToolIo { guard?: GuardConfig; dictionary?: Map<string, SpParam> | null; materials?: MaterialDb | null; now?: () => Date }

export const fsReleaseIo: ReleaseIo = {
  exists: (p) => fs.existsSync(p),
  stat: (p) => { try { const s = fs.statSync(p); return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null; } catch { return null; } },
  readText: (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } },
  sha256: (p) => { try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } catch { return null; } },
};

function log(cfg: GuardConfig, action: string, dryRun: boolean, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = win.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dryRun, target, result, detail]));
  } catch { /* logging never blocks the work */ }
}

function readKit(cfg: GuardConfig): { dictionary: Map<string, SpParam> | null; materials: MaterialDb | null } {
  let dictionary: Map<string, SpParam> | null = null, materials: MaterialDb | null = null;
  try { dictionary = parseSharedParameters(fs.readFileSync(expandEnv(cfg.shared_parameter_file), "utf8")); } catch { /* checked as a warning */ }
  try { materials = parseMaterialDb(JSON.parse(fs.readFileSync(expandEnv(cfg.materials_file), "utf8").replace(/^\uFEFF/, ""))); } catch { /* the recipe check says so */ }
  return { dictionary, materials };
}

/** The family's packages, newest first (by the manifest's prepared_at, else the folder's time). */
function packagesOf(cfg: GuardConfig, family: string): string[] {
  const root = win.join(expandEnv(cfg.family_staging_root), PACKAGES_FOLDER, roleOf(family) || "_Unsorted");
  try {
    return fs.readdirSync(root).filter((d) => d.startsWith(family + "__") && !d.endsWith(".partial")).map((d) => win.join(root, d))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch { return []; }
}

export async function runFmcReleasePackage(raw: FmcReleasePackageArgs, io: ReleaseToolIo = {}) {
  const args = { action: "prepare", family: "", file: "", package_dir: "", note: "", dry_run: true, confirm: false, plan_id: "", ...raw };
  const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig();
  if (!loaded.config) return reply({ code: "FMC-GUARD", error: loaded.problem ?? "fmc_guard.json isn't readable" }, true);
  const cfg = loaded.config;

  if (args.action === "verify") {
    const dir = args.package_dir.trim() || (args.family || args.file ? packagesOf(cfg, args.family.trim() || win.basename(args.file).replace(/\.rfa$/i, ""))[0] ?? "" : "");
    if (!dir) return reply({ code: "FMC-RP-NO-PACKAGE", error: "No package found: give package_dir, or a family that has one" }, true);
    const place = packagePlaceProblems(dir, win.basename(dir).split("__")[0], cfg);
    if (place.length) return reply({ code: "FMC-RP-PLACE", error: place.join("; ") }, true);
    return reply({ action: "verify", ...verifyPackage(dir, fsReleaseIo), read_only: true });
  }

  const kit = io.dictionary !== undefined ? { dictionary: io.dictionary, materials: io.materials ?? null } : readKit(cfg);
  const plan = planRelease({ family: args.family, file: args.file, note: args.note }, cfg, fsReleaseIo, kit);
  const summary = {
    family: plan.family, staged_file: plan.staged_file, package_dir: plan.package_dir, release_to: plan.release_to,
    ready: plan.ready, blockers: plan.blockers, warnings: plan.warnings, checks: plan.checks,
    files: plan.files.map((f) => ({ kind: f.kind, name: f.name, bytes: f.bytes, sha256: f.sha256 })), plan_id: plan.plan_id,
  };

  if (args.dry_run !== false) {
    log(cfg, "fmc_release_package", true, plan.package_dir || plan.staged_file, plan.ready ? "ready" : "blocked", plan.blockers.join(" | ").slice(0, 400));
    return reply({ dry_run: true, written: false, ...summary, manifest_preview: plan.manifest,
      next: plan.ready ? `To write the package: dry_run false, confirm true, plan_id "${plan.plan_id}". Release itself stays the Family Librarian's, in the pane.`
        : "Fix the blockers, then dry-run again." });
  }
  if (!args.confirm || args.plan_id !== plan.plan_id)
    return reply({ code: "FMC-RP-DRY-RUN-FIRST", error: "A package is written only with confirm true and the plan_id of a dry run of this same state (the files or checks changed, or no dry run yet)", ...summary }, true);
  if (!plan.ready) return reply({ code: "FMC-RP-BLOCKED", error: "Not release-ready", ...summary }, true);

  // every file the run writes passes the write guard, inside the package folder only
  const dir = plan.package_dir, partial = dir + ".partial";
  const targets = [...plan.files.map((f) => win.join(dir, f.name)), win.join(dir, "manifest.json")];
  const refused = targets.flatMap((t) => checkWritePath(t, cfg, { checkName: false }).reasons);
  if (refused.length) return reply({ code: "FMC-RP-PLACE", error: refused.join("; ") }, true);

  try {
    fs.mkdirSync(win.dirname(dir), { recursive: true });
    fs.mkdirSync(partial); // fails when an interrupted run left one: a person looks at it
  } catch (e) {
    return reply({ code: "FMC-RP-WRITE", error: `Couldn't make ${partial}: ${e instanceof Error ? e.message : e}` }, true);
  }
  try {
    for (const f of plan.files) {
      const to = win.join(partial, f.name);
      fs.copyFileSync(f.from, to, fs.constants.COPYFILE_EXCL);
      const h = fsReleaseIo.sha256(to);
      if (h !== f.sha256) throw new Error(`${f.name} changed while it was copied (sha256 ${h} ≠ ${f.sha256})`);
    }
    const now = (io.now ?? (() => new Date()))();
    const manifest = { ...plan.manifest, prepared_at: now.toISOString(), package_dir: dir };
    fs.writeFileSync(win.join(partial, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    if (fs.existsSync(dir)) throw new Error(`${dir} appeared while the package was written`);
    fs.renameSync(partial, dir);
    log(cfg, "fmc_release_package", false, dir, "prepared", `${plan.family} ${plan.files.length} files plan ${plan.plan_id}`);
    return reply({ dry_run: false, written: true, ...summary, manifest: win.join(dir, "manifest.json"), verify: verifyPackage(dir, fsReleaseIo),
      next: "Release stays a person's act: the Family Librarian releases the staged family in the pane (Families › Quality and release) with a reviewer and a note." });
  } catch (e) {
    log(cfg, "fmc_release_package", false, partial, "failed", e instanceof Error ? e.message : String(e));
    return reply({ code: "FMC-RP-WRITE", error: `${e instanceof Error ? e.message : e}. The incomplete copy is left at ${partial} for a person to look at; the staged family is untouched.` }, true);
  }
}

export function registerFmcReleasePackageTool(server: McpServer) {
  server.tool("fmc_release_package", FMC_RELEASE_PACKAGE_DESCRIPTION, FMC_RELEASE_PACKAGE_SHAPE, (args) => runFmcReleasePackage(args as FmcReleasePackageArgs));
}
