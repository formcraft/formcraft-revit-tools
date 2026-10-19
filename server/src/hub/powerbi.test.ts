import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCis } from "../fmc/brief.js";
import type { Register, ReviewItem } from "../fmc/review.js";
import { treeFromBrief, treeQuantities } from "../tree/building.js";
import { link, loadIdentity, packageName, saveIdentity, verifyPackage, writePackage } from "./exchange.js";
import {
  RELATIONSHIPS, TABLES, areaState, clashRows, dataFolderOf, gatewayStatus, identityRows, modelFiles, qaRows, quantityRows, roomRows,
  stableGuid, structuralRows, table, tableCsv, tableTmdl, ticketRows, tmdlName,
} from "./powerbi.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "fmc", "cli.js");
const FIX = path.resolve(HERE, "../../src/fmc/fixtures");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fmc-powerbi-"));

const cis = parseCis(JSON.stringify({
  schema: "fmc-cis/0.1", project: "F26001", levels: [{ name: "00 Ground Floor", elevation_mm: 0 }, { name: "01 First Floor", elevation_mm: 4200 }],
  rooms: [
    { number: "G01", name: "Reception", params: { FMC_Target_Area: 18, FMC_Department: "Outpatients" } },
    { number: "G02", name: "Consult 1", params: { FMC_Target_Area: 12, FMC_Department: "Outpatients" } },
  ],
})).cis!;
const tree = () => treeFromBrief(cis, { wall_type: "W", wall_thickness: 200, ceiling_type: "C", ceiling_height: 2700, corridor_width: 1800,
  level_prefixes: { G: "00 Ground Floor" } }).tree;

function item(over: Partial<ReviewItem>): ReviewItem {
  return { id: "F26001-ISS-0001", title: "Duct through beam", description: "", disciplines: ["M", "S"], lead: "M", owner: "Jane Smith", priority: "High",
    due: "2026-10-10", status: "Open", raised_by: "John Doe", raised_at: "2026-10-01T09:00:00Z", model: "F26001-FMC-ZZ-ZZ-M3-M-0001.rvt", view: "",
    element_ids: [], answers: [{ discipline: "S", by: "Ann Engineer", text: "ok", status: "Open", at: "2026-10-02" }], solution: "", history: [], ...over };
}

test("H2: a room's area against its target: Over, Under or On target past the tolerance, No target without one", () => {
  assert.deepEqual(areaState(20, 18, 10), { off_pct: 11.1, state: "Over" });
  assert.deepEqual(areaState(17, 18, 10), { off_pct: -5.6, state: "On target" });
  assert.deepEqual(areaState(10, 12, 10), { off_pct: -16.7, state: "Under" });
  assert.deepEqual(areaState(10, null, 10), { off_pct: null, state: "No target" });
});

test("H2: Rooms join Revit's rooms to the tree by number; the model's area is checked when there is one; tree-only rooms stay", () => {
  const map = loadIdentity(tmp());
  const fmc = link(map, "revit", "uid-g01");
  const q = treeQuantities(tree()).rows;
  const rows = roomRows({ tree: q, identity: map, tolerancePct: 10, revit: [
    { uniqueId: "uid-g01", number: "g01", name: "Reception", level: "00 Ground Floor", area_m2: 21.004 },
    { uniqueId: "uid-x", number: "X9", name: "Store", level: "00 Ground Floor", area_m2: 4 },
    { uniqueId: "uid-x2", number: "X9", name: "Store 2", level: "00 Ground Floor", area_m2: 5 },
  ] });
  const g01 = rows.find((r) => r.unique_id === "uid-g01")!;
  assert.equal(g01.source, "revit+tree");
  assert.equal(g01.model_area_m2, 21);
  assert.equal(g01.target_m2, 18);
  assert.equal(g01.area_state, "Over", "21 m² in the model against 18 m²: over, whatever the plan says");
  assert.equal(g01.fmc_id, fmc);
  assert.equal(g01.department, "Outpatients", "the tree fills what Revit leaves empty");
  assert.deepEqual(rows.filter((r) => r.room_number === "X9").map((r) => r.room_key), ["X9", "X9#2"], "room keys stay unique");
  const g02 = rows.find((r) => r.room_number === "G02")!;
  assert.equal(g02.source, "tree");
  assert.equal(g02.model_area_m2, null);
  assert.equal(g02.area_state, "On target", "checked on the tree's planned area");
  assert.ok(rows.some((r) => String(r.name).includes("corridor")), "the corridor is a room too");
});

