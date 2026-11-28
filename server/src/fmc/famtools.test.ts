// FE-01 to FE-05: the family editor tools (fmc_fam_template, fmc_fam_form, fmc_fam_2d, fmc_fam_light, fmc_fam_annotation).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, GuardConfig } from "./policy.js";
import { SpParam } from "./specs.js";
import {
  FamIo, annotationOps, auditTemplate, checkOps, famRun, famSave, famSaveProblems, formOps, lightOps, listTemplates, loftOps, replacePlan,
  templateCreateOps, twoDOps,
} from "./famtools.js";
import { runFmcFamForm } from "../tools/fmc_fam_form.js";
import { runFmcFam2d } from "../tools/fmc_fam_2d.js";
import { runFmcFamLight } from "../tools/fmc_fam_light.js";
import { runFmcFamAnnotation } from "../tools/fmc_fam_annotation.js";
import { runFmcFamTemplate } from "../tools/fmc_fam_template.js";

const STAGING = "D:\\Kit\\04_Families\\_Staging";
const TPL = "C:\\ProgramData\\Autodesk\\RVT 2025\\Family Templates";
const cfg: GuardConfig = {
  ...DEFAULT_CONFIG,
  template_roots: [TPL, "D:\\Kit\\06_Templates"],
  family_template_dir: TPL + "\\English",
  library_roots: [STAGING],
  write_roots: [STAGING, "D:\\Kit\\04_Families\\_ChainTests"],
  family_staging_root: STAGING,
};
const dictionary = new Map<string, SpParam>([
  ["FMC_Mark", { name: "FMC_Mark", guid: "11111111-1111-1111-1111-111111111111", datatype: "TEXT", group: "Identity" }],
  ["FMC_Sheet_Checker", { name: "FMC_Sheet_Checker", guid: "22222222-2222-2222-2222-222222222222", datatype: "TEXT", group: "Identity" }],
]);
const SQ = [[0, 0], [100, 0], [100, 100], [0, 100]];
const TARGET = STAGING + "\\FMC_P_EQ_WaterHeater.rfa";

function fakeIo(files: string[] = [], over: Partial<FamIo> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  const set = new Set(files.map((f) => f.toLowerCase()));
  const io: FamIo = {
    config: cfg, dictionary,
    doc: async (a) => {
      calls.push(a); events.push(`doc:${a.action}`);
      if (a.action === "open") return { body: { session: "S1" }, isError: false };
      if (a.action === "apply") return { body: { ops: [], created: 1, dry_run: a.dry_run }, isError: false };
      if (a.action === "save") { set.add(String(a.path).toLowerCase()); return { body: { saved: a.path }, isError: false }; }
      return { body: {}, isError: false };
    },
    exists: (p) => set.has(p.toLowerCase()),
    readdir: (d) => [...set].filter((f) => f.startsWith(d.toLowerCase() + "\\") && !f.slice(d.length + 1).includes("\\")).map((f) => files.find((x) => x.toLowerCase() === f)?.split("\\").pop() ?? f.split("\\").pop()!),
    rename: (a, b) => { events.push(`move:${a.split("\\").pop()}->${b}`); set.delete(a.toLowerCase()); set.add(b.toLowerCase()); },
    mkdir: (d) => { events.push(`mkdir:${d}`); },
    now: () => new Date(2026, 10, 28, 14, 5, 9),
    ...over,
  };
  return { io, calls, events };
}
const body = (r: { content: Array<{ text: string }>; isError: boolean }) => ({ ...JSON.parse(r.content[0].text), isError: r.isError });

// ---------- the new fmc_doc ops ----------

test("new ops pass the fmc_doc checks: swept blends, regions, detail lines, text, light source", () => {
  const r = checkOps([
    { op: "swept_blend", name: "Neck", path: [[0, 0, 0], [0, 0, 300]], bottom: SQ, top: [[0, 0], [50, 0], [50, 50], [0, 50]] },
    { op: "void_swept_blend", name: "Neck cut", path: [[0, 0, 0], [200, 0, 0]], bottom: SQ, top: SQ },
    { op: "masking_region", name: "Mask", points: SQ },
    { op: "filled_region", name: "Fill", view: "front", points: SQ, region_type: "Solid Black" },
    { op: "detail_lines", name: "Frame", view: "annotation", points: [[0, 0], [10, 0], [10, 5]], closed: true },
    { op: "text_note", name: "Title", text: "DOOR", at: [0, 0] },
  ], { config: cfg, dictionary });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ops.length, 6);
  assert.equal((r.ops[2] as { view: string }).view, "plan", "a region defaults to plan");
  assert.equal((r.ops[5] as { view: string }).view, "annotation", "text defaults to the annotation view");
});

