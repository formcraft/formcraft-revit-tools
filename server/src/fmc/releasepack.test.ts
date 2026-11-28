// Release step (L001 build plan item 3): staging → a validated, release-READY package + manifest. Never publishes.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RELEASE_SCHEMA, namesHash, packageDir, packagePlaceProblems, planRelease, verifyPackage, type ReleaseIo } from "./releasepack.js";
import { expandSkeletons } from "./ops.js";
import type { GuardConfig } from "./policy.js";

const KIT = "D:\\Kit\\04_Families";
const STAGING = KIT + "\\_Staging";
const FAMILY = "FMC_E_EQ_Generator_Test";
const RFA = `${STAGING}\\E\\${FAMILY}.rfa`;
const cfg = { family_staging_root: STAGING, write_roots: [STAGING], blocked_segments: ["02_Shared", "03_Published", "04_Archive", "05_Incoming"], library_roots: ["D:\\Kit\\Library"] } as unknown as GuardConfig;

const recipeOps = [
  { op: "add_ref_plane", name: "Left", from: [-500, -900], to: [-500, 900] }, { op: "add_ref_plane", name: "Right", from: [500, -900], to: [500, 900] },
  { op: "add_ref_plane", name: "Front", from: [-900, -300], to: [900, -300] }, { op: "add_ref_plane", name: "Back", from: [-900, 300], to: [900, 300] },
  { op: "extrusion", name: "Body", rect: ["Left", "Right", "Front", "Back"], start: 0, end: 1000 },
];
const recipe = { schema: "fmc-recipe/0.1", family: FAMILY, template: "Metric Generic Model.rft", ops: recipeOps };

function memIo(files: Record<string, { text: string; mtimeMs?: number }>): ReleaseIo & { files: typeof files } {
  const key = (p: string) => path.win32.normalize(p).toLowerCase();
  const m = new Map(Object.entries(files).map(([k, v]) => [key(k), v]));
  return {
    files,
    exists: (p) => m.has(key(p)) || [...m.keys()].some((k) => k.startsWith(key(p) + "\\")),
    stat: (p) => { const f = m.get(key(p)); return f ? { size: Buffer.byteLength(f.text), mtimeMs: f.mtimeMs ?? 1000 } : null; },
    readText: (p) => m.get(key(p))?.text ?? null,
    sha256: (p) => { const f = m.get(key(p)); return f ? crypto.createHash("sha256").update(f.text).digest("hex") : null; },
  };
}
const stem = RFA.replace(/\.rfa$/, "");
const good = (over: Record<string, { text: string; mtimeMs?: number } | undefined> = {}) => {
  const base: Record<string, { text: string; mtimeMs?: number }> = {
    [RFA]: { text: "rfa bytes", mtimeMs: Date.parse("2026-11-28T08:00:00Z") },
    [stem + ".gate.json"]: { text: JSON.stringify({ family: FAMILY, at: "2026-11-28T08:05:00Z", verdict: "Pass", lines: [{ check: "Flex", state: "Pass" }, { check: "Likeness", state: "Not checked" }] }) },
    [stem + ".recipe.json"]: { text: JSON.stringify(recipe) },
    [stem + ".build.json"]: { text: JSON.stringify({ saved_at: "2026-11-28T08:00:00Z", plugin: "abc1234", kit: "FMC_Kit 2.2", ops_hash: namesHash(expandSkeletons(recipeOps as any) as any) }) },
    [`${STAGING}\\E\\_Images\\${FAMILY}.png`]: { text: "png" },
  };
  for (const [k, v] of Object.entries(over)) { if (v === undefined) delete base[k]; else base[k] = v; }
  return memIo(base);
};
const state = (p: ReturnType<typeof planRelease>, id: string) => p.checks.find((c) => c.id === id)?.state;