test("H2: Quantities carry only the named columns: a rate on an item never reaches the CSV", () => {
  const items = [{ code: "E10/110", description: "Concrete slab", unit: "m3", group: "Frame", package: "Concrete", category: "Floors", count: 3, qty: 41.5,
    rate: 125, amount: 5187.5 } as any, { code: "F10/200", description: "Brick", unit: "t", group: "Masonry", package: "Brick", category: "Walls", count: 2, qty: null,
    why_no_qty: "t: not measured from the model (the QS measures it)" } as any];
  const csv = tableCsv(table("Quantities"), quantityRows(items));
  assert.equal(csv.split("\r\n")[0], "code,description,unit,bill,package,category,count,qty,why_no_qty");
  assert.ok(!/125|5187/.test(csv), "no rate, no amount");
  assert.match(csv, /F10\/200,Brick,t,Masonry,Brick,Walls,2,,t: not measured/);
  for (const t of TABLES) assert.ok(!t.columns.some((c) => /rate|price|cost|amount/i.test(c.name)), `${t.name} has no money column`);
});

test("H2: Tickets by discipline and priority, with no person's name anywhere (rule 9)", () => {
  const map = loadIdentity(tmp());
  const fmc = link(map, "revit", "uid-duct");
  const reg: Register = { project: "F26001", items: [
    item({ where: { unique_ids: ["uid-duct", "uid-beam"] }, element_ids: [412088], source: "clash", to: "person",
      links: { clash: { test: "M vs S", name: "Clash17" } } }),
    item({ id: "F26001-ISS-0002", status: "Closed", priority: "Low", lead: "A", disciplines: ["A"], due: "" }),
  ] };
  const { tickets, elements } = ticketRows(reg, "2026-10-19", map);
  assert.equal(tickets[0].is_open, 1);
  assert.equal(tickets[0].is_overdue, 1);
  assert.equal(tickets[0].shown_status, "Overdue");
  assert.equal(tickets[0].lead_discipline, "M");
  assert.equal(tickets[0].disciplines, "M;S");
  assert.equal(tickets[0].assigned_to_kind, "person", "the kind of assignee, never who");
  assert.equal(tickets[1].is_open, 0);
  assert.equal(tickets[1].due, null);
  assert.deepEqual(elements.map((e) => [e.unique_id, e.element_id, e.fmc_id]), [["uid-duct", "", fmc], ["uid-beam", "", ""], ["", "412088", ""]]);
  const csv = tableCsv(table("Tickets"), tickets) + tableCsv(table("TicketElements"), elements);
  for (const name of ["Jane Smith", "John Doe", "Ann Engineer"]) assert.ok(!csv.includes(name), `${name} is not exported`);
  for (const t of TABLES) assert.ok(!t.columns.some((c) => /^(owner|raised_by|by|assigned_to|author|person)$/.test(c.name)), `${t.name} has no person column`);
});

test("H2: Clashes keep both Revit elements and the ticket raised for each; Navisworks' 'assigned to' is left out", () => {
  const reg: Register = { project: "F26001", items: [item({ links: { clash: { test: "M vs S", name: "Clash17" } } })] };
  const map = loadIdentity(tmp());
  const fmc = link(map, "revit", "412088");
  const it = (id: string, cat: string, src: string) => ({ name: "x", category: cat, revit_id: id, source: src });
  const rows = clashRows([{ test: "M vs S", rows: [
    { name: "Clash17", status: "New", distance_mm: -40, item1: it("412088", "Ducts", "C:\\M\\F26001-M.nwc"), item2: it("9001", "Structural Framing", "C:\\S\\F26001-S.nwc"), assigned_to: "Jane Smith" } as any,
    { name: "Clash17", status: "Active", distance_mm: -5, item1: it("1", "Ducts", "M.nwc"), item2: it("2", "Pipes", "M.nwc") },
  ] }], reg, map);
  assert.deepEqual(rows.map((r) => r.clash_key), ["M vs S|Clash17", "M vs S|Clash17#2"]);
  assert.equal(rows[0].ticket_id, "F26001-ISS-0001");
  assert.equal(rows[0].item1_fmc_id, fmc);
  assert.equal(rows[0].item1_model, "F26001-M.nwc");
  assert.ok(!tableCsv(table("Clashes"), rows).includes("Jane Smith"));
});

