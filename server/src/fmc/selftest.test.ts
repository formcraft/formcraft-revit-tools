import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "./policy.js";
import { PathProbe, guardPaths, kitLayout, revitLines, runningBuildLine, summary } from "./selftest.js";
import { RUNNING_BUILD, annotateInvalidOp, annotateToolResult, buildDrift, readBuildInfo } from "./buildinfo.js";
import { annotateInvalidOpErrors } from "../tools/register.js";
import { parseRecipe } from "./recipes.js";

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

test("F-042: the running server (read at startup) against the build on disk: a difference fails with the restart", () => {
  const old = { commit: "1052d3b", built: "2026-10-14T09:00:00Z" }, now = { commit: "18f7d2a", built: "2026-10-15T08:00:00Z" };
  const drift = runningBuildLine(old, now);
  assert.equal(drift.state, "Fail");
  assert.match(drift.detail, /This process runs 1052d3b .* but 18f7d2a .* is installed/);
  assert.match(drift.detail, /Restart the Claude app \(or its Formcraft connector\) to load build 18f7d2a/);
  assert.equal(summary([drift]).result, "Fix first");
  assert.equal(runningBuildLine(now, now).state, "Pass");
  assert.equal(runningBuildLine(now, { commit: "unknown", built: "" }).state, "Warn");
  assert.equal(runningBuildLine({ commit: "unknown", built: "" }, now).state, "Warn");
  // a +local build of the same commit, rebuilt since the process started, is another build
  assert.equal(runningBuildLine({ commit: "18f7d2a+local", built: "a" }, { commit: "18f7d2a+local", built: "b" }).state, "Fail");
  assert.equal(buildDrift({ commit: "18f7d2a+local", built: "a" }, { commit: "18f7d2a", built: "a" }), false);
});

test("F-042: the running build is read once; the disk is read on every compare", () => {
  let disk = JSON.stringify({ commit: "aaa1111", built: "t1" });
  const read = () => readBuildInfo("x", () => disk);
  const running = read();
  disk = JSON.stringify({ commit: "bbb2222", built: "t2" });
  assert.equal(running.commit, "aaa1111");
  assert.equal(read().commit, "bbb2222");
  assert.equal(readBuildInfo("x", () => { throw new Error("gone"); }).commit, "unknown");
  assert.equal(readBuildInfo("x", () => "﻿" + JSON.stringify({ commit: "ccc" })).commit, "ccc");
  assert.ok(Object.isFrozen(RUNNING_BUILD));
});

test("F-042: every invalid-op refusal names the running build and, when the disk is newer, the restart", () => {
  const old = { commit: "1052d3b", built: "t1" }, now = { commit: "18f7d2a", built: "t2" };
  const zodText = "Invalid arguments for tool fmc_doc: ops.0.op: Invalid discriminator value. Expected 'set_category' | 'add_type'";
  const plain = annotateInvalidOp(zodText, old, now);
  assert.match(plain, /This server process runs build 1052d3b/);
  assert.match(plain, /Restart the Claude app \(or its Formcraft connector\) to load build 18f7d2a/);
  assert.equal(annotateInvalidOp(plain, old, now), plain, "noted once");
  assert.doesNotMatch(annotateInvalidOp(zodText, now, now), /Restart/);
  assert.equal(annotateInvalidOp("Template not found", old, now), "Template not found");

  // A tool reply is JSON the pane parses: the note goes in as fields, the JSON stays JSON
  const reply = { content: [{ type: "text", text: JSON.stringify({ refused: true, reasons: ["ops.3.op: Invalid discriminator value. Expected 'sweep'"] }) }], isError: true };
  const out = annotateToolResult(reply, old, () => now);
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.running_build, "1052d3b");
  assert.match(body.build_note, /load build 18f7d2a/);
  // a successful result, or an error about something else, is untouched
  const ok = { content: [{ type: "text", text: JSON.stringify({ done: true, note: "invalid op names are listed" }) }], isError: false };
  assert.equal(annotateToolResult(ok, old, () => now), ok);
  const other = { content: [{ type: "text", text: "Tool fmc_x not found" }], isError: true };
  assert.equal(annotateToolResult(other, old, () => now), other);
});

test("F-042: the tools/call hook wraps the SDK's handler, results and thrown errors alike", async () => {
  const handlers = new Map<string, (req: unknown, extra: unknown) => Promise<unknown>>();
  handlers.set("tools/call", async (req: any) => {
    if (req.throw) throw new Error("MCP error -32602: Invalid arguments for tool fmc_doc: Invalid discriminator value");
    return { content: [{ type: "text", text: "Input validation error: Invalid discriminator value. Expected 'a'" }], isError: true };
  });
  const fake = { server: { _requestHandlers: handlers } } as any;
  assert.equal(annotateInvalidOpErrors(fake), true);
  const r: any = await handlers.get("tools/call")!({}, {});
  assert.match(r.content[0].text, /This server process runs build/);
  await assert.rejects(handlers.get("tools/call")!({ throw: true }, {}), /This server process runs build/);
  assert.equal(annotateInvalidOpErrors({ server: { _requestHandlers: new Map() } } as any), false);
});

test("F-042: a recipe with an op this build doesn't know says which build refused it", () => {
  const r = parseRecipe(JSON.stringify({ family: "FMC_A_Door_X", template: "Metric Door.rft", ops: [{ op: "op_from_the_future", name: "x" }] }));
  assert.equal(r.recipe, null);
  assert.match(r.problems.join(" "), /Invalid discriminator value/);
  assert.match(r.problems.join(" "), /This server process runs build/);
});
