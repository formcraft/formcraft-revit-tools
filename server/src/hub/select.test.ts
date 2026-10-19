import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IdentityMap, link, saveIdentity } from "./exchange.js";
import { enrich, label, mergeRevit, navisRequest, picksFromIds, picksFromNavis, picksFromRevit, picksFromRhino, revitRequest,
  rhinoRequest, robotRequests, unmapped } from "./select.js";
import { SelectDeps, runFmcSelect } from "../tools/fmc_select.js";

const MODEL = "F26001-FMC-ZZ-ZZ-M3-S-0001";
const NWC = `D:\\P\\${MODEL}.nwc`;

/** A column known in Revit (by UniqueId) and Robot; a beam known only by its Revit element id; a part in Rhino. */
function sampleMap(): IdentityMap {
  const map: IdentityMap = { version: 1, entries: {} };
  const c = link(map, "revit", "uid-col-1", { fmc: "FMC-col1", name: "C-01", kind: "column", file: MODEL });
  link(map, "robot", "FEA-20261019-0900#17", { fmc: c });
  link(map, "rhino", "6f1c0e3a-0000-4000-8000-000000000001", { fmc: c });
  link(map, "revit", "412088", { fmc: "FMC-beam1", name: "B-12", file: MODEL });
  return map;
}

test("each app's selection becomes picks", () => {
  const r = picksFromRevit({ model: MODEL, elements: [{ unique_id: "uid-col-1", element_id: 4001, category: "Structural Columns", mark: "C-01", model: MODEL }],
    linked: [{ unique_id: "uid-l", element_id: 9, link: "Link-M" }] });
  assert.equal(r.length, 2);
  assert.deepEqual(r[0].revit, { unique_id: "uid-col-1", element_id: "4001", model: MODEL });
  assert.equal(r[1].revit?.model, "Link-M");
  const n = picksFromNavis({ items: [{ revit_id: "412088", source: NWC, guid: "g-1", category: "Structural Framing" }] });
  assert.deepEqual(n[0].revit, { element_id: "412088", model: NWC });
  const h = picksFromRhino({ objects: [{ id: "abc", name: "grip", user_text: { "fmc.id": "FMC-col1" } }] });
  assert.equal(h[0].fmc, "FMC-col1");
});

test("typed ids are read the way each app names its elements", () => {
  assert.deepEqual(picksFromIds("revit", ["412088", "uid-x", "FMC-1"]), [{ revit: { element_id: "412088" } }, { revit: { unique_id: "uid-x" } }, { fmc: "FMC-1" }]);
  assert.deepEqual(picksFromIds("navisworks", [`${MODEL}#412088`])[0].revit, { element_id: "412088", model: MODEL });
  assert.deepEqual(picksFromIds("robot", ["FEA-20261019-0900#17"])[0].robot, { run: "FEA-20261019-0900", bar: 17 });
});

test("the identity map fills in every app it knows", () => {
  const map = sampleMap();
  const [col] = enrich(map, [{ revit: { unique_id: "uid-col-1" } }]);
  assert.equal(col.fmc, "FMC-col1");
  assert.deepEqual(col.robot, { run: "FEA-20261019-0900", bar: 17 });
  assert.equal(col.rhino?.id, "6f1c0e3a-0000-4000-8000-000000000001");
  assert.equal(label(col), "C-01");
  // from Robot back to Revit
  const [back] = enrich(map, picksFromIds("robot", ["FEA-20261019-0900#17"]));
  assert.equal(back.revit?.unique_id, "uid-col-1");
  // a Navisworks item finds an element the map knows only by its element id, in the same model
  const [beam] = enrich(map, picksFromNavis({ items: [{ revit_id: "412088", source: NWC }] }));
  assert.equal(beam.fmc, "FMC-beam1");
  const [other] = enrich(map, picksFromNavis({ items: [{ revit_id: "412088", source: "D:\\P\\Another-M.nwc" }] }));
  assert.equal(other.fmc, undefined);
});

test("requests: Revit by UniqueId first, Navisworks by element id and model, Rhino by id or fmc.id, Robot by run", () => {
  const picks = enrich(sampleMap(), [{ revit: { unique_id: "uid-col-1" } }, { fmc: "FMC-beam1" }, { revit: { unique_id: "uid-unknown" } }]);
  assert.deepEqual(revitRequest(picks), { unique_ids: ["uid-col-1", "uid-unknown"], element_ids: [{ id: "412088", model: MODEL }] });
  assert.deepEqual(navisRequest(picks).items, [{ revit_id: "412088", source: MODEL }]);
  assert.deepEqual(rhinoRequest(picks), { ids: ["6f1c0e3a-0000-4000-8000-000000000001"], key: "fmc.id", values: ["FMC-beam1"] });
  assert.deepEqual(robotRequests(picks), [{ run: "FEA-20261019-0900", bars: [17] }]);
  assert.deepEqual(unmapped(picks, "robot"), ["B-12", "uid-unknown"]);
  // Revit's answer gives the column its element id and model, so Navisworks can find it too
  const merged = mergeRevit(picks, [{ unique_id: "uid-col-1", element_id: 4001, model: MODEL, mark: "C-01" }]);
  assert.equal(navisRequest(merged).items.length, 2);
});