test("a gated, clean, staged family plans a ready package under _ReleasePackages with a manifest that doesn't publish", () => {
  const io = good();
  const p = planRelease({ family: FAMILY, note: "for review" }, cfg, io, { dictionary: new Map() });
  assert.deepEqual(p.blockers, []);
  assert.equal(p.ready, true);
  const sha = io.sha256(RFA)!;
  assert.equal(p.package_dir, `${STAGING}\\_ReleasePackages\\E\\${FAMILY}__${sha.slice(0, 12)}`);
  assert.equal(p.package_dir, packageDir(STAGING, FAMILY, sha));
  assert.equal(p.release_to, `${KIT}\\E\\${FAMILY}.rfa`);
  assert.deepEqual(p.files.map((f) => f.kind), ["family", "gate", "recipe", "build", "type_image"]);
  for (const id of ["RP-01", "RP-02", "RP-03", "RP-04", "RP-05", "RP-06", "RP-07", "RP-08", "RP-09"]) assert.equal(state(p, id), "Pass", id + " " + JSON.stringify(p.checks));
  assert.equal(state(p, "RP-03b"), "Warn");
  const m = p.manifest as any;
  assert.equal(m.schema, RELEASE_SCHEMA);
  assert.equal(m.published, false); assert.equal(m.installed, false); assert.equal(m.state, "prepared");
  assert.match(m.next_step, /person releases it in the pane/);
  assert.equal(m.note, "for review");
  assert.equal(m.staged_file.sha256, sha);
  // the plan_id changes when a file changes (a confirmed run is the run the person saw)
  const p2 = planRelease({ family: FAMILY }, cfg, good({ [stem + ".recipe.json"]: { text: JSON.stringify({ ...recipe, values: {} }) } }), { dictionary: new Map() });
  assert.notEqual(p2.plan_id, p.plan_id);
  assert.equal(planRelease({ family: FAMILY, note: "other" }, cfg, io, { dictionary: new Map() }).plan_id, p.plan_id);
});

test("blockers: no gate, a failed or stale gate, another family's gate, a recipe with errors, a backup, a wrong folder, a project name", () => {
  const blocked = (io: ReleaseIo, input: { family?: string; file?: string } = { family: FAMILY }) => planRelease(input, cfg, io, { dictionary: new Map() });
  assert.equal(state(blocked(good({ [stem + ".gate.json"]: undefined })), "RP-03"), "Fail");
  assert.equal(state(blocked(good({ [stem + ".gate.json"]: { text: JSON.stringify({ family: FAMILY, at: "2026-11-28T09:00:00Z", verdict: "Fail", lines: [{ check: "Flex", state: "Fail" }] }) } })), "RP-03"), "Fail");
  const stale = blocked(good({ [stem + ".gate.json"]: { text: JSON.stringify({ family: FAMILY, at: "2026-11-28T07:00:00Z", verdict: "Pass", lines: [] }) } }));
  assert.match(stale.checks.find((c) => c.id === "RP-03")!.detail, /stale/);
  assert.equal(state(blocked(good({ [stem + ".gate.json"]: { text: JSON.stringify({ family: "FMC_E_Other", at: "2026-11-28T09:00:00Z", verdict: "Pass" }) } })), "RP-03"), "Fail");
  const badRecipe = blocked(good({ [stem + ".recipe.json"]: { text: JSON.stringify({ ...recipe, ops: [...recipeOps, { op: "extrusion", name: "Bad", start: 0, end: 100 }] }) } }));
  assert.equal(state(badRecipe, "RP-04"), "Fail");
  assert.equal(badRecipe.ready, false);
  assert.equal(state(blocked(good({ [stem + ".recipe.json"]: { text: JSON.stringify({ ...recipe, family: "FMC_E_Other" }) } })), "RP-04"), "Fail");
  const backup = `${STAGING}\\E\\${FAMILY}.0001.rfa`;
  assert.equal(state(blocked(good({ [backup]: { text: "old" } }), { file: backup }), "RP-02"), "Fail");
  const elsewhere = `D:\\Kit\\04_Families\\_Staging\\A\\${FAMILY}.rfa`;
  assert.equal(state(blocked(good({ [elsewhere]: { text: "x" } }), { file: elsewhere }), "RP-02"), "Fail");
  assert.equal(state(blocked(good(), { family: "HEBERT_E_X_Y" }), "RP-01"), "Fail");
  assert.equal(state(blocked(good({ [RFA]: undefined })), "RP-02"), "Fail");
});

