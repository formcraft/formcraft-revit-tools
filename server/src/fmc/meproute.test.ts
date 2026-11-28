import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFmcMepRoute, type FmcMepRouteArgs, type RouteSnapshot } from "../tools/fmc_mep_route.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env, LOCALAPPDATA: fs.mkdtempSync(path.join(os.tmpdir(), "meproute-")) };
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
const guardCfg = { protected_paths: ["Z:\\Projects\\Live"] } as never;

const args = (a: Partial<FmcMepRouteArgs>): FmcMepRouteArgs => ({
  action: "preview", kind: "pipe",
  route: { start: [0, 0, 3000], goal: [5000, 3000, 3000], bounds: { min: [-500, -500, 2500], max: [6000, 4000, 3500] }, grid_mm: 500, size_mm: 50, flow: "pressure" },
  type_name: "", system_type_name: "", level_name: "", caps: false, angles_deg: [], document: "", dry_run: true, batch_lease: "", sample_limit: 40, ...a,
} as FmcMepRouteArgs);

const fullRules = { Segments: [{ index: 0, part_id: 1 }], Elbows: [{ index: 0, part_id: 2 }], Junctions: [{ index: 0, part_id: 3 }], Transitions: [{ index: 0, part_id: 4 }], Unions: [{ index: 0, part_id: 5 }] };
const snap = (over: Partial<RouteSnapshot> = {}): RouteSnapshot => ({
  model: "FMC_ChainTest_P", resolved_document: { title: "FMC_ChainTest_P", path: "Z:\\00_Standards\\04_Families\\_ChainTests\\FMC_ChainTest_P.rvt" }, is_central: false,
  curve_types: [{ id: 10, name: "PVC-U", kind: "pipe", routing: fullRules }, { id: 11, name: "Bare", kind: "pipe", routing: { Segments: [{ index: 0, part_id: 1 }] } }],
  system_types: [{ id: 20, name: "Domestic Cold Water" }], levels: [{ id: 30, name: "Level 1", elevation_mm: 0 }], ...over,
});
const place = (a: Partial<FmcMepRouteArgs> = {}) => args({ action: "place", type_name: "PVC-U", system_type_name: "Domestic Cold Water", level_name: "Level 1", ...a });

test("preview needs no Revit and plans pieces and elbows", async () => {
  let read = false;
  const r = parse(await runFmcMepRoute(args({}), { env, read: async () => { read = true; return {}; } }));
  assert.equal(read, false);
  assert.equal(r.read_only, true);
  assert.ok(r.counts.pieces >= 2);
  assert.ok(r.counts.elbow >= 1);
});

test("an impossible route returns the solver's code and sends nothing", async () => {
  const r = await runFmcMepRoute(args({ route: { start: [0, 0, 3000], goal: [5000, 0, 3000], bounds: { min: [0, -500, 2500], max: [5000, 500, 3500] }, grid_mm: 500, flow: "pressure", max_length_mm: 100 } as never }), { env });
  assert.equal(r.isError, true);
  assert.equal(parse(r).route.code, "FMC-ROUTE-NONE");
});

test("place is a dry run by default, with the resolved type, system type and level", async () => {
  const r = parse(await runFmcMepRoute(place(), { env, guard: guardCfg, read: async () => snap(), apply: async () => { throw new Error("must not apply"); } }));
  assert.equal(r.dry_run, true);
  assert.deepEqual(r.target, { type: "PVC-U", system_type: "Domestic Cold Water", level: "Level 1" });
  assert.equal(r.coverage.ready, true);
});

test("a type with no elbow rule is FMC-NO-FITTING-TYPE before anything is sent", async () => {
  const r = await runFmcMepRoute(place({ type_name: "Bare", dry_run: false, batch_lease: "L1" }), { env, guard: guardCfg, read: async () => snap(), apply: async () => { throw new Error("must not apply"); } });
  assert.equal(r.isError, true);
  const body = parse(r);
  assert.equal(body.code, "FMC-NO-FITTING-TYPE");
  assert.match(body.hint, /modify_model edit_type routing/);
});