test("H2: Structural results find their element and Formcraft id through the run's bar on the identity map", () => {
  const map = loadIdentity(tmp());
  const fmc = link(map, "revit", "uid-col-1", { kind: "column" });
  link(map, "robot", "FEA-20261018-0930#17", { fmc });
  const rows = structuralRows([{ id: 412088, ned_kn: -812.4, med_knm: 35.1, run: "FEA-20261018-0930" }, { id: 5, ned_kn: 1, med_knm: 2, run: "FEA-20261018-0930" }],
    [{ n: 17, id: 412088 }], map);
  assert.deepEqual(rows[0], { run: "FEA-20261018-0930", element_id: "412088", unique_id: "uid-col-1", fmc_id: fmc, ned_kn: -812.4, med_knm: 35.1 });
  assert.equal(rows[1].fmc_id, "", "a member the run didn't link has no Formcraft id, never a guessed one");
  assert.equal(identityRows(map)[0].robot_id, "FEA-20261018-0930#17");
});

test("H2: QA findings: one row per rule result with a stable key", () => {
  const rows = qaRows([{ id: "R-012", rule: "Views on sheets are named", severity: "Must", state: "Fail", where: "Views", element_ids: [1, 2], fix_hint: "Rename" }], "weekly", "M.rvt");
  assert.deepEqual([rows[0].finding_key, rows[0].element_count, rows[0].element_ids], ["weekly|R-012", 2, "1;2"]);
});

