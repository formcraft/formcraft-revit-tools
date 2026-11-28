import { test } from "node:test";
import assert from "node:assert/strict";
import { runFmcCircuits, checkCircuitLease, circuitResults, type CircuitsIo } from "../tools/fmc_circuits.js";
import { DEFAULT_CONFIG, protectedNameHit, protectedNames } from "./policy.js";
import type { CircuitDevice, CircuitPanel } from "./circuitplan.js";

// Tool research 1-25 (fmc_circuits, approved 28 Nov): the panel step is let through, protected names come from the
// guard config, the lease is checked against the batch board, and a real apply returns created circuit ids.

const DOC = "F26901-FMC-ZZ-ZZ-M3-E-0001_USER";
const panel: CircuitPanel = { id: 10, name: "DB-BQ", level: "Level 1", x: 0, y: 0, z: 0, distribution: "DS_415-240V_3Ph_4W", has_supply: true, is_board: true };
const bare: CircuitPanel = { id: 11, name: "TPN_T1", level: "Level 1", x: 0, y: 0, z: 0, distribution: "", has_supply: false, is_board: true };

function light(id: number, room = "A1"): CircuitDevice {
  return { id, name: "Downlight", category: "Lighting Fixtures", level: "Level 1", room, has_connector: true, system_type: "PowerCircuit", load_w: 12, voltage: 240, poles: 1, x: id, y: 0, z: 0 };
}

function args(over: Record<string, unknown> = {}) {
  return {
    action: "apply" as const, document: DOC, dry_run: false, batch_lease: "lease-1",
    panel: "", pattern: "{board}/{zone}-{type}{n}", load_unit: "W" as const, distribution: "DS_415-240V_3Ph_4W",
    accept_no_supply: [], non_board_ids: [], include_switches: false, supply_from: "", feeder: "", mains_type: "", sample_limit: 20,
    ...over,
  } as Parameters<typeof runFmcCircuits>[0];
}

function io(over: Partial<CircuitsIo> & { panels?: CircuitPanel[]; devices?: CircuitDevice[]; title?: string } = {}): CircuitsIo {
  const title = over.title ?? DOC;
  return {
    bank: {},
    guard: { ...DEFAULT_CONFIG },
    holder: () => ({ lease: "lease-1", client: "bot" }),
    env: { ...process.env, LOCALAPPDATA: process.env.TEMP ?? process.env.TMPDIR ?? "/tmp" },
    read: async () => ({ model: title, resolved_document: { title, path: `C:\\WIP\\${title}.rvt` }, devices: over.devices ?? [light(1)], panels: over.panels ?? [panel], circuits: [] }),
    ...over,
  };
}

const body = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

test("circuits: the panel action is let through when the board has no distribution system (the step that sets it)", async () => {
  let sent: Record<string, unknown> | null = null;
  const dry = await runFmcCircuits(args({ action: "panel", panel: "TPN_T1", dry_run: true }), io({ panels: [bare] }));
  assert.equal(dry.isError, false);
  assert.equal(body(dry).dry_run, true);
  assert.equal(body(dry).panel.id, "TPN_T1");
  assert.doesNotMatch(dry.content[0].text, /FMC-PANEL-NO-DISTRIBUTION\]/);
  const real = await runFmcCircuits(args({ action: "panel", panel: "TPN_T1" }), io({ panels: [bare], apply: async (b) => { sent = b; return { applied: true, created: [], failed: [], unset: [] }; } }));
  assert.equal(real.isError, false);
  assert.equal(sent!.mode, "panel");
  assert.equal(sent!.distribution, "DS_415-240V_3Ph_4W");
});

test("circuits: apply on a board with no distribution system still stops with FMC-PANEL-NO-DISTRIBUTION and changes nothing", async () => {
  let called = false;
  const result = await runFmcCircuits(args(), io({ panels: [bare], apply: async () => { called = true; return { applied: true }; } }));
  assert.equal(result.isError, true);
  assert.equal(body(result).code, "FMC-PANEL-NO-DISTRIBUTION");
  assert.equal(called, false);
});

test("circuits: the panel action without a panel name is refused out loud and names the bare boards", async () => {
  const result = await runFmcCircuits(args({ action: "panel", panel: " " }), io({ panels: [bare] }));
  assert.equal(result.isError, true);
  assert.equal(body(result).code, "FMC-CIRCUIT-PANEL-REQUIRED");
  assert.match(body(result).message, /TPN_T1/);
});

