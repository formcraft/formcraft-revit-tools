import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DIFF_CAP, applyProblems, findScript, loadLibrary, pythonSupported, refuseFullScan, refuseProtectedWrite,
  resolveEntry, screenLibrarySource, shapeDiff, validateManifest, worksharedUnsafe,
} from "./scriptlib.js";

const manifest = {
  id: "sheets",
  entry: "Run.cs",
  runner: "csharp",
  inputs: [{ name: "level" }],
  outputs: [{ name: "created" }],
  revit_version: "2025",
  kit_version: "2.2",
  references: { kit: "FMC-BIM-MAN-001", standards: "FMC-BIM-STD-002", rulebook: "FMC_Rulebook_AIUse" },
  dry_run: true,
  writes_model: true,
  workshared_safe: false,
  target_doc_rules: {},
  replaces_plugin_tools: ["fmc_sheet_create"],
  est_ai_calls_saved: 4,
};

test("a manifest missing kit, standards or rulebook is refused", () => {
  const missing = { ...manifest, references: { kit: "FMC-BIM-MAN-001", standards: "", rulebook: "book" } };
  const verdict = validateManifest(missing);
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  assert.ok(verdict.problems.some((line) => line.includes("references.standards")));
  const gone = { ...manifest } as Record<string, unknown>;
  delete gone.references;
  const noRefs = validateManifest(gone);
  assert.equal(noRefs.ok, false);
  if (noRefs.ok) return;
  assert.ok(noRefs.problems.some((line) => line.includes("references is required")));
});

test("a complete manifest loads from index.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-lib-"));
  const folder = path.join(root, "05_Scripts", "library", "sheets");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(folder, "Run.cs"), "return null;\n");
  fs.writeFileSync(path.join(root, "05_Scripts", "library", "index.json"), JSON.stringify({
    scripts: [{ id: "sheets", manifest: "sheets/manifest.json" }],
  }));
  const loaded = loadLibrary(root);
  assert.equal(loaded.problems.length, 0);
  assert.equal(loaded.entries.length, 1);
  assert.equal(loaded.entries[0].manifest?.id, "sheets");
  assert.equal(loaded.entries[0].problems.length, 0);
  const found = findScript(root, "sheets");
  assert.ok(found?.manifest);
  const entry = resolveEntry(root, found!.manifest_path, found!.manifest!.entry);
  assert.equal(entry.ok, true);
});

test("workshared_safe source that checks out elements or handles an editing request is refused", () => {
  assert.equal(worksharedUnsafe("WorksharingUtils.CheckoutElements(doc, ids);"), "CheckoutElements");
  assert.equal(worksharedUnsafe("foreach (EditingRequest request in requests) { }"), "EditingRequest");
  assert.equal(worksharedUnsafe("return new { created = 1 };"), null);
});

test("allow_full_scan is refused and an unscoped collector is FMC-SEND-CODE-UNSCOPED", () => {
  assert.match(refuseFullScan(true) ?? "", /FMC-SEND-CODE-UNSCOPED/);
  assert.equal(refuseFullScan(false), null);
  const source = [
    "foreach (Element e in new FilteredElementCollector(document)) {",
    "  foreach (Parameter p in e.Parameters) {",
    "    var t = p.StorageType;",
    "    var s = p.AsValueString();",
    "  }",
    "}",
    "return null;",
  ].join("\n");
  const hit = screenLibrarySource(source);
  assert.equal(hit?.code, "FMC-SEND-CODE-UNSCOPED");
});

test("the diff caps ids and parameter rows and keeps the counts", () => {
  const ids = Array.from({ length: DIFF_CAP + 10 }, (_, i) => i + 1);
  const diff = shapeDiff({
    createdIds: ids,
    deletedIds: [9],
    modifiedIds: ids,
    modifiedCount: ids.length,
    parameter_before: ids.map((id) => ({ id, parameters: [{ name: "Mark", value: "a" }] })),
    parameter_after: ids.map((id) => ({ id, parameters: [{ name: "Mark", value: "b" }] })),
  });
  assert.equal(diff.created.length, DIFF_CAP);
  assert.equal(diff.created_count, ids.length);
  assert.equal(diff.modified.length, DIFF_CAP);
  assert.equal(diff.modified_count, ids.length);
  assert.equal(diff.parameters.length, DIFF_CAP);
  assert.equal(diff.parameters[0].before?.[0].value, "a");
  assert.equal(diff.parameters[0].after?.[0].value, "b");
  assert.equal(diff.parameter_count, ids.length);
  assert.equal(diff.capped, true);
});

test("HEBERT HOSTELS_USER and a protected path are never written", () => {
  const cfg = { protected_paths: ["D:\\Secrets"], protected_roots: [] };
  assert.match(refuseProtectedWrite({ title: "HEBERT HOSTELS_USER", path: "C:\\Users\\USER\\Documents\\HEBERT HOSTELS_USER.rvt" }, cfg) ?? "", /HEBERT HOSTELS_USER/);
  assert.match(refuseProtectedWrite({ path: "D:\\Secrets\\Model.rvt" }, cfg) ?? "", /protected path/);
  assert.equal(refuseProtectedWrite({ title: "Other", path: "D:\\WIP\\Other.rvt" }, cfg), null);
});

test("apply checks revit_version, workshared_safe and target_doc_rules", () => {
  const ok = validateManifest(manifest);
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(applyProblems(ok.manifest, { revitVersion: "2025.4", document: { title: "A", path: "D:\\A.rvt", workshared: false } }), []);
  assert.ok(applyProblems(ok.manifest, { revitVersion: "2026" }).some((line) => /2026/.test(line)));
  const shared = applyProblems(ok.manifest, { document: { title: "A", workshared: true } });
  assert.ok(shared.some((line) => /workshared_safe/.test(line)));
  const ruled = validateManifest({ ...manifest, workshared_safe: true, target_doc_rules: { title: "Architecture" } });
  assert.equal(ruled.ok, true);
  if (!ruled.ok) return;
  assert.ok(applyProblems(ruled.manifest, { document: { title: "Structure", workshared: true } }).some((line) => /title/.test(line)));
});

test("Revit API Python is not hosted; plain Python is", () => {
  const api = pythonSupported("import clr\nclr.AddReference('RevitAPI')\n");
  assert.equal(api.ok, false);
  if (api.ok) return;
  assert.equal(api.code, "FMC-PYTHON-UNAVAILABLE");
  assert.equal(pythonSupported("print('hello')\n").ok, true);
});