test("guard: central, HEBERT HOSTELS and protected paths are refused", async () => {
  const central = parse(await runFmcMepRoute(place({ dry_run: false, batch_lease: "L1" }), { env, guard: guardCfg, read: async () => snap({ is_central: true }) }));
  assert.equal(central.code, "FMC-ROUTE-GUARD");
  const hebert = parse(await runFmcMepRoute(place({ dry_run: false, batch_lease: "L1" }), { env, guard: guardCfg, read: async () => snap({ model: "HEBERT HOSTELS", resolved_document: { title: "HEBERT HOSTELS", path: "" } }) }));
  assert.equal(hebert.code, "FMC-ROUTE-GUARD");
  const prot = parse(await runFmcMepRoute(place({ dry_run: false, batch_lease: "L1" }), { env, guard: guardCfg, read: async () => snap({ resolved_document: { title: "x", path: "Z:\\Projects\\Live\\x.rvt" } }) }));
  assert.equal(prot.code, "FMC-ROUTE-GUARD");
});

test("a real write needs batch_lease; with it the apply body carries ids, pieces and fittings", async () => {
  const noLease = parse(await runFmcMepRoute(place({ dry_run: false }), { env, guard: guardCfg, read: async () => snap() }));
  assert.equal(noLease.code, "FMC-BATCH-LOCKED");
  let sent: Record<string, unknown> = {};
  const r = parse(await runFmcMepRoute(place({ dry_run: false, batch_lease: "L1" }), { env, guard: guardCfg, read: async () => snap(),
    apply: async (b) => { sent = b; return { applied: true, done: [], failed: [], saved: false }; } }));
  assert.equal(r.applied, true);
  assert.equal(r.saved, false);
  assert.equal(sent.type_id, 10);
  assert.equal(sent.system_type_id, 20);
  assert.equal(sent.level_id, 30);
  assert.equal(sent.kind, "pipe");
  assert.ok(Array.isArray(sent.pieces) && (sent.pieces as unknown[]).length >= 2);
  assert.ok(Array.isArray(sent.fittings) && (sent.fittings as unknown[]).length >= 1);
});

test("a missing name is FMC-ROUTE-INPUT", async () => {
  const r = parse(await runFmcMepRoute(place({ system_type_name: "Sanitary" }), { env, guard: guardCfg, read: async () => snap() }));
  assert.equal(r.code, "FMC-ROUTE-INPUT");
  assert.match(r.message, /system_type_name/);
});

test("source scan: no sendRaw; reads fmc_mep_route, writes only fmc_mep_route_apply; C# never writes routing preferences or saves", () => {
  const ts = fs.readFileSync(path.join(here, "..", "..", "src", "tools", "fmc_mep_route.ts"), "utf8");
  assert.ok(!/sendRaw/.test(ts));
  assert.deepEqual([...ts.matchAll(/sendCommand\("([a-z_]+)"/g)].map((m) => m[1]).sort(), ["fmc_mep_route", "fmc_mep_route_apply"]);
  const cs = fs.readFileSync(path.join(here, "..", "..", "..", "commandset", "Services", "Fmc", "FmcMepRouteWork.cs"), "utf8");
  assert.ok(!/AddRule|RemoveRule|PreferredJunctionType\s*=|\.Save\(|SynchronizeWithCentral/.test(cs), "no routing-preference write, no save, no sync");
  assert.ok(/new SubTransaction\(doc\)/.test(cs) && /SetFailuresPreprocessor/.test(cs), "the fmc_conduit pattern");
  const scan = cs.slice(0, cs.indexOf("class FmcMepRouteApplyHandler"));
  assert.ok(!/\bTransaction\b|SubTransaction/.test(scan.replace(/\/\/\/.*$/gm, "")), "the read handler has no transaction");
});
