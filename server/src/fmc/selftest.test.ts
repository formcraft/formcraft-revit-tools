import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "./policy.js";
import { PathProbe, guardPaths, kitLayout, revitLines, summary } from "./selftest.js";

const K = "D:\\Kit";
function fakeFs(files: string[], dirs: string[]): PathProbe {
  const f = new Set(files.map((x) => x.toLowerCase())), d = new Set(dirs.map((x) => x.toLowerCase()));
  return {
    exists: (p) => f.has(p.toLowerCase()) || d.has(p.toLowerCase()),
    isDir: (p) => d.has(p.toLowerCase()),
    list: (p) => files.filter((x) => x.toLowerCase().startsWith(p.toLowerCase() + "\\")).map((x) => x.slice(p.length + 1)),
  };
}

test("kit layout: the real kit before r4 fails on the manifest, rulebooks and staging folders", () => {
  const fs = fakeFs([K + "\\01_Shared_Parameters\\FMC_SharedParameters.txt", K + "\\03_Master_Data\\FMC_Family_Specs.json",
    K + "\\03_Master_Data\\FMC_Sheet_Register.csv", K + "\\06_Templates\\_README.txt"], [K, K + "\\06_Templates"]);
  const lines = kitLayout(K, fs);
  const failing = lines.filter((l) => l.state === "Fail").map((l) => l.check);
  assert.deepEqual(failing, ["FMC_Kit.json", "03_Master_Data\\FMC_Rulebook", "04_Families\\_Staging", "06_Templates\\_Staging"]);
  assert.equal(lines.find((l) => l.check === "06_Templates")!.state, "Warn");
});

test("kit layout: r4 with rulebooks passes; an empty rulebook folder says so", () => {
  const dirs = [K, K + "\\03_Master_Data\\FMC_Rulebook", K + "\\04_Families\\_Staging", K + "\\06_Templates\\_Staging", K + "\\06_Templates"];
  const files = [K + "\\FMC_Kit.json", K + "\\01_Shared_Parameters\\FMC_SharedParameters.txt", K + "\\03_Master_Data\\FMC_Family_Specs.json",
    K + "\\03_Master_Data\\FMC_Sheet_Register.csv", K + "\\06_Templates\\FMC_A.rte"];
  assert.equal(summary(kitLayout(K, fakeFs([...files, K + "\\03_Master_Data\\FMC_Rulebook\\Naming.json"], dirs))).result, "Ready to test");
  const empty = kitLayout(K, fakeFs(files, dirs)).find((l) => l.check === "03_Master_Data\\FMC_Rulebook")!;
  assert.equal(empty.state, "Fail");
  assert.match(empty.detail, /folder is there, no \.json files yet/);
  assert.equal(kitLayout("", fakeFs([], []))[0].detail, "Not set: Settings › General › kit folder");
});

test("guard paths: a write root pattern is checked at its base; a missing rulebook folder fails", () => {
  const cfg = { ...DEFAULT_CONFIG, write_roots: ["D:\\Projects\\*\\01_WIP"], template_roots: [] };
  const lines = guardPaths(cfg, fakeFs([], ["D:\\Projects"]), (p) => p);
  assert.equal(lines.find((l) => l.check === "write_roots")!.state, "Pass");
  assert.equal(lines.find((l) => l.check === "rulebooks_dir")!.state, "Fail");
  assert.equal(lines.find((l) => l.check === "materials_file")!.state, "Warn");
});

test("Revit lines: not listening fails; builds compared; missing commands fail; saved documents need the user", () => {
  assert.equal(revitLines(null, { commit: "abc1234", built: "" }, "not listening")[0].state, "Fail");
  const lines = revitLines({
    addin: { commit: "abc1234", built: "t" }, revit: "2025.4", connection: { port: 8080, start_with_revit: true },
    commands: { registered: 60, listed: 61, missing: ["fmc_link_add"] },
    documents: [{ title: "Project1", saved: false, modified: false, workshared: false }, { title: "Real.rvt", saved: true, modified: false, workshared: true }],
  }, { commit: "def5678", built: "" }, "");
  const by = Object.fromEntries(lines.map((l) => [l.check, l]));
  assert.equal(by["Server and add-in match"].state, "Warn");
  assert.equal(by["Commands known to Revit"].state, "Fail");
  assert.match(by["Safe to close Revit for an install"].detail, /Ask the user first: Real\.rvt \(saved file\)/);
});
