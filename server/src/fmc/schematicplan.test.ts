import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";
import {
  elecInputFromTrace, levelYs, planElecDiagrams, planPlumbDiagrams, plumbInputFromTrace,
  type ElecCircuit, type ElecPanel,
} from "./schematicplan.js";
import { FMC_ELEC_DIAGRAMS_SHAPE, runFmcElecDiagrams } from "../tools/fmc_elec_diagrams.js";
import { FMC_PLUMB_DIAGRAMS_SHAPE, runFmcPlumbDiagrams } from "../tools/fmc_plumb_diagrams.js";
import type { DiagramArgs } from "./schematicrun.js";
import type { TraceSnapshot } from "./trace.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function elecArgs(partial: Record<string, unknown>): DiagramArgs {
  return z.object(FMC_ELEC_DIAGRAMS_SHAPE).parse(partial) as DiagramArgs;
}

function plumbArgs(partial: Record<string, unknown>): DiagramArgs {
  return z.object(FMC_PLUMB_DIAGRAMS_SHAPE).parse(partial) as DiagramArgs;
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, unknown> & { isError: boolean } {
  const body = JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>;
  return { ...body, isError: result.isError === true };
}

const mdb: ElecPanel = { id: 1, name: "MDB", level: "Level 0", elevation_mm: 0, building: "A", distribution: "DS_415-240V_3Ph_4W", main_a: 250 };
const db: ElecPanel = { id: 2, name: "DB-L1", level: "Level 1", elevation_mm: 3000, building: "A", distribution: "DS_415-240V_3Ph_4W", supply_from_id: 1, main_a: 125 };
const circuits: ElecCircuit[] = [
  { id: 10, number: "1", panel_id: 1, name: "Lights", rating_a: 10, poles: 1, apparent_va: 800, element_ids: [100] },
  { id: 11, number: "2", panel_id: 1, name: "Feeder", rating_a: 125, poles: 3, apparent_va: 0, element_ids: [2] },
  { id: 12, number: "1", panel_id: 2, name: "Sockets", rating_a: 32, poles: 1, apparent_va: 2000, element_ids: [101] },
];
const levels = [{ name: "Level 0", elevation_mm: 0 }, { name: "Level 1", elevation_mm: 3000 }];

test("electrical plan draws a single-line, a riser and an earthing template", () => {
  const plan = planElecDiagrams({ panels: [mdb, db], circuits, levels, symbols: ["FMC_DI_E_SLD_Board:Board", "FMC_DI_E_SLD_Breaker:MCB"] });
  const kinds = plan.views.map((view) => view.kind).sort();
  assert.deepEqual(kinds, ["e_earthing", "e_power_riser", "e_sld"]);
  const sld = plan.views.find((view) => view.kind === "e_sld")!;
  assert.equal(sld.name, "E-SLD-A");
  assert.ok(sld.items.some((item) => item.t === "text" && (item.text ?? "").includes("10 A") && (item.text ?? "").includes("800 VA")));
  assert.ok(sld.items.some((item) => item.t === "text" && (item.text ?? "").includes("feeder")));
  assert.ok(sld.items.some((item) => item.t === "symbol" && item.family === "FMC_DI_E_SLD_Board"));
  assert.ok(sld.items.some((item) => item.t === "line"));
  const earthing = plan.views.find((view) => view.kind === "e_earthing")!;
  assert.match(earthing.notes.join(" "), /template/i);
  assert.ok(earthing.items.some((item) => item.t === "text" && (item.text ?? "").includes("Main earth terminal")));
});

test("an elevation riser stacks boards by level height", () => {
  const bands = levelYs(levels, "bands");
  const elevated = levelYs(levels, "elevation");
  assert.ok((elevated.get("Level 1") ?? 0) > (elevated.get("Level 0") ?? 0));
  assert.ok((bands.get("Level 1") ?? 0) > (bands.get("Level 0") ?? 0));
  const plan = planElecDiagrams({ panels: [mdb, db], circuits, levels }, "elevation");
  const riser = plan.views.find((view) => view.kind === "e_power_riser")!;
  const at = (name: string) => (riser.items.find((item) => item.t === "text" && (item.text ?? "").startsWith(name))?.at ?? [0, 0])[1];
  assert.ok(at("DB-L1") > at("MDB"));
  assert.match(riser.notes.join(" "), /12 mm/);
});

test("plumbing riser counts fixtures, branches, sizes and a vent, and names a tiny 3D schematic", () => {
  const plan = planPlumbDiagrams({
    systems: [
      { id: 5, name: "Soil", classification: "Sanitary", domain: "piping" },
      { id: 6, name: "Vent stack", classification: "Vent", domain: "piping" },
    ],
    elements: [
      { id: 1, kind: "pipe", system_ids: [5], level: "Level 0", size_mm: 100, x: 0, y: 0, z0: 0, z1: 3000, vertical: true },
      { id: 2, kind: "pipe", system_ids: [5], level: "Level 1", size_mm: 50, x: 2000, y: 0, z0: 3000, z1: 3100, vertical: false },
      { id: 3, kind: "fixture", system_ids: [5], level: "Level 1", name: "WC" },
      { id: 4, kind: "pipe", system_ids: [6], level: "Level 1", size_mm: 50, x: 500, y: 0, z0: 3000, z1: 6000, vertical: true, name: "VP" },
    ],
    levels,
    symbols: [],
    views_3d: [{ id: 9, name: "Tiny schematic", tiny: true }, { id: 10, name: "Working 3D", tiny: false }],
  }, "elevation");
  const soil = plan.views.find((view) => view.kind === "p_riser" && view.system === "Soil")!;
  const blob = soil.items.filter((item) => item.t === "text").map((item) => item.text).join("\n");
  assert.match(blob, /100 mm/);
  assert.match(blob, /fixtures 1/);
  assert.match(blob, /branches 1/);
  assert.match(soil.notes.join(" "), /Tiny schematic/);
  assert.equal(plan.supersedes_3d.length, 1);
  assert.ok(plan.views.some((view) => view.kind === "p_schematic" && view.system === "Soil"));
  const vent = plan.views.find((view) => view.system === "Vent stack" && view.kind === "p_riser")!;
  assert.match(vent.items.map((item) => item.text ?? "").join(" "), /Vent/);
  assert.equal(soil.items.some((item) => item.t === "symbol"), false);
});

test("a trace snapshot can feed both diagram plans", () => {
  const snapshot: TraceSnapshot = {
    electrical: {
      panels: [{ id: 1, name: "MDB", distribution: "DS_415-240V_3Ph_4W", has_supply: true, main_a: 100 }],
      circuits: [{ id: 4, panel_id: 1, number: "3", rating_a: 16, poles: 1, apparent_va: 400, element_ids: [8] }],
      devices: [],
    },
    flow: {
      systems: [{ id: 2, name: "DCW", domain: "piping", classification: "DomesticColdWater", element_ids: [7] }],
      elements: [{ id: 7, name: "CW", kind: "pipe", domain: "piping", system_ids: [2], bbox: [0, 0, 0, 10, 10, 4000] }],
    },
  };
  const elec = planElecDiagrams(elecInputFromTrace(snapshot));
  assert.ok(elec.views.some((view) => view.kind === "e_sld" && view.items.some((item) => (item.text ?? "").includes("16 A"))));
  const plumb = planPlumbDiagrams(plumbInputFromTrace(snapshot));
  assert.ok(plumb.views.some((view) => view.kind === "p_riser"));
});

test("apply without a lease changes nothing, and the commands are registered", async () => {
  let applied = false;
  const elec = textOf(await runFmcElecDiagrams(elecArgs({
    action: "apply", document: "F26901-FMC-ZZ-ZZ-M3-E-0001_USER", dry_run: false, batch_lease: "", riser: "bands",
  }), {
    read: async () => ({ model: "F26901-FMC-ZZ-ZZ-M3-E-0001_USER", resolved_document: { title: "F26901-FMC-ZZ-ZZ-M3-E-0001_USER", path: "C:\\WIP\\E.rvt" }, panels: [mdb], circuits, levels }),
    apply: async () => { applied = true; return { applied: true }; },
  }));
  assert.equal(elec.isError, true);
  assert.equal(elec.code, "FMC-BATCH-LOCKED");
  assert.equal(applied, false);

  const hostels = textOf(await runFmcPlumbDiagrams(plumbArgs({
    action: "apply", document: "HEBERT HOSTELS_USER", dry_run: false, batch_lease: "lease-1", riser: "bands",
    references: { kit: ["FMC-BIM-MAN-001"], standards: ["FMC-BIM-STD-002"], rulebook: ["diagrams show the model"] },
  }), {
    read: async () => ({ model: "HEBERT HOSTELS_USER", resolved_document: { title: "HEBERT HOSTELS_USER", path: "C:\\HEBERT HOSTELS_USER.rvt" }, systems: [], elements: [] }),
  }));
  assert.equal(hostels.isError, true);
  assert.match(String(hostels.message), /HEBERT HOSTELS/);

  const limits = textOf(await runFmcElecDiagrams(elecArgs({ action: "limits", document: "", dry_run: true, batch_lease: "", riser: "bands" })));
  assert.equal(limits.isError, false);
  assert.match(JSON.stringify(limits.api_limits), /SelectPanel/);
  assert.match(JSON.stringify(limits.api_limits), /ViewDrafting/);

  assert.ok(WRITE_COMMANDS.has("fmc_elec_diagrams_apply"));
  assert.ok(WRITE_COMMANDS.has("fmc_plumb_diagrams_apply"));
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_elec_diagrams"));
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_plumb_diagrams"));
  assert.equal(WRITE_COMMANDS.has("fmc_elec_diagrams"), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  const names = new Set(manifest.commands.map((row) => row.commandName));
  for (const name of ["fmc_elec_diagrams", "fmc_elec_diagrams_apply", "fmc_plumb_diagrams", "fmc_plumb_diagrams_apply"]) assert.ok(names.has(name), name);

  const draw = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcDiagramDraw.cs"), "utf8");
  assert.match(draw, /DrawOnce/);
  assert.match(draw, /new Transaction\(doc, "Formcraft schematic diagrams"\)/);
  assert.match(draw, /SubTransaction/);
  const snapshot = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcSchematic.cs"), "utf8");
  assert.match(snapshot, /read_only/);
  assert.match(snapshot, /PipingSystem/);
  assert.match(snapshot, /RBS_PIPE_DIAMETER_PARAM/);
  assert.match(snapshot, /DrawOnce/);
  assert.equal(snapshot.includes(".Save("), false);
  assert.equal(snapshot.includes("SaveAs"), false);
  const circuitSource = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcCircuitWork.cs"), "utf8");
  assert.match(circuitSource, /FMC-CIRCUIT-PANEL-MISMATCH/);
  assert.match(circuitSource, /SelectPanel/);
  assert.match(circuitSource, /NumWires/);
  assert.match(circuitSource, /VoltageLineToLine/);
  assert.match(circuitSource, /VoltageLineToGround/);
  // Revit 2025 has no Connector.Voltage; the connector voltage is read from RBS_ELEC_VOLTAGE.
  assert.match(circuitSource, /RBS_ELEC_VOLTAGE/);
  assert.match(circuitSource, /ElectricalPhaseConfiguration/);
  assert.equal(/item\.Voltage\b/.test(circuitSource), false);
});

test("PD-1/PD-5/PD-6/PD-14/PD-15: systems are picked and paged, drainage shows fall and fixture units, limits are per discipline", async () => {
  const { diagramApiLimits, pickSystems } = await import("./schematicplan.js");
  const systems = Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, name: `Sys ${String(i).padStart(2, "0")}`, classification: "Domestic Cold Water", domain: "piping" }));
  const first = pickSystems(systems);
  assert.equal(first.shown.length, 16);
  assert.equal(first.selection.not_drawn.length, 4);
  assert.equal(first.shown[0].name, "Sys 00");
  const page2 = pickSystems(systems, { offset: 16 });
  assert.deepEqual(page2.shown.map((s) => s.name), ["Sys 16", "Sys 17", "Sys 18", "Sys 19"]);
  const named = pickSystems(systems, { systems: ["sys 03", "105", "Nope"] });
  assert.deepEqual(named.shown.map((s) => s.id), [103, 105]);
  assert.deepEqual(named.selection.not_found, ["Nope"]);
  const plan = planPlumbDiagrams({
    systems: [{ id: 5, name: "Soil", classification: "Sanitary", domain: "piping" }],
    elements: [
      { id: 1, kind: "pipe", system_ids: [5], level: "Level 0", size_mm: 100, vertical: false, slope_pct: 1.5, fixture_units: 12 },
      { id: 2, kind: "pipe", system_ids: [5], level: "Level 0", size_mm: 100, vertical: false, slope_pct: 2.5, fixture_units: 20 },
    ],
    levels, symbols: [],
  });
  assert.match(plan.summary ?? "", /^1 of 1 piping systems drawn/);
  const schematic = plan.views.find((view) => view.kind === "p_schematic")!;
  assert.match(schematic.items.map((item) => item.text ?? "").join(" "), /fall 1.5-2.5 %  FU 20/);
  assert.equal(plan.connector_input?.systems[0].fixture_units, 20);
  assert.deepEqual(plan.connector_input?.systems[0].fall_pct, { min: 1.5, max: 2.5 });
  const tbc = planPlumbDiagrams({ systems: [{ id: 5, name: "Soil", classification: "Sanitary", domain: "piping" }], elements: [], levels, symbols: [] });
  assert.match(tbc.views.find((view) => view.kind === "p_riser")!.notes.join(" "), /Fall TBC/);
  assert.equal(diagramApiLimits("plumb").some((line) => /SelectPanel|poles/i.test(line)), false);
  assert.ok(diagramApiLimits("elec").some((line) => /SelectPanel/.test(line)));
  assert.ok(diagramApiLimits("plumb").some((line) => /PipingSystem/.test(line)));
});