/** Stand-ins for the four apps, recording what each was asked. */
function fakeApps(over: Partial<Record<"revit" | "navis" | "rhino" | "robot", (m: string, p: any) => any>> = {}) {
  const calls: Array<{ app: string; method: string; params: any }> = [];
  const wrap = (app: string, f: (m: string, p: any) => any) => async (m: string, p: object) => { calls.push({ app, method: m, params: p }); return f(m, p); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-select-"));
  saveIdentity(dir, sampleMap());
  const deps: SelectDeps = {
    revit: wrap("revit", over.revit ?? ((m, p) => m === "fmc_selection_get"
      ? { model: MODEL, count: 1, elements: [{ unique_id: "uid-col-1", element_id: 4001, category: "Structural Columns", mark: "C-01", model: MODEL }] }
      : { model: MODEL, selected: (p.unique_ids?.length ?? 0) + (p.element_ids?.length ?? 0), found: [{ unique_id: "uid-col-1", element_id: 4001, model: MODEL }], missing: [] })),
    navis: wrap("navis", over.navis ?? ((_m, p) => ({ selected: p.items.length, found: [], missing: [], zoomed: true }))),
    rhino: wrap("rhino", over.rhino ?? ((_m, p) => ({ document: "parts.3dm", selected: p.ids.length, missing: [] }))),
    robot: wrap("robot", over.robot ?? ((_m, p) => ({ run: p.run, selected: p.bars.length, missing: [] }))),
    identityRoot: dir,
  };
  return { deps, calls };
}

const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

test("fmc_select: Revit's selection is shown in Navisworks, Rhino and Robot", async () => {
  const { deps, calls } = fakeApps();
  const r = await runFmcSelect({ action: "show", from: "revit", to: [], ids: [], zoom: true, project_folder: "" }, deps);
  const b = body(r);
  assert.equal(r.isError, false);
  assert.equal(b.selection, 1);
  assert.equal(b.mapped_in_identity, 1);
  assert.equal(b.apps.navisworks.selected, 1);
  assert.deepEqual(calls.find((c) => c.method === "navis_select")!.params.items, [{ revit_id: "4001", source: MODEL }]);
  assert.equal(b.apps.rhino.selected, 1);
  assert.deepEqual(calls.find((c) => c.method === "select")!.params, { run: "FEA-20261019-0900", bars: [17] });
  assert.match(b.note, /no dry run/);
});

test("fmc_select: from Robot, Revit is asked first and Navisworks gets the element id it answered", async () => {
  const { deps, calls } = fakeApps();
  const b = body(await runFmcSelect({ action: "show", from: "robot", to: ["navisworks", "revit"], ids: ["FEA-20261019-0900#17"], zoom: true, project_folder: "" }, deps));
  assert.deepEqual(calls.map((c) => c.method), ["fmc_selection_show", "navis_select"]);
  assert.equal(b.apps.revit.selected, 1);
  assert.deepEqual(calls[1].params.items, [{ revit_id: "4001", source: MODEL }]);
});

test("fmc_select: Revit is only looked up (not selected) when Navisworks needs an element id and Revit isn't a target", async () => {
  const { deps, calls } = fakeApps();
  await runFmcSelect({ action: "show", from: "rhino", to: ["navisworks"], ids: ["6f1c0e3a-0000-4000-8000-000000000001"], zoom: true, project_folder: "" }, deps);
  assert.equal(calls[0].method, "fmc_selection_show");
  assert.equal(calls[0].params.select, false);
  assert.equal(calls[1].method, "navis_select");
});

test("fmc_select: a closed app is named, an app's error doesn't stop the others, unmapped elements are listed", async () => {
  const { deps } = fakeApps({ rhino: () => { throw new Error("Rhino's window is busy"); } });
  deps.navis = null;
  const b = body(await runFmcSelect({ action: "show", from: "revit", to: [], ids: ["uid-unknown", "uid-col-1"], zoom: true, project_folder: "" }, deps));
  assert.equal(b.apps.navisworks.open, false);
  assert.equal(b.apps.robot.selected, 1);
  assert.deepEqual(b.apps.robot.not_mapped, ["uid-unknown"]);
  assert.match(b.apps.rhino.error ?? "", /busy/);
});

test("fmc_select: nothing selected, or the from app closed, is a refusal", async () => {
  const { deps } = fakeApps({ revit: () => ({ model: MODEL, count: 0, elements: [] }) });
  const r = await runFmcSelect({ action: "show", from: "revit", to: [], ids: [], zoom: true, project_folder: "" }, deps);
  assert.equal(r.isError, true);
  deps.rhino = null;
  const r2 = await runFmcSelect({ action: "show", from: "rhino", to: [], ids: [], zoom: true, project_folder: "" }, deps);
  assert.match(body(r2).reasons[0], /Rhino/);
});

test("fmc_select read: every open app's selection, nothing selected", async () => {
  const { deps, calls } = fakeApps({
    navis: () => ({ count: 1, items: [{ revit_id: "412088", source: NWC }] }),
    rhino: () => ({ document: "d", count: 0, objects: [] }),
    robot: () => ({ run: "FEA-20261019-0900", bars: [17] }),
  });
  const b = body(await runFmcSelect({ action: "read", from: "revit", to: [], ids: [], zoom: true, project_folder: "" }, deps));
  assert.deepEqual(calls.map((c) => c.method), ["fmc_selection_get", "navis_selection", "rhino_selection", "selection"]);
  assert.equal(b.apps.navisworks.elements[0].fmc, "FMC-beam1");
  assert.equal(b.apps.robot.elements[0].revit.unique_id, "uid-col-1");
});