test("warnings don't block: pending values, no recipe, a build record from other ops, a released version already there", () => {
  const p = planRelease({ family: FAMILY }, cfg, good({
    [stem + ".build.json"]: { text: JSON.stringify({ ops_hash: "0000", saved_at: "x" }) },
    [`${KIT}\\E\\${FAMILY}.rfa`]: { text: "released v1" },
    [stem + ".recipe.json"]: { text: JSON.stringify({ ...recipe, values: { Width: { value: 1, source_status: "pending" } } }) },
  }), { dictionary: new Map() });
  assert.equal(state(p, "RP-05"), "Warn"); assert.equal(state(p, "RP-06"), "Warn"); assert.equal(state(p, "RP-04b"), "Warn");
  assert.equal(p.ready, true, p.blockers.join("\n"));
  const noRecipe = planRelease({ family: FAMILY }, cfg, good({ [stem + ".recipe.json"]: undefined }), { dictionary: new Map() });
  assert.equal(state(noRecipe, "RP-04"), "Warn");
  const noKit = planRelease({ family: FAMILY }, cfg, good(), { dictionary: null });
  assert.equal(state(noKit, "RP-04"), "Warn");
});

test("an existing package is never overwritten; a left .partial blocks", () => {
  const io0 = good();
  const dir = planRelease({ family: FAMILY }, cfg, io0, { dictionary: new Map() }).package_dir;
  const done = planRelease({ family: FAMILY }, cfg, good({ [dir + "\\manifest.json"]: { text: JSON.stringify({ schema: RELEASE_SCHEMA, prepared_at: "t" }) } }), { dictionary: new Map() });
  assert.equal(state(done, "RP-08"), "Warn"); assert.equal(done.ready, false);
  const partial = planRelease({ family: FAMILY }, cfg, good({ [dir + ".partial\\x.rfa"]: { text: "x" } }), { dictionary: new Map() });
  assert.equal(state(partial, "RP-08"), "Fail");
});

test("package place: never the library (04_Families\\<Role>), a library root, a CDE gate folder, Revit add-ins or a project", () => {
  assert.deepEqual(packagePlaceProblems(`${STAGING}\\_ReleasePackages\\E\\${FAMILY}__abc`, FAMILY, cfg), []);
  assert.ok(packagePlaceProblems(`${KIT}\\E\\pkg`, FAMILY, { ...cfg, write_roots: [KIT] } as GuardConfig).some((p) => /library folder/.test(p)));
  assert.ok(packagePlaceProblems("D:\\Kit\\Library\\pkg", FAMILY, { ...cfg, write_roots: ["D:\\Kit"], family_staging_root: "D:\\Kit" } as GuardConfig).some((p) => /library root/.test(p)));
  assert.ok(packagePlaceProblems(`${STAGING}\\03_Published\\pkg`, FAMILY, cfg).length > 0);
  assert.ok(packagePlaceProblems(`${STAGING}\\Autodesk\\Revit\\Addins\\2025\\pkg`, FAMILY, cfg).some((p) => /add-ins/.test(p)));
  assert.ok(packagePlaceProblems("C:\\ProgramData\\Autodesk\\Revit\\Addins\\2025\\pkg", FAMILY, cfg).length > 0);
  assert.ok(packagePlaceProblems(`${STAGING}\\HEBERT HOSTELS\\pkg`, FAMILY, cfg).some((p) => /project/.test(p)));
});

