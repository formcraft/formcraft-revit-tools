import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { filterSystems, routingCoverage, summarise, type SystemsSnapshot } from "./mepsystems.js";
import { runFmcMepSystems, type FmcMepSystemsArgs } from "../tools/fmc_mep_systems.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env, LOCALAPPDATA: fs.mkdtempSync(path.join(os.tmpdir(), "mepsys-")) };
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
const args = (a: Partial<FmcMepSystemsArgs>): FmcMepSystemsArgs => ({ action: "list", domain: "both", name: "", classification: "", sample_limit: 40, ...a } as FmcMepSystemsArgs);

const snap: SystemsSnapshot = {
  model: "F26901-FMC-ZZ-ZZ-M3-M-0001_USER",
  systems: [
    { id: 1, name: "Supply Air 1", kind: "duct", classification: "SupplyAir", base_equipment: { id: 9, name: "AHU 1" }, elements: 40, flow: "600 L/s" },
    { id: 2, name: "Return Air 1", kind: "duct", classification: "ReturnAir", base_equipment: null, elements: 12, flow: null },
    { id: 3, name: "Domestic Cold Water 1", kind: "piping", classification: "DomesticColdWater", elements: 80, fixture_units: "24" },
  ],
  system_count: 3,
  curve_types: [
    { id: 10, name: "Round - Taps", kind: "duct", preferred_junction: "Tap", routing: { Elbows: [{ index: 0, part: "Elbow", part_id: 100 }], Junctions: [{ index: 0, part: "Tap", part_id: 101 }], Transitions: [{ index: 0, part_id: 102 }], Unions: [{ index: 0, part_id: 103 }] } },
    { id: 11, name: "PVC-U", kind: "pipe", routing: { Segments: [{ index: 0, part_id: 200 }], Elbows: [{ index: 0, part_id: 0 }], Caps: [{ index: 0, part_id: 201 }] } },
  ],
};

test("summary and filter", () => {
  const s = summarise(snap);
  assert.equal(s.count, 3);
  assert.deepEqual(s.by_kind, { duct: 2, piping: 1 });
  assert.equal(s.with_flow, 1);
  assert.equal(filterSystems(snap.systems!, { name: "air" }).length, 2);
  assert.equal(filterSystems(snap.systems!, { classification: "domesticcoldwater" }).length, 1);
});

test("routing coverage names the groups with no usable rule", () => {
  const duct = routingCoverage(snap.curve_types![0]);
  assert.equal(duct.ready, true);
  assert.deepEqual(duct.missing, []);
  const pipe = routingCoverage(snap.curve_types![1]);
  assert.equal(pipe.ready, false);
  assert.deepEqual(pipe.missing, ["Elbows", "Junctions", "Transitions", "Unions"], "a rule with no part does not count");
  assert.equal(pipe.caps, true);
});

test("tool: list, types and routing are reads with the right wire body", async () => {
  const bodies: unknown[] = [];
  const io = { env, read: async (b: Record<string, unknown>) => { bodies.push(b); return snap; } };
  const list = parse(await runFmcMepSystems(args({ action: "list", name: "supply" }), io));
  assert.equal(list.read_only, true);
  assert.equal(list.matched, 1);
  assert.equal(list.systems[0].base_equipment.name, "AHU 1");
  const routing = parse(await runFmcMepSystems(args({ action: "routing", domain: "duct" }), io));
  assert.equal(routing.not_ready, 1);
  assert.deepEqual(bodies[1], { domain: "duct", routing: true });
  const failed = await runFmcMepSystems(args({}), { env, read: async () => { throw new Error("no Revit"); } });
  assert.equal(failed.isError, true);
});

test("source scan: read-only, no sendRaw, no transaction, no routing-preference write", () => {
  const ts = fs.readFileSync(path.join(here, "..", "..", "src", "tools", "fmc_mep_systems.ts"), "utf8");
  assert.ok(!/sendRaw/.test(ts));
  assert.deepEqual([...ts.matchAll(/sendCommand\("([a-z_]+)"/g)].map((m) => m[1]), ["fmc_mep_systems"]);
  const cs = fs.readFileSync(path.join(here, "..", "..", "..", "commandset", "Services", "Fmc", "FmcMepSystemsWork.cs"), "utf8");
  assert.ok(!/\bTransaction\b|SubTransaction|TransactionGroup/.test(cs), "no transaction in the read handler");
  assert.ok(!/AddRule|RemoveRule|PreferredJunctionType\s*=/.test(cs), "routing preferences are never written");
});