test("op checks refuse a zero path, a bad spot, a light in the wrong category and control characters", () => {
  const e = (ops: unknown[]) => checkOps(ops, { config: cfg, dictionary }).errors;
  assert.ok(e([{ op: "swept_blend", name: "N", path: [[0, 0, 0], [0, 0, 0]], bottom: SQ, top: SQ }]).length > 0);
  assert.ok(e([{ op: "light_source", name: "L", distribution: "spot", lumens: 800, beam_deg: 60, field_deg: 40 }]).length > 0);
  assert.ok(e([{ op: "light_source", name: "L", distribution: "hemispherical", lumens: 800, beam_deg: 60 }]).length > 0);
  assert.ok(e([{ op: "light_source", name: "L", kelvin: 3000 }]).length > 0, "needs lumens");
  assert.ok(e([{ op: "set_category", name: "Generic Models" }, { op: "light_source", name: "L", lumens: 800 }]).length > 0);
  assert.ok(e([{ op: "text_note", name: "T", text: "a\u0007b", at: [0, 0] }]).length > 0);
  assert.ok(e([{ op: "swept_blend", name: "A", path: [[0, 0, 0], [0, 0, 1]], bottom: SQ, top: SQ }, { op: "swept_blend", name: "A", path: [[0, 0, 0], [0, 0, 1]], bottom: SQ, top: SQ }]).length > 0, "names are unique");
});

// ---------- FE-02 form ----------

test("a loft is one blend per pair of sections, bottom to top", () => {
  const l = loftOps({ op: "loft", name: "Shade", sections: [{ z: 0, outline: SQ }, { z: 100, outline: SQ }, { z: 250, outline: [[0, 0], [10, 0], [10, 10]] }] });
  assert.deepEqual(l.problems, []);
  assert.deepEqual(l.ops.map((o) => [o.name, o.start, o.end]), [["Shade 1", 0, 100], ["Shade 2", 100, 250]]);
  assert.equal(loftOps({ op: "loft", name: "One", sections: [{ z: 0, outline: SQ }, { z: 5, outline: SQ }] }).ops[0].name, "One");
  assert.ok(loftOps({ op: "loft", name: "Bad", sections: [{ z: 10, outline: SQ }, { z: 10, outline: SQ }] }).problems.length > 0);
});

test("fmc_fam_form takes form ops only and checks them like fmc_doc apply", async () => {
  assert.ok(formOps([{ op: "add_type", name: "X" }]).problems[0].includes("isn't a form op"));
  const { io, calls } = fakeIo();
  const r = body(await runFmcFamForm({ session: "", template: "", dry_run: true, save_path: "", overwrite: false,
    forms: [{ op: "loft", name: "Shade", sections: [{ z: 0, outline: SQ }, { z: 100, outline: SQ }, { z: 200, outline: SQ }] },
      { op: "swept_blend", name: "Neck", path: [[0, 0, 200], [0, 0, 400]], bottom: SQ, top: SQ }] }, io));
  assert.equal(r.isError, false);
  assert.deepEqual(r.planned_ops.map((o: { op: string }) => o.op), ["blend", "blend", "swept_blend"]);
  assert.equal(calls.length, 0, "no session: nothing is sent to Revit");
  const bad = body(await runFmcFamForm({ session: "S1", template: "", dry_run: true, save_path: "", overwrite: false,
    forms: [{ op: "swept_blend", name: "Neck", path: [[0, 0]], bottom: SQ, top: SQ }] }, io));
  assert.equal(bad.isError, true);
  assert.equal(calls.length, 0);
});

// ---------- dry run, session, save, archive-before-replace ----------

test("dry run by default; a real run needs a session or a template", async () => {
  const { io, calls } = fakeIo();
  const ops = [{ op: "masking_region", name: "Mask", points: SQ }];
  const plan = await famRun("t", { ops }, { session: "", template: "", dry_run: true, save_path: "", overwrite: false }, io);
  assert.equal(plan.dry_run, true);
  assert.ok(Array.isArray(plan.planned_ops));
  const refused = await famRun("t", { ops }, { session: "", template: "", dry_run: false, save_path: "", overwrite: false }, io);
  assert.equal(refused.refused, true);
  const r = await famRun("t", { ops }, { session: "S9", template: "", dry_run: true, save_path: TARGET, overwrite: false }, io);
  assert.equal(r.refused, undefined);
  assert.deepEqual(calls.map((c) => [c.action, c.session, c.dry_run]), [["apply", "S9", true]], "a dry run never saves");
});