test("circuits: protected project names come from the guard config (default HEBERT HOSTELS; the file's own list wins)", async () => {
  assert.deepEqual(protectedNames(undefined), ["HEBERT HOSTELS"]);
  assert.deepEqual(protectedNames({}), ["HEBERT HOSTELS"]);
  assert.deepEqual(protectedNames({ protected_names: [" OGALA ", ""] }), ["OGALA"]);
  assert.deepEqual(protectedNames({ protected_names: [] }), []);
  assert.equal(protectedNameHit(["HEBERT HOSTELS ELECTRICAL_USER"], ["HEBERT HOSTELS"]), "HEBERT HOSTELS");
  assert.equal(protectedNameHit(["x", "C:\\p\\ogala site.rvt"], ["OGALA"]), "OGALA");
  assert.equal(protectedNameHit([DOC], ["OGALA"]), null);

  const byDefault = await runFmcCircuits(args({ document: "HEBERT HOSTELS_USER" }), io({ title: "HEBERT HOSTELS_USER" }));
  assert.equal(body(byDefault).code, "FMC-CIRCUIT-GUARD");
  const listed = await runFmcCircuits(args(), io({ guard: { ...DEFAULT_CONFIG, protected_names: ["F26901"] } }));
  assert.equal(body(listed).code, "FMC-CIRCUIT-GUARD");
  assert.match(body(listed).message, /F26901 is a protected project/);
  // a file that lists other names no longer refuses HEBERT HOSTELS by a name hidden in code
  let applied = false;
  const other = await runFmcCircuits(args({ document: "HEBERT HOSTELS_USER" }), io({ title: "HEBERT HOSTELS_USER", guard: { ...DEFAULT_CONFIG, protected_names: ["OGALA"] }, holder: () => ({ lease: "lease-1", client: "bot" }), apply: async () => { applied = true; return { applied: true, created: [] }; } }));
  assert.notEqual(body(other).code, "FMC-CIRCUIT-GUARD");
  assert.equal(applied, true);
});

test("circuits: a lease string that is not the active lease on this document is refused before Revit", async () => {
  let called = false;
  const apply = async () => { called = true; return { applied: true }; };
  const nobody = await runFmcCircuits(args(), io({ holder: () => null, apply }));
  assert.equal(body(nobody).code, "FMC-BATCH-LOCKED");
  assert.match(body(nobody).message, /not the active batch lease/);
  const other = await runFmcCircuits(args(), io({ holder: () => ({ lease: "lease-2", client: "other" }), apply }));
  assert.equal(body(other).code, "FMC-BATCH-LOCKED");
  assert.match(body(other).message, /held by another batch lease/);
  const panelToo = await runFmcCircuits(args({ action: "panel", panel: "TPN_T1" }), io({ panels: [bare], holder: () => null, apply }));
  assert.equal(body(panelToo).code, "FMC-BATCH-LOCKED");
  assert.equal(called, false);

  assert.equal(checkCircuitLease("lease-1", [DOC], { holder: (d) => (d === DOC ? { lease: "lease-1", client: "bot" } : null) }), null);
  assert.match(checkCircuitLease("lease-1", ["", " "], { holder: () => null }) ?? "", /No document was resolved/);
  assert.match(checkCircuitLease("lease-1", [DOC], { holder: () => { throw new Error("[FMC-BATCH-LOCKED] two batches"); } }) ?? "", /two batches/);
});

test("circuits: a real apply returns created circuit ids, an undo pointer, and one result per planned circuit", async () => {
  const result = await runFmcCircuits(args(), io({
    devices: [light(1, "A1"), light(2, "A2"), light(3, "A3")],
    apply: async (b) => {
      const planned = b.circuits as Array<{ name: string }>;
      return { applied: true, created: [{ ok: true, id: 9001, name: planned[0].name, panel: "DB-BQ" }], failed: [{ name: planned[1].name, error: "Revit refused" }], created_ids: [9001] };
    },
  }));
  const out = body(result);
  assert.equal(result.isError, false);
  assert.deepEqual(out.created_ids, [9001]);
  assert.equal(out.undo.tool, "fmc_batch_undo");
  assert.equal(out.undo.batch_id, "lease-1");
  assert.equal(out.results.length, out.planned);
  assert.equal(out.counts.created, 1);
  assert.equal(out.counts.failed, 1);
  assert.equal(out.counts.not_reported, out.planned - 2);
  assert.equal(out.partial, true);
  assert.ok(out.results.every((row: { element_ids: number[] }) => row.element_ids.length > 0));
});

test("circuits: circuitResults never drops a planned circuit and ignores switch rows and bad ids", () => {
  const { results, created_ids } = circuitResults(
    [{ name: "A", element_ids: [1] }, { name: "B", element_ids: [2] }, { name: "C", element_ids: [3] }],
    { created: [{ id: 5, name: "A" }, { op: "switch", id: 6, name: "B" }, { id: "x", name: "C" }], failed: [] },
  );
  assert.deepEqual(created_ids, [5]);
  assert.deepEqual(results.map((row) => row.status), ["created", "not_reported", "not_reported"]);
});
