import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IdentityMap, exchangeRoot, link, saveIdentity, writePackage } from "./exchange.js";
import { fileLogLines, identityMatches, matchClashes, matchTickets, matchTree, mentions, mergeTimeline, needlesFor, ticketWhy, wordRe } from "./find.js";
import { csvLine } from "../fmc/policy.js";
import { FindDeps, runFmcFind } from "../tools/fmc_find.js";

const win = path.win32;
const MODEL = "F26001-FMC-ZZ-ZZ-M3-S-0001";

function sampleMap(): IdentityMap {
  const map: IdentityMap = { version: 1, entries: {} };
  link(map, "revit", "uid-d12", { fmc: "FMC-d12", name: "D-12", kind: "door", file: MODEL, at: "2026-10-18T09:00:00Z" });
  link(map, "robot", "FEA-20261018-0900#3", { fmc: "FMC-col3", name: "C-03", at: "2026-10-18T10:00:00Z" });
  return map;
}

const ticket = (id: string, over: Record<string, unknown>) => ({
  id, title: "", description: "", disciplines: ["A"], lead: "A", owner: "", priority: "High", due: "", status: "Open", raised_by: "x",
  raised_at: "2026-10-17T08:00:00Z", model: MODEL, view: "", element_ids: [], answers: [], solution: "", history: [], ...over,
});

test("a needle is a whole word: D-12 is not D-123, 4120 is not 41208", () => {
  assert.ok(wordRe("D-12").test("Fix door D-12 now"));
  assert.ok(!wordRe("D-12").test("D-123"));
  assert.ok(!wordRe("4120").test("id 41208"));
  assert.equal(mentions("moved uid-d12 in staging", { text: "D-12", fmc: [], unique_ids: ["uid-d12"], element_ids: [] }), "uid-d12");
});

test("the identity map is matched by Formcraft id, name or any app id; needles gather every id", () => {
  const map = sampleMap();
  assert.equal(identityMatches(map, "d-12")[0].fmc, "FMC-d12");
  assert.equal(identityMatches(map, "FEA-20261018-0900#3")[0].fmc, "FMC-col3");
  const n = needlesFor("D-12", identityMatches(map, "D-12"), [{ unique_id: "uid-d12", element_id: 51234 }]);
  assert.deepEqual(n, { text: "D-12", fmc: ["FMC-d12"], unique_ids: ["uid-d12"], element_ids: ["51234"] });
  assert.deepEqual(needlesFor("412088", []).element_ids, ["412088"]);
});

test("tickets are found by their elements, clash items, recipe node or words", () => {
  const n = { text: "D-12", fmc: [], unique_ids: ["uid-d12"], element_ids: ["51234"] };
  const reg = { project: "P", items: [
    ticket("R-001", { element_ids: [51234] }),
    ticket("R-002", { where: { unique_ids: ["uid-d12"] } }),
    ticket("R-003", { source: "clash", links: { clash: { test: "A vs S", name: "Clash1", items: [{ model: MODEL, id: "51234", category: "Doors" }] } } }),
    ticket("R-004", { title: "Door D-12 swing hits the column" }),
    ticket("R-005", { title: "Door D-123 is fine" }),
  ] } as any;
  assert.deepEqual(matchTickets(reg, n).map((t) => [t.id, t.why]),
    [["R-001", "its elements"], ["R-002", "its elements"], ["R-003", "its clash"], ["R-004", "its title or description"]]);
  assert.equal(ticketWhy(reg.items[4], n), null);
});

test("tree nodes are found by id, name or a value such as a room number", () => {
  const tree = { schema: "fmc-tree/0.1" as const, project: "P", root: { id: "P", kind: "project" as const, children: [
    { id: "L-00", kind: "level" as const, name: "00 Ground", children: [
      { id: "L-00.G01.Room", kind: "room" as const, name: "G01 Reception", make: { tool: "fmc_room", args: { room: { number: "G01", name: "Reception" } } } },
    ] },
  ] } };
  assert.deepEqual(matchTree(tree, "G01").map((h) => [h.id, h.why]), [["L-00.G01.Room", "its name"]]);
  assert.equal(matchTree(tree, "Reception")[0].id, "L-00.G01.Room");
  assert.equal(matchTree(tree, "FMC:L-00")[0].why, "its id");
  assert.deepEqual(matchTree(null, "x"), []);
});

test("clashes naming the element say what it clashes with", () => {
  const item = (id: string, category: string) => ({ name: "", category, revit_id: id, source: `D:\\P\\${MODEL}.nwc` });
  const rows = [
    { name: "Clash1", status: "New", distance_mm: -40, item1: item("777", "Ducts"), item2: item("51234", "Doors") },
    { name: "Clash2", status: "New", distance_mm: -5, item1: item("1", "Pipes"), item2: item("2", "Walls") },
  ];
  const hits = matchClashes("A vs M", rows, { text: "D-12", fmc: [], unique_ids: [], element_ids: ["51234"] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].other.category, "Ducts");
  assert.equal(hits[0].other.source, `${MODEL}.nwc`);
});

test("the file log's rows that name an id, and one timeline newest first", () => {
  const rows = [["timestamp", "action", "dry_run", "target", "result", "detail"],
    ["2026-10-19T08:00:00Z", "rhino_save", "true", "x.3dm", "dry run", "for uid-d12"],
    ["2026-10-19T09:00:00Z", "robot_send", "false", "y.rtd", "done", "nothing to see"]];
  const lines = fileLogLines(rows, { text: "D-12", fmc: [], unique_ids: ["uid-d12"], element_ids: [] });
  assert.equal(lines.length, 1);
  assert.match(lines[0].what, /dry run/);
  const t = mergeTimeline([{ at: "bad", source: "review", what: "a" }, { at: "2026-10-01T00:00:00Z", source: "review", what: "b" }, ...lines], 10);
  assert.deepEqual(t.lines.map((l) => l.what[0]), ["r", "b", "a"]);
});