test("a template opens a new family first, only from the template roots", async () => {
  const { io, calls } = fakeIo();
  const ops = [{ op: "set_category", name: "Generic Annotations" }];
  const r = await famRun("t", { ops }, { session: "", template: TPL + "\\English\\Metric Generic Annotation.rft", dry_run: true, save_path: "", overwrite: false }, io);
  assert.equal(r.session, "S1");
  assert.deepEqual(calls.map((c) => c.action), ["open", "apply"]);
  const out = await famRun("t", { ops }, { session: "", template: "C:\\Temp\\X.rft", dry_run: true, save_path: "", overwrite: false }, io);
  assert.equal(out.refused, true);
  assert.equal(calls.length, 2);
});

test("saves go into the family staging root only", () => {
  assert.deepEqual(famSaveProblems(TARGET, cfg), []);
  assert.ok(famSaveProblems("D:\\Kit\\04_Families\\_ChainTests\\FMC_P_EQ_WaterHeater.rfa", cfg).some((p) => /staging root/.test(p)));
  assert.ok(famSaveProblems("D:\\Projects\\A\\FMC_P_EQ_WaterHeater.rfa", cfg).length > 0);
  assert.ok(famSaveProblems(STAGING + "\\FMC_P_EQ_WaterHeater.rvt", cfg).length > 0);
});

test("a real run saves a new file without archiving", async () => {
  const { io, calls, events } = fakeIo();
  const r = await famRun("t", { ops: [{ op: "masking_region", name: "Mask", points: SQ }] },
    { session: "S1", template: "", dry_run: false, save_path: TARGET, overwrite: false }, io);
  assert.deepEqual(calls.map((c) => c.action), ["apply", "save"]);
  assert.equal(calls[1].overwrite, false);
  assert.deepEqual((r.saved as { archived: unknown[] }).archived, []);
  assert.ok(!events.some((e) => e.startsWith("move:")));
});

test("an existing .rfa is refused without overwrite, before anything runs", async () => {
  const { io, calls } = fakeIo([TARGET]);
  const r = await famRun("t", { ops: [{ op: "masking_region", name: "Mask", points: SQ }] },
    { session: "S1", template: "", dry_run: false, save_path: TARGET, overwrite: false }, io);
  assert.equal(r.refused, true);
  assert.equal(calls.length, 0);
});

test("archive-before-replace: the file, its backups and its build report go to _Archive before the save", async () => {
  const files = [TARGET, STAGING + "\\FMC_P_EQ_WaterHeater.0001.rfa", STAGING + "\\FMC_P_EQ_WaterHeater.build.json", STAGING + "\\Other.rfa"];
  const { io, calls, events } = fakeIo(files);
  const s = await famSave("S1", TARGET, true, io);
  const moves = events.filter((e) => e.startsWith("move:"));
  assert.equal(moves.length, 3);
  assert.ok(moves.every((m) => m.includes("\\_Archive\\20261128-140509_")));
  assert.ok(events.indexOf("doc:save") > events.lastIndexOf(moves[2]), "archived first, saved after");
  assert.equal(calls[0].overwrite, false, "fmc_doc save never overwrites: the old file is already archived");
  assert.equal((s.archived as unknown[]).length, 3);
  assert.ok(!events.some((e) => e.includes("Other.rfa")));
});

test("replacePlan names the build report like archivePlan names the file", () => {
  const m = replacePlan(TARGET, ["FMC_P_EQ_WaterHeater.rfa", "FMC_P_EQ_WaterHeater.build.json"], new Date(2026, 10, 28, 9, 0, 0));
  assert.deepEqual(m.map((x) => x[1]), [STAGING + "\\_Archive\\20261128-090000_FMC_P_EQ_WaterHeater.rfa", STAGING + "\\_Archive\\20261128-090000_FMC_P_EQ_WaterHeater.build.json"]);
});

// ---------- FE-03 2d ----------

test("fmc_fam_2d: regions, detail lines and symbolic lines; anything else refused", async () => {
  assert.ok(twoDOps([{ op: "extrusion" }]).problems.length > 0);
  const { io } = fakeIo();
  const r = body(await runFmcFam2d({ session: "", template: "", dry_run: true, save_path: "", overwrite: false,
    items: [{ op: "masking_region", name: "Mask", points: SQ }, { op: "filled_region", name: "Fill", points: SQ },
      { op: "symbolic_lines", name: "Swing", view: "plan", subcategory: "Swing", points: [[0, 0], [100, 100]] }] }, io));
  assert.equal(r.isError, false);
  assert.deepEqual(r.planned_ops.map((o: { op: string }) => o.op), ["masking_region", "filled_region", "symbolic_lines"]);
});