test("verifyPackage re-hashes the package and the staged family", () => {
  const dir = `${STAGING}\\_ReleasePackages\\E\\${FAMILY}__x`;
  const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
  const manifest = { schema: RELEASE_SCHEMA, staged_file: { path: RFA, sha256: sha("rfa bytes") }, files: [{ name: `${FAMILY}.rfa`, sha256: sha("rfa bytes") }] };
  const ok = verifyPackage(dir, good({ [dir + "\\manifest.json"]: { text: JSON.stringify(manifest) }, [`${dir}\\${FAMILY}.rfa`]: { text: "rfa bytes" } }));
  assert.equal(ok.ok, true); assert.equal(ok.staged_unchanged, true);
  const changed = verifyPackage(dir, good({ [RFA]: { text: "rebuilt" }, [dir + "\\manifest.json"]: { text: JSON.stringify(manifest) }, [`${dir}\\${FAMILY}.rfa`]: { text: "tampered" } }));
  assert.equal(changed.ok, false); assert.equal(changed.staged_unchanged, false);
  assert.equal(verifyPackage(dir, good()).manifest_found, false);
});

// the tool on a real folder (Windows paths: the kit lives on Windows)
test("fmc_release_package: dry run writes nothing; a confirmed run copies, hashes, writes the manifest and leaves the staged family", { skip: process.platform !== "win32" }, async () => {
  const { runFmcReleasePackage } = await import("../tools/fmc_release_package.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-rp-"));
  const staging = path.join(root, "04_Families", "_Staging");
  fs.mkdirSync(path.join(staging, "E"), { recursive: true });
  const rfa = path.join(staging, "E", FAMILY + ".rfa");
  fs.writeFileSync(rfa, "rfa bytes");
  const st = fs.statSync(rfa);
  fs.writeFileSync(rfa.replace(/\.rfa$/, ".gate.json"), JSON.stringify({ family: FAMILY, at: new Date(st.mtimeMs + 5000).toISOString(), verdict: "Pass", lines: [] }));
  fs.writeFileSync(rfa.replace(/\.rfa$/, ".recipe.json"), JSON.stringify(recipe));
  const guard = { family_staging_root: staging, write_roots: [staging], blocked_segments: ["03_Published"], library_roots: [], reports_dir: path.join(root, "reports") } as unknown as GuardConfig;
  const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
  const io = { guard, dictionary: new Map(), materials: null };

  const dry = await runFmcReleasePackage({ family: FAMILY }, io);
  const d = body(dry);
  assert.equal(dry.isError, false); assert.equal(d.dry_run, true); assert.equal(d.ready, true, JSON.stringify(d.blockers));
  assert.equal(fs.existsSync(path.join(staging, "_ReleasePackages")), false);

  const noPlan = await runFmcReleasePackage({ family: FAMILY, dry_run: false, confirm: true, plan_id: "rp-wrong" }, io);
  assert.equal(body(noPlan).code, "FMC-RP-DRY-RUN-FIRST");

  const real = await runFmcReleasePackage({ family: FAMILY, dry_run: false, confirm: true, plan_id: d.plan_id }, io);
  const r = body(real);
  assert.equal(real.isError, false, JSON.stringify(r));
  assert.equal(r.written, true); assert.equal(r.verify.ok, true);
  assert.ok(fs.existsSync(rfa), "the staged family stays where it is");
  assert.ok(!fs.existsSync(path.join(root, "04_Families", "E", FAMILY + ".rfa")), "nothing is released");
  const m = JSON.parse(fs.readFileSync(r.manifest, "utf8"));
  assert.equal(m.published, false); assert.equal(m.files.length, 3);
  assert.ok(fs.readFileSync(path.join(root, "reports", "FMC_MCP_FileLog.csv"), "utf8").includes("prepared"));

  const again = body(await runFmcReleasePackage({ family: FAMILY }, io));
  assert.equal(again.ready, false);
  const v = body(await runFmcReleasePackage({ action: "verify", family: FAMILY }, io));
  assert.equal(v.ok, true);
});

test("fmc_release_package registers with the other tools", async () => {
  const { registerTools } = await import("../tools/register.js");
  const names: string[] = [];
  const report = await registerTools({ tool: (name: string) => { names.push(name); } } as any);
  assert.deepEqual(report.failed, []);
  assert.ok(names.includes("fmc_release_package"));
});
