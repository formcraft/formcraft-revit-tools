import { test } from "node:test";
import assert from "node:assert/strict";
import { InstanceReader, RevitInstance, readInstances, resolvePort } from "./connect.js";

const env = { APPDATA: "C:\\Users\\X\\AppData\\Roaming" } as NodeJS.ProcessEnv;
const inst = (pid: number, port: number, docs: string[], started: string): RevitInstance => ({
  pid, port, revit: "2025.4", user: "USER", started, updated: started, build: "abc",
  documents: docs.map((t, k) => ({ title: t, path: `Z:\\Projects\\${t}.rvt`, active: k === 0, family: false, workshared: false })),
});
const A = inst(100, 8080, ["F26001-FMC-ZZ-ZZ-M3-A-0001"], "2026-10-14T10:00:00Z");
const B = inst(200, 8081, ["F26002-FMC-ZZ-ZZ-M3-S-0001", "Detail sketch"], "2026-10-14T11:00:00Z");

test("one Revit: calls go there; none: the configured port", () => {
  assert.equal(resolvePort(undefined, [B], env, undefined), 8081);
  assert.equal(resolvePort(undefined, [], { ...env, REVIT_PORT: "" }, undefined), 8080);
});

test("two Revits: a call names one by project, pid or port; otherwise it is refused with the list", () => {
  assert.equal(resolvePort("F26002", [A, B], env, undefined), 8081);
  assert.equal(resolvePort("detail", [A, B], env, undefined), 8081);
  assert.equal(resolvePort("100", [A, B], env, undefined), 8080);
  assert.equal(resolvePort("8081", [A, B], env, undefined), 8081);
  assert.throws(() => resolvePort(undefined, [A, B], env, undefined), /2 Revits are open: F26001.*port 8080.*F26002.*port 8081.*pass revit/);
  assert.throws(() => resolvePort("F2600", [A, B], env, undefined), /matches 2 Revits/);
  assert.throws(() => resolvePort("nothing", [A, B], env, undefined), /No open Revit has a document matching/);
});

test("order: the call's revit, then the pane's REVIT_PORT, then fmc_revit use", () => {
  assert.equal(resolvePort(undefined, [A, B], { ...env, REVIT_PORT: "8081" }, "F26001"), 8081);
  assert.equal(resolvePort("F26001", [A, B], { ...env, REVIT_PORT: "8081" }, undefined), 8080);
  assert.equal(resolvePort(undefined, [A, B], env, "F26002"), 8081);
});

test("the registry skips Revits that are gone and cleans their files", () => {
  const files: Record<string, string> = { "100.json": JSON.stringify(B), "300.json": JSON.stringify(inst(300, 8082, [], "2026-10-14T12:00:00Z")),
    "200.json": JSON.stringify(A), "bad.json": "{half" };
  const removed: string[] = [];
  const reader: InstanceReader = { list: () => Object.keys(files), read: (f) => files[f.split("\\").pop()!], alive: (pid) => pid !== 300,
    remove: (f) => removed.push(f.split("\\").pop()!) };
  const list = readInstances(env, reader);
  assert.deepEqual(list.map((i) => i.port), [8080, 8081]);
  assert.deepEqual(removed, ["300.json"]);
});

test("every tool gets revit; the tool never sees it, and the call runs with it as its target", async () => {
  const { withRevitTarget } = await import("../tools/register.js");
  const { revitTarget } = await import("./target.js");
  const registered: Record<string, { shape: Record<string, unknown>; handler: (a: Record<string, unknown>, e: unknown) => unknown }> = {};
  const server = { tool: (name: string, _d: string, shape: Record<string, unknown>, handler: any) => { registered[name] = { shape, handler }; } };
  withRevitTarget(server as any);
  let seen: Record<string, unknown> = {}, target: string | undefined;
  (server as any).tool("demo", "d", { x: {} }, (args: Record<string, unknown>) => { seen = args; target = revitTarget.getStore(); });
  assert.ok("revit" in registered.demo.shape && "x" in registered.demo.shape);
  await registered.demo.handler({ x: 1, revit: "F26002" }, {});
  assert.deepEqual(seen, { x: 1 });
  assert.equal(target, "F26002");
});

test("RE-4: an exact title wins over a substring, and a folder name only matches when no title does", async () => {
  const { matchInstances } = await import("./connect.js");
  const P = inst(300, 8082, ["plumbing"], "2026-10-14T12:00:00Z");
  const Q = inst(400, 8083, ["plumbing_USER"], "2026-10-14T13:00:00Z");
  assert.deepEqual(matchInstances("plumbing", [P, Q]).hits.map((i) => i.pid), [300]);
  assert.equal(matchInstances("plumbing", [P, Q]).rule, "title");
  assert.equal(resolvePort("plumbing", [P, Q], env, undefined), 8082);
  assert.equal(matchInstances("projects", [A]).rule, "path_contains");
});

test("RE-2/RE-5/RE-8: list rows carry user, updated, build match and the revit value", async () => {
  const { instanceRow, buildMatch, NO_REVIT_NOTE } = await import("../tools/fmc_revit.js");
  const row = instanceRow({ ...A, build: "cf71214" }, "cfc56f5+local", Date.parse("2026-10-14T10:01:00Z"));
  assert.equal(row.build_match, false);
  assert.equal(row.revit_arg, "100");
  assert.equal(row.updated_age_s, 60);
  assert.equal(row.documents[0].path, "Z:\\Projects\\F26001-FMC-ZZ-ZZ-M3-A-0001.rvt");
  assert.equal(buildMatch("abc1234", "abc1234+local"), true);
  assert.equal(buildMatch("", "abc"), null);
  assert.match(NO_REVIT_NOTE, /AI is off/);
});