// ---------- FE-04 light ----------

test("fmc_fam_light sets Lighting Fixtures first, then the light source", async () => {
  assert.deepEqual(lightOps({ lumens: 800 }).map((o) => o.op), ["set_category", "light_source"]);
  assert.deepEqual(lightOps({ lumens: 800, ensure_category: false }).map((o) => o.op), ["light_source"]);
  const { io } = fakeIo();
  const r = body(await runFmcFamLight({ session: "", template: "", dry_run: true, save_path: "", overwrite: false, name: "Light source",
    shape: "circle", distribution: "spot", lumens_by_type: { "600": 1200, "1200": 2400 }, kelvin: 4000, beam_deg: 40, field_deg: 60, ensure_category: true }, io));
  assert.equal(r.isError, false);
  assert.deepEqual(r.planned_ops[1], { op: "light_source", name: "Light source", shape: "circle", distribution: "spot",
    lumens_by_type: { "600": 1200, "1200": 2400 }, kelvin: 4000, beam_deg: 40, field_deg: 60 });
  const bad = body(await runFmcFamLight({ session: "", template: "", dry_run: true, save_path: "", overwrite: false, name: "L",
    shape: "point", distribution: "spot", lumens: 800, kelvin: 3000, beam_deg: 70, field_deg: 50, ensure_category: true }, io));
  assert.equal(bad.isError, true);
});

// ---------- FE-05 annotation ----------

test("fmc_fam_annotation: a tag needs a tag category; its labels are listed, not added", () => {
  assert.ok(annotationOps({ kind: "tag" }, dictionary).problems.length > 0);
  assert.ok(annotationOps({ kind: "tag", tag_category: "Doors" }, dictionary).problems.length > 0);
  const t = annotationOps({ kind: "tag", tag_category: "Door Tags", label_params: ["FMC_Mark", "Type Mark"] }, dictionary);
  assert.deepEqual(t.problems, []);
  assert.deepEqual(t.ops, [{ op: "set_category", name: "Door Tags" }]);
  assert.deepEqual(t.label_plan.map((l) => [l.param, l.in_dictionary, l.added]), [["FMC_Mark", true, false], ["Type Mark", false, false]]);
});

test("fmc_fam_annotation: a title block gets its kit label parameters and draws in its view", async () => {
  const a = annotationOps({ kind: "title_block", label_params: ["FMC_Sheet_Checker"],
    draw: [{ op: "detail_lines", name: "Border", points: [[0, 0], [841, 0], [841, 594], [0, 594]], closed: true }] }, dictionary);
  assert.deepEqual(a.ops.map((o) => o.op), ["set_category", "add_shared_param", "detail_lines"]);
  assert.equal(a.ops[0].name, "Title Blocks");
  assert.equal(a.ops[1].guid, "22222222-2222-2222-2222-222222222222");
  assert.equal(a.ops[2].view, "annotation");
  assert.ok(annotationOps({ kind: "annotation", draw: [{ op: "extrusion" }] }, dictionary).problems.length > 0);
  const { io } = fakeIo();
  const r = body(await runFmcFamAnnotation({ session: "", template: "", dry_run: true, save_path: "", overwrite: false, kind: "annotation",
    label_params: ["FMC_Mark"], draw: [{ op: "text_note", name: "Note", text: "SEE SPEC", at: [0, 0] }, { op: "masking_region", name: "Mask", points: SQ }] }, io));
  assert.equal(r.isError, false);
  assert.equal(r.label_plan[0].added, true);
  assert.deepEqual(r.planned_ops.map((o: { op: string }) => o.op), ["set_category", "add_shared_param", "text_note", "masking_region"]);
});

// ---------- FE-01 template ----------

