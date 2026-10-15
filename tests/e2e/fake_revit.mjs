// A stand-in for the Formcraft add-in's socket: answers JSON-RPC commands with sample data, never touches Revit.
// FAKE_MODE=empty answers {} to everything (an empty model, a robustness check); otherwise the fixtures below.
import net from "node:net";
import fs from "node:fs";

const port = Number(process.env.FAKE_PORT || 8099);
const mode = process.env.FAKE_MODE || "rich";
const live = process.env.FAKE_LIVE === "1";
const logFile = process.env.FAKE_LOG;

const doc = live
  ? { title: "F26001-FMC-ZZ-ZZ-M3-A-0001", path: "D:\\Projects\\F26001\\02_Shared\\A\\F26001-FMC-ZZ-ZZ-M3-A-0001.rvt", isFamily: false, isWorkshared: true, isActive: true }
  : { title: "Project1", path: "", isFamily: false, isWorkshared: false, isActive: true };

const fixtures = {
  fmc_document_info: { active: doc, documents: [doc] },
  fmc_analytical_export: { model: doc.title, without_analytical: 1, members: [
    { id: 501, kind: "column", start: [0, 0, 0], end: [0, 0, 3000], section: "C 300x300", b_mm: 300, h_mm: 300, material_class: "Concrete", concrete_grade: "C30/37", steel_grade: "" },
    { id: 502, kind: "column", start: [5000, 0, 0], end: [5000, 0, 3000], section: "C 300x300", b_mm: 300, h_mm: 300, material_class: "Concrete", concrete_grade: "C30/37", steel_grade: "" },
    { id: 503, kind: "beam", start: [0, 0, 3000], end: [5000, 0, 3000], section: "B 230x450", b_mm: 230, h_mm: 450, material_class: "Concrete", concrete_grade: "C30/37", steel_grade: "" }] },
  fmc_selftest_facts: {
    addin: { commit: "test", built: "2026-10-14T00:00:00Z" }, kit_folder: process.env.KIT, documents: [doc],
    commands: ["fmc_document_info"], safe_to_close: true, ribbon: { updates: 3, changes: 1 },
  },
  fmc_build_facts: {
    model: doc.title, elements: 120, params_in_model: { FMC_Keynote_Code: true, FMC_Construction_Status: true, FMC_Trade_Package: false },
    codes: { "B.200_00": { count: 12, area_m2: 140, volume_m3: 28, length_m: 60, category: "Walls" }, "ZZ.NOPE": { count: 2, area_m2: 0, volume_m3: 0, length_m: 0, category: "Generic Models" } },
    status: { Done: 10, "(none)": 110 }, package: { "(none)": 120 }, unmapped: { Furniture: 14 },
  },
  fmc_structural_facts: {
    model: doc.title, members: { columns: 4, framing: 6, foundations: 4 }, no_analytical: [1], no_analytical_count: 1, offset_over_50mm: [], offset_count: 0,
    free_ends: [2], free_end_count: 1, free_ends_checked: true, nothing_below: [3], nothing_below_count: 1,
    fields: [{ name: "FMC_Member_Mark", applies: 14, missing: 14, ids: [1, 2], in_model: false }], load_cases: 0, load_combinations: 0,
    results: [{ id: 9, mark: "B-1-07", type: "230x450", utilisation: 1.12, run: "FEA-03" }], results_count: 1,
  },
  fmc_electrical_facts: {
    model: doc.title, boards: [{ id: 1, name: "MDB", family: "Panel", connected_va: 86000, demand_va: 61000, distribution: "400/230", circuits: 4, fed_by: "", feeder_wire: "" }],
    devices: { ElectricalFixtures: { with_power_connector: 10, on_no_circuit: 2 } }, circuits_without_board: 1,
  },
  fmc_diagram_scan: {
    model: doc.title, levels: [{ id: "lvl-0", name: "Ground Floor", elevation_mm: 0 }],
    diagrams: [{ kind: "e_sld", system: "MDB", nodes: [
      { id: "supply:MDB", kind: "supply", name: "Supply", category: "", family: "", type: "", level: null, params: {} },
      { id: "b-1", kind: "board", name: "MDB", category: "Electrical Equipment", family: "Panel", type: "400A", level: "lvl-0",
        params: { panel_id: "MDB", part_type: "Panelboard", distribution_system: "400/230", ways: 12, mains: "400 A" } },
      { id: "circuit:11", kind: "load", name: "Lighting GF", category: "Lighting Fixtures", family: "", type: "", level: "lvl-0", params: { load_count: 8, apparent_load_va: 640 } }],
      edges: [{ from: "supply:MDB", to: "b-1", kind: "feeder", params: {} },
        { from: "b-1", to: "circuit:11", kind: "circuit", params: { circuit_number: "1", rating: "10 A", poles: 1, cable: null, load_name: "Lighting GF", apparent_load_va: 640, voltage: 230 } }] }],
    gaps: [{ kind: "e_sld", element_id: "circuit:11", message: "Circuit 1 on MDB has no cable (FMC_Cable_Spec or wire size)." }],
  },
  fmc_diagram_draw: (p) => ({ dry_run: p.dry_run !== false,
    views: (p.views || []).map((v) => ({ name: v.name, result: "create", view_id: p.dry_run === false ? "900" : null,
      symbols: (v.items || []).filter((i) => i.t === "symbol").length, lines: (v.items || []).filter((i) => i.t === "line").length,
      texts: (v.items || []).filter((i) => i.t === "text").length, kept_by_hand: 0 })), warnings: [] }),
  fmc_brief_apply: (p) => ({ dry_run: p.dry_run, model: doc.title, levels_created: (p.levels || []).length, plans_created: (p.levels || []).length,
    project_info_set: Object.keys(p.project_info || {}).length, rooms_created: (p.rooms || []).length, room_values_set: 3, families_loaded: 0, notes: [] }),
  fmc_link_facts: { model: doc.title, workshared: doc.isWorkshared, coordinates: { site: "Internal", easting_mm: 0, northing_mm: 0, elevation_mm: 0, angle_deg: 0, crs: "" }, links: [], worksets: [] },
  fmc_workshare_facts: { model: doc.title, workshared: false, worksets: [], warnings: [] },
  fmc_annotation_facts: { model: doc.title, text_types: [], line_patterns: [], dimension_types: [], tag_families: [] },
  fmc_qa_facts: { model: doc.title, warnings: 12,
    views: [{ id: 1, name: "A_GA_00_Ground", type: "FloorPlan", template: false }, { id: 2, name: "Level 1", type: "FloorPlan", template: false }],
    sheets: [{ id: 10, number: "A-0001", name: "Cover", parameters: {} }], types: [{ id: 20, family: "Basic Wall", name: "Generic - 200mm", category: "Walls", bic: "OST_Walls", parameters: {} }],
    families: [{ id: 30, name: "FMC_A_Door_Single", in_place: false }], links: [] },
  fmc_issue_facts: { sheets: [{ id: 10, current_revision: "" }], revisions: [] },
};

const server = net.createServer((sock) => {
  let buf = "";
  // Requests can arrive split across reads or two in one read: take each complete JSON object by counting braces.
  sock.on("data", (d) => {
    buf += d.toString();
    for (;;) {
      let depth = 0, inString = false, escaped = false, end = -1;
      for (let i = 0; i < buf.length; i++) {
        const ch = buf[i];
        if (inString) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') inString = false; continue; }
        if (ch === '"') inString = true;
        else if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) { end = i; break; }
      }
      if (end < 0) return;
      const req = JSON.parse(buf.slice(0, end + 1));
      buf = buf.slice(end + 1);
      const f = mode === "empty" && req.method !== "fmc_document_info" ? {} : fixtures[req.method];
      const result = typeof f === "function" ? f(req.params || {}) : f ?? {};
      if (logFile) fs.appendFileSync(logFile, JSON.stringify({ method: req.method, params: req.params }) + "\n");
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
    }
  });
  sock.on("error", () => {});
});
server.listen(port, "127.0.0.1", () => console.log(`fake revit on ${port} (${mode}${live ? ", live model" : ""})`));