/** A project with an identity map, a package, a review register, a tree and a file log. */
function sampleProject() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-find-"));
  const reports = win.join(project, "reports");
  fs.mkdirSync(reports, { recursive: true });
  const root = exchangeRoot(project, reports);
  saveIdentity(root, sampleMap());
  writePackage(root, { from: "revit", to: "navisworks", what: "Door schedule", files: [{ name: "doors.json", text: JSON.stringify([{ uid: "uid-d12", mark: "D-12" }]) }],
    now: new Date("2026-10-18T12:00:00Z") });
  writePackage(root, { from: "revit", to: "robot", what: "Columns", files: [{ name: "cols.json", text: "[]" }] });
  fs.mkdirSync(win.join(project, "01_WIP", "_Reviews"), { recursive: true });
  fs.writeFileSync(win.join(project, "01_WIP", "_Reviews", "FMC_Review_Register.json"), JSON.stringify({ project: "P", items: [
    ticket("R-001", { element_ids: [51234], title: "Door clashes", history: [{ at: "2026-10-17T09:00:00Z", by: "x", what: "assigned to A" }] }),
  ] }));
  fs.mkdirSync(win.join(project, "01_WIP", "_Tree"), { recursive: true });
  fs.writeFileSync(win.join(project, "01_WIP", "_Tree", "FMC_Recipe_Tree.json"), JSON.stringify({ schema: "fmc-tree/0.1", project: "P",
    root: { id: "P", kind: "project", children: [{ id: "D-12", kind: "component", name: "Door D-12" }] } }));
  fs.writeFileSync(win.join(reports, "FMC_MCP_FileLog.csv"), csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]) +
    csvLine(["2026-10-19T08:00:00Z", "review_fix", "false", MODEL, "done", "D-12 resized"]));
  return { project, reports, root };
}

const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

test("fmc_find: one query answered from the map, Revit, Navisworks, tickets, the tree and packages", async () => {
  const { project, reports, root } = sampleProject();
  const asked: string[] = [];
  const deps: FindDeps = {
    revit: async (m, p: any) => { asked.push(m); assert.equal(p.query, "D-12"); return { model: MODEL, found: [{ unique_id: "uid-d12", element_id: 51234, model: MODEL, category: "Doors", matched: "mark" }],
      touching: [{ of: "uid-d12", elements: [{ unique_id: "uid-wall", category: "Walls" }] }] }; },
    navis: async (m, p: any) => {
      asked.push(m);
      if (m === "navis_select") { assert.equal(p.select, false); return { found: [{ revit_id: "51234", source: MODEL }] }; }
      if (m === "navis_clash_tests") return { tests: [{ name: "A vs M" }] };
      return { results: [{ name: "Clash1", status: "New", distance_mm: -40, item1: { name: "", category: "Ducts", revit_id: "9", source: "M.nwc" }, item2: { name: "", category: "Doors", revit_id: "51234", source: `${MODEL}.nwc` } }] };
    },
    identityRoot: root, reportsDir: reports,
  };
  const b = body(await runFmcFind({ action: "find", query: "D-12", project_folder: project, partial: false, touching: true, limit: 50 }, deps));
  assert.deepEqual(asked, ["fmc_find_elements", "navis_select", "navis_clash_tests", "navis_clash_results"]);
  assert.equal(b.identity.elements[0].fmc, "FMC-d12");
  assert.equal(b.revit.touching[0].elements[0].category, "Walls");
  assert.equal(b.navisworks.items.length, 1);
  assert.equal(b.navisworks.clashes[0].other.category, "Ducts");
  assert.deepEqual(b.tickets.map((t: any) => t.id), ["R-001"]);
  assert.deepEqual(b.tree.map((t: any) => t.id), ["D-12"]);
  assert.deepEqual(b.packages.map((p: any) => p.what), ["Door schedule"]);
  assert.match(b.read_only, /Nothing was selected or changed/);
});

test("fmc_find: closed apps are skipped and said so; without a project, tickets and the tree aren't searched", async () => {
  const { reports, root } = sampleProject();
  const deps: FindDeps = { revit: async () => { throw new Error("Revit isn't running"); }, navis: null, identityRoot: root, reportsDir: reports };
  const b = body(await runFmcFind({ action: "find", query: "D-12", project_folder: "", partial: false, touching: true, limit: 50 }, deps));
  assert.match(b.revit.error, /isn't running/);
  assert.equal(b.navisworks.open, false);
  assert.deepEqual(b.tickets, []);
  assert.match(b.note, /No project_folder/);
  assert.equal(b.packages.length, 1);
});

test("fmc_find log: the file log, packages, ticket history and identity links on one timeline", async () => {
  const { project, reports, root } = sampleProject();
  const deps: FindDeps = { revit: null, navis: null, identityRoot: root, reportsDir: reports };
  // the ticket names element 51234: a log for that element id finds its story
  const byId = body(await runFmcFind({ action: "log", query: "51234", project_folder: project, partial: false, touching: true, limit: 50 }, deps));
  assert.deepEqual(byId.lines.map((l: any) => l.source), ["review", "review"]);
  const b = body(await runFmcFind({ action: "log", query: "D-12", project_folder: project, partial: false, touching: true, limit: 50 }, deps));
  // a package's time is when it was written (now), so only the set of sources is fixed
  assert.deepEqual(b.lines.map((l: any) => l.source).sort(), ["exchange", "file log", "identity"]);
  assert.equal(b.lines.find((l: any) => l.source === "file log").what, "review_fix: done");
  assert.match(b.read_only, /nothing changed/);
});