test("fmc_fam_template list and audit are read-only", async () => {
  const files = [TPL + "\\English\\Metric Generic Model.rft", TPL + "\\English\\Annotations\\Metric Generic Tag.rft", "D:\\Kit\\06_Templates\\FMC_Furniture.rft", "D:\\Kit\\06_Templates\\FMC_Project.rte"];
  const { io, calls } = fakeIo(files, {
    readdir: (d) => {
      const kids = new Set<string>();
      for (const f of files) if (f.toLowerCase().startsWith(d.toLowerCase() + "\\")) kids.add(f.slice(d.length + 1).split("\\")[0]);
      return [...kids];
    },
  });
  const l = listTemplates(cfg, io);
  assert.deepEqual(l.map((t) => [t.path.split("\\").pop(), t.formcraft]), [
    ["Metric Generic Tag.rft", false], ["Metric Generic Model.rft", false], ["FMC_Furniture.rft", true]]);
  assert.equal(auditTemplate("D:\\Kit\\06_Templates\\FMC_Furniture.rft", cfg, io).ok, true);
  assert.equal(auditTemplate("D:\\Kit\\06_Templates\\FMC_Project.rte", cfg, io).ok, false);
  assert.equal(auditTemplate("C:\\Temp\\FMC_X.rft", cfg, io).ok, false);
  const r = body(await runFmcFamTemplate({ action: "list", session: "", template: "", dry_run: true, save_path: "", overwrite: false }, io));
  assert.equal(r.count, 3);
  assert.equal(calls.length, 0);
});

test("fmc_fam_template create: category, standard planes and kit parameters in a new family", async () => {
  const c = templateCreateOps({ category: "Furniture", width: { param: "Width", mm: 600 }, depth: { param: "Depth", mm: 400 }, height: { param: "Height", mm: 750 },
    shared_params: ["FMC_Mark", "Nope"], instance_params: ["FMC_Mark"] }, dictionary);
  assert.deepEqual(c.ops.map((o) => o.op), ["set_category", "skeleton", "add_shared_param"]);
  assert.equal(c.ops[2].instance, true);
  assert.deepEqual(c.missing, ["Nope"]);
  assert.ok(templateCreateOps({ width: { param: "Width", mm: 600 } }, dictionary).notes[0].includes("together"));
  const rft = "D:\\Kit\\06_Templates\\FMC_Furniture.rft";
  const { io, calls } = fakeIo([rft]);
  const r = body(await runFmcFamTemplate({ action: "create", session: "", template: rft, dry_run: true, save_path: "", overwrite: false,
    category: "Furniture", width: { param: "Width", mm: 600 }, depth: { param: "Depth", mm: 400 }, height: { param: "Height", mm: 750 } }, io));
  assert.equal(r.isError, false);
  assert.deepEqual(calls.map((c) => [c.action, c.dry_run]), [["open", undefined], ["apply", true]]);
  const s = body(await runFmcFamTemplate({ action: "create", session: "S1", template: rft, dry_run: true, save_path: "", overwrite: false }, io));
  assert.equal(s.isError, true);
});

test("each family tool module registers exactly one tool", async () => {
  for (const m of ["fmc_fam_template", "fmc_fam_form", "fmc_fam_2d", "fmc_fam_light", "fmc_fam_annotation"]) {
    const mod = await import(`../tools/${m}.js`);
    const reg = Object.keys(mod).filter((k) => /^register.+Tool$/.test(k));
    assert.equal(reg.length, 1, m);
    const seen: string[] = [];
    mod[reg[0]]({ tool: (name: string) => { seen.push(name); } });
    assert.deepEqual(seen, [m]);
  }
});

test("fmc_fam_template inspect opens, reports and always closes, never saves or applies", async () => {
  const rft = "D:\\Kit\\06_Templates\\FMC_Furniture.rft";
  const { io, calls } = fakeIo([rft]);
  const r = body(await runFmcFamTemplate({ action: "inspect", session: "", template: rft, dry_run: true, save_path: "", overwrite: false }, io));
  assert.equal(r.isError, false);
  assert.equal(r.session_closed, "S1");
  assert.deepEqual(calls.map((c) => c.action), ["open", "report", "close"]);
  const failing = fakeIo([rft], { doc: async (a) => { calls.push(a); if (a.action === "open") return { body: { session: "S2" }, isError: false }; if (a.action === "report") throw new Error("no answer"); return { body: {}, isError: false }; } });
  calls.length = 0;
  await assert.rejects(runFmcFamTemplate({ action: "inspect", session: "", template: rft, dry_run: true, save_path: "", overwrite: false }, failing.io));
  assert.deepEqual(calls.map((c) => c.action), ["open", "report", "close"], "closed even when report fails");
  const out = body(await runFmcFamTemplate({ action: "inspect", session: "", template: "C:\\Temp\\X.rft", dry_run: true, save_path: "", overwrite: false }, io));
  assert.equal(out.isError, true);
});