test("H2: the TMDL model: a table per CSV from DataFolder, relationships on columns that exist, measures, the same text every build", () => {
  const files = modelFiles("D:\\P\\01_WIP\\_Exchange\\PowerBI\\latest\\data\\");
  const names = files.map((f) => f.name);
  assert.ok(names.includes("FMC_Project.pbip"));
  for (const t of TABLES) assert.ok(names.includes(`FMC_Project.SemanticModel/definition/tables/${t.name}.tmdl`), t.name);
  const pbip = JSON.parse(files.find((f) => f.name === "FMC_Project.pbip")!.text);
  assert.equal(pbip.artifacts[0].report.path, "FMC_Project.Report");
  const pbir = JSON.parse(files.find((f) => f.name.endsWith("definition.pbir"))!.text);
  assert.equal(pbir.datasetReference.byPath.path, "../FMC_Project.SemanticModel");
  assert.equal(JSON.parse(files.find((f) => f.name.endsWith("definition.pbism"))!.text).version, "4.0");
  const expr = files.find((f) => f.name.endsWith("expressions.tmdl"))!.text;
  assert.match(expr, /^expression DataFolder = "D:\\P\\01_WIP\\_Exchange\\PowerBI\\latest\\data\\" meta \[IsParameterQuery = true, Type = "Text"/m);
  const rooms = tableTmdl(table("Rooms"));
  assert.match(rooms, /^table Rooms\r\n\tlineageTag: [0-9a-f-]{36}\r\n/m);
  assert.match(rooms, /^\tmeasure 'Rooms over target' = CALCULATE\(COUNTROWS\(Rooms\), Rooms\[area_state\] = "Over"\)\r\n\t\tformatString: 0\r\n/m);
  assert.match(rooms, /^\tcolumn model_area_m2\r\n\t\tdataType: double\r\n/m);
  assert.match(rooms, /^\tpartition Rooms = m\r\n\t\tmode: import\r\n\t\tsource =\r\n\t\t\t\tlet\r\n/m);
  assert.match(rooms, /File\.Contents\(DataFolder & "FMC_Rooms\.csv"\), \[Delimiter = ",", Columns = 14, Encoding = 65001/);
  assert.match(rooms, /\{"model_area_m2", type number\}/);
  assert.match(tableTmdl(table("Tickets")), /\{"due", type date\}/);
  const rel = files.find((f) => f.name.endsWith("relationships.tmdl"))!.text;
  for (const r of RELATIONSHIPS) {
    assert.ok(rel.includes(`fromColumn: ${r.from}\r\n\ttoColumn: ${r.to}`), `${r.from} → ${r.to}`);
    for (const ref of [r.from, r.to]) {
      const [t, c] = ref.split(".");
      assert.ok(table(t).columns.some((x) => x.name === c), `${ref} exists`);
    }
  }
  assert.deepEqual(modelFiles("D:\\P\\data\\"), modelFiles("D:\\P\\data\\"), "stable: the same model is the same text");
  assert.equal(stableGuid("a"), stableGuid("a"));
  assert.notEqual(stableGuid("a"), stableGuid("b"));
  assert.equal(tmdlName("Open tickets"), "'Open tickets'");
  assert.equal(tmdlName("ticket_id"), "ticket_id");
  assert.equal(tmdlName("Ann's"), "'Ann''s'");
  for (const t of TABLES) assert.equal(new Set(t.columns.map((c) => c.name)).size, t.columns.length, `${t.name}: unique columns`);
  assert.equal(dataFolderOf("D:\\P\\latest\\"), "D:\\P\\latest\\data\\");
});

test("H2: the gateway to Microsoft's Modeling MCP server is not set up and refuses writes", () => {
  const g = gatewayStatus();
  assert.equal(g.set_up, false);
  assert.equal(g.writes, "refused");
  assert.deepEqual(g.allowed, []);
});

test("X0: a package can hold sub-folders, never outside itself; files can name the package's own folder", () => {
  assert.equal(packageName("data/FMC_Rooms.csv"), "data/FMC_Rooms.csv");
  assert.equal(packageName("a\\b\\c.tmdl"), "a/b/c.tmdl");
  assert.equal(packageName("../../evil.txt"), "evil.txt");
  assert.equal(packageName("C:\\Windows\\evil.txt"), "evil.txt");
  const root = tmp();
  const pkg = writePackage(root, { from: "hub", to: "powerbi", what: "Project data model", files: (dir) => [{ name: "data/a.csv", text: "x\r\n" }, { name: "where.txt", text: dir }] });
  assert.equal(fs.readFileSync(path.join(pkg.dir, "data", "a.csv"), "utf8"), "x\r\n");
  assert.equal(fs.readFileSync(path.join(pkg.dir, "where.txt"), "utf8"), pkg.dir);
  assert.deepEqual(pkg.manifest.files.map((f) => f.name), ["data/a.csv", "where.txt"]);
  assert.deepEqual(verifyPackage(root, pkg.manifest.id), { ok: true, changed: [] });
  fs.writeFileSync(path.join(pkg.dir, "data", "a.csv"), "changed");
  assert.deepEqual(verifyPackage(root, pkg.manifest.id), { ok: false, changed: ["data/a.csv"] });
});

// ---- the tool, through the command line (files only: these never reach Revit or Navisworks) ---------------------------------

function cli(args: unknown, guard: Record<string, unknown>) {
  const dir = tmp();
  const config = path.join(dir, "fmc_guard.json");
  fs.writeFileSync(config, JSON.stringify({ specs_path: path.join(FIX, "pilot_specs.json"), shared_parameter_file: path.join(FIX, "pilot_shared_parameters.txt"),
    reports_dir: dir, ...guard }));
  const r = spawnSync(process.execPath, [CLI, "fmc_powerbi"], { input: JSON.stringify(args), env: { ...process.env, FMC_GUARD_CONFIG: config }, encoding: "utf8" });
  return { code: r.status, body: r.stdout.trim() ? JSON.parse(r.stdout) : null, err: r.stderr };
}

function project() {
  const p = tmp();
  fs.mkdirSync(path.join(p, "01_WIP", "_Tree"), { recursive: true });
  fs.writeFileSync(path.join(p, "01_WIP", "_Tree", "FMC_Recipe_Tree.json"), JSON.stringify(tree()));
  fs.mkdirSync(path.join(p, "01_WIP", "_Reviews"), { recursive: true });
  fs.writeFileSync(path.join(p, "01_WIP", "_Reviews", "FMC_Review_Register.json"), JSON.stringify({ project: "F26001", items: [item({})] }));
  const ex = path.join(p, "01_WIP", "_Exchange");
  const map = loadIdentity(ex);
  link(map, "revit", "uid-a");
  saveIdentity(ex, map);
  return p;
}

test("H2: fmc_powerbi plan lists every table with what it reads now; nothing is written", () => {
  const p = project();
  const r = cli({ action: "plan", project_folder: p }, { write_roots: [path.join(p, "01_WIP")] });
  assert.equal(r.code, 0, r.err);
  const by = Object.fromEntries(r.body.tables.map((t: any) => [t.table, t]));
  assert.equal(by.Tickets.rows_now, 1);
  assert.equal(by.Rooms.rows_now, 3);
  assert.equal(by.Identity.rows_now, 1);
  assert.match(by.Clashes.source, /read at build/);
  assert.ok(!fs.existsSync(path.join(p, "01_WIP", "_Exchange", "Packages")));
});

test("H2: fmc_powerbi build: a dry run, then a package and the latest folder; a second build keeps the person's model", () => {
  const p = project();
  const guard = { write_roots: [path.join(p, "01_WIP")] };
  const dry = cli({ action: "build", project_folder: p, live: false }, guard);
  assert.equal(dry.code, 0, dry.err);
  assert.equal(dry.body.dry_run, true);
  assert.ok(!fs.existsSync(path.join(p, "01_WIP", "_Exchange", "Packages")), "a dry run writes nothing");

  const r = cli({ action: "build", project_folder: p, live: false, dry_run: false }, guard);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.body.latest_model, "written (first time)");
  const latest = path.join(p, "01_WIP", "_Exchange", "PowerBI", "latest");
  for (const t of TABLES) assert.ok(fs.existsSync(path.join(latest, "data", t.file)), t.file);
  const expr = fs.readFileSync(path.join(latest, "FMC_Project.SemanticModel", "definition", "expressions.tmdl"), "utf8");
  assert.ok(expr.includes(`"${path.win32.join(latest, "data")}\\"`), "the latest model reads the latest data");
  const pkgExpr = fs.readFileSync(path.join(r.body.package, "FMC_Project.SemanticModel", "definition", "expressions.tmdl"), "utf8");
  assert.ok(pkgExpr.includes(`"${path.win32.join(r.body.package, "data")}\\"`), "the package's model reads its own data");
  const sources = fs.readFileSync(path.join(latest, "data", "FMC_Sources.csv"), "utf8");
  assert.match(sources, /Clashes,not read,0,Needs Navisworks/);
  assert.match(sources, /QA,not read,0,Needs Revit/);
  assert.equal(fs.readFileSync(path.join(latest, "data", "FMC_Clashes.csv"), "utf8").trim().split(/\r?\n/).length, 1, "an empty table is its header, never a guess");
  assert.ok(!fs.readFileSync(path.join(latest, "data", "FMC_Tickets.csv"), "utf8").includes("Jane Smith"));

  // a person edits the model; the next build keeps it
  const report = path.join(latest, "FMC_Project.Report", "report.json");
  fs.writeFileSync(report, "{\"edited\":true}");
  const again = cli({ action: "build", project_folder: p, live: false, dry_run: false }, guard);
  assert.equal(again.code, 0, again.err);
  assert.match(again.body.latest_model, /^kept/);
  assert.equal(fs.readFileSync(report, "utf8"), "{\"edited\":true}");
  const refresh = cli({ action: "build", project_folder: p, live: false, dry_run: false, refresh_model: true }, guard);
  if (refresh.code === 0) {
    assert.ok(fs.existsSync(path.join(refresh.body.archived, "FMC_Project.Report", "report.json")), "the old model is archived, never deleted");
    assert.notEqual(fs.readFileSync(report, "utf8"), "{\"edited\":true}");
  } else assert.match(refresh.body.reasons[0], /Power BI Desktop is running/);

  const st = cli({ action: "status", project_folder: p }, guard);
  assert.equal(st.code, 0, st.err);
  assert.ok(st.body.packages >= 2);
  assert.equal(st.body.latest.pbip, true);
  assert.equal(st.body.gateway, "not set up");
});

test("H2: fmc_powerbi build refuses outside the write folders and without a project", () => {
  const p = project();
  const r = cli({ action: "build", project_folder: p, live: false, dry_run: false }, { write_roots: [path.join(os.tmpdir(), "elsewhere")] });
  assert.equal(r.code, 1);
  assert.match(r.body.reasons[0], /Not inside an allowed write folder/);
  const none = cli({ action: "build", live: false, dry_run: false }, { write_roots: [path.join(p, "01_WIP")] });
  assert.equal(none.code, 1);
  assert.match(none.body.reasons[0], /project folder/);
});
