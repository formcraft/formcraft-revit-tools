/**
 * Power BI (docs/PLAN_ENGINEERING_HUB.md, H2): the project's data model as files Power BI reads with no binary step.
 *
 * - Tidy CSV tables, one per subject, with stable keys so they join: room number, Revit UniqueId, ticket id, and the
 *   Formcraft id from the identity map (exchange.ts).
 * - A Power BI Project (PBIP) whose semantic model is TMDL text: each table reads its CSV from one folder parameter
 *   (DataFolder), with the relationships and a few measures. The report is one blank page for a person to build on.
 *
 * Rules: quantities only, never rates (a rate column can't be added: the tables' columns are fixed here). Nothing ranks
 * people (rule 9): tickets are by discipline and priority, never by owner, raiser or answerer; clashes leave out
 * Navisworks' "assigned to". A source that wasn't read is an empty table with a note in Sources, never a guess.
 * Pure: the tool (tools/fmc_powerbi.ts) reads the sources and writes the package.
 */
import crypto from "node:crypto";
import type { BoqItem } from "../fmc/build.js";
import type { ClashRow } from "../fmc/navis.js";
import type { FeaRow } from "../fmc/robot.js";
import type { Register } from "../fmc/review.js";
import { overdue, shownStatus } from "../fmc/review.js";
import type { RuleResult } from "../fmc/rules.js";
import type { QuantityRow } from "../tree/building.js";
import { csvLine } from "../fmc/policy.js";
import type { AppId } from "./apps.js";
import type { IdentityMap } from "./exchange.js";

// ---- the tables ----------------------------------------------------------------------------------------------------------

export type ColType = "text" | "int" | "number" | "date";
export interface ColumnDef { name: string; type: ColType }
export interface MeasureDef { name: string; expr: string; format?: string; description: string }
export interface TableDef { name: string; file: string; description: string; columns: ColumnDef[]; measures: MeasureDef[] }
export type Cell = string | number | null | undefined;
export type Row = Record<string, Cell>;

const cols = (spec: string): ColumnDef[] => spec.trim().split(/\s+/).map((s) => {
  const [name, t] = s.split(":");
  return { name, type: (t as ColType) || "text" };
});

export const TABLES: TableDef[] = [
  { name: "Rooms", file: "FMC_Rooms.csv", description: "One row per room: the model's area (Revit, when it answered), the recipe tree's planned area and the brief's target.",
    columns: cols("room_key room_number name level department model_area_m2:number planned_area_m2:number target_m2:number off_pct:number area_state unique_id fmc_id tree_node source"),
    measures: [
      { name: "Rooms", expr: "COUNTROWS(Rooms)", format: "0", description: "Rooms in the table" },
      { name: "Rooms over target", expr: "CALCULATE(COUNTROWS(Rooms), Rooms[area_state] = \"Over\")", format: "0", description: "Rooms larger than their target area by more than the tolerance" },
      { name: "Rooms under target", expr: "CALCULATE(COUNTROWS(Rooms), Rooms[area_state] = \"Under\")", format: "0", description: "Rooms smaller than their target area by more than the tolerance" },
      { name: "Model area m2", expr: "SUM(Rooms[model_area_m2])", format: "#,0.00", description: "Room area measured in the Revit model" },
      { name: "Target area m2", expr: "SUM(Rooms[target_m2])", format: "#,0.00", description: "Target area from the brief (FMC_Target_Area)" },
    ] },
  { name: "Quantities", file: "FMC_Quantities.csv", description: "Quantities by keynote code joined to the kit's codes (fmc_build). Quantities only: rates are the QS's and never exported.",
    columns: cols("code description unit bill package category count:int qty:number why_no_qty"),
    measures: [
      { name: "Quantity lines", expr: "COUNTROWS(Quantities)", format: "0", description: "Keynote codes with elements in the model" },
      { name: "Measured quantity", expr: "SUM(Quantities[qty])", format: "#,0.00", description: "The quantity in each code's own unit: slice by code or unit, never add units together" },
      { name: "Unmeasured lines", expr: "CALCULATE(COUNTROWS(Quantities), ISBLANK(Quantities[qty]))", format: "0", description: "Codes whose unit the model can't measure (left for the QS)" },
    ] },
  { name: "QA", file: "FMC_QA_Findings.csv", description: "One row per rule result of a QA run on the model (fmc_qa): Fail, Warning, Pass, Not applicable or Not checked.",
    columns: cols("finding_key gate model rule_id rule severity state where element_count:int element_ids fix_hint excepted"),
    measures: [
      { name: "QA fails", expr: "CALCULATE(COUNTROWS(QA), QA[state] = \"Fail\")", format: "0", description: "Rules that failed" },
      { name: "QA warnings", expr: "CALCULATE(COUNTROWS(QA), QA[state] = \"Warning\")", format: "0", description: "Rules with a warning" },
    ] },
  { name: "Tickets", file: "FMC_Tickets.csv", description: "The review register and Mark & Review tickets, by discipline and priority. No person's name is exported (rule 9).",
    columns: cols("ticket_id title status shown_status is_open:int is_overdue:int priority lead_discipline disciplines source assigned_to_kind due:date raised_on:date model sheet view elements:int clash_test clash_name recipe_node family"),
    measures: [
      { name: "Tickets", expr: "COUNTROWS(Tickets)", format: "0", description: "Every ticket in the register" },
      { name: "Open tickets", expr: "CALCULATE(COUNTROWS(Tickets), Tickets[is_open] = 1)", format: "0", description: "Open or in progress: slice by lead_discipline and priority" },
      { name: "Overdue tickets", expr: "CALCULATE(COUNTROWS(Tickets), Tickets[is_overdue] = 1)", format: "0", description: "Open tickets past their due date" },
    ] },
  { name: "TicketElements", file: "FMC_Ticket_Elements.csv", description: "The elements each ticket is on: Revit UniqueId or element id, and the Formcraft id where the identity map has it.",
    columns: cols("ticket_id unique_id element_id fmc_id"), measures: [] },
  { name: "Clashes", file: "FMC_Clashes.csv", description: "Navisworks clash results (when Navisworks with the Formcraft bridge answered), each with both Revit elements and the ticket raised for it.",
    columns: cols("clash_key test name status distance_mm:number item1_element_id item1_category item1_model item1_fmc_id item2_element_id item2_category item2_model item2_fmc_id ticket_id"),
    measures: [
      { name: "Clashes", expr: "COUNTROWS(Clashes)", format: "0", description: "Clash results read" },
      { name: "Clashes open", expr: "CALCULATE(COUNTROWS(Clashes), Clashes[status] IN {\"New\", \"Active\"})", format: "0", description: "New or Active clashes: slice by status, test or model" },
      { name: "Clashes with a ticket", expr: "CALCULATE(COUNTROWS(Clashes), NOT ISBLANK(Clashes[ticket_id]))", format: "0", description: "Clashes a ticket was raised for" },
    ] },
  { name: "Structural", file: "FMC_Structural.csv", description: "Robot results per member from the newest results package (fmc_robot): governing NEd and MEd. Utilisation and approval are the engineer's.",
    columns: cols("run element_id unique_id fmc_id ned_kn:number med_knm:number"),
    measures: [
      { name: "Members analysed", expr: "COUNTROWS(Structural)", format: "0", description: "Members with results" },
      { name: "Largest NEd kN", expr: "MAXX(Structural, ABS(Structural[ned_kn]))", format: "#,0.0", description: "The largest axial force, either sign" },
      { name: "Largest MEd kNm", expr: "MAXX(Structural, ABS(Structural[med_knm]))", format: "#,0.0", description: "The largest bending moment, either sign" },
    ] },
  { name: "Identity", file: "FMC_Identity.csv", description: "The identity map: one Formcraft id per element, with its id in each app.",
    columns: cols("fmc_id kind name revit_id robot_id navisworks_id rhino_id"), measures: [] },
  { name: "Sources", file: "FMC_Sources.csv", description: "Where each table came from, how many rows, and why a table is empty.",
    columns: cols("table_name state rows:int note read_at"), measures: [] },
];

export const table = (name: string): TableDef => {
  const t = TABLES.find((x) => x.name === name);
  if (!t) throw new Error(`No table ${name}`);
  return t;
};

/** The relationships: many side first. Every "one" side key is unique by construction (ticket id, Formcraft id). */
export const RELATIONSHIPS: Array<{ from: string; to: string }> = [
  { from: "TicketElements.ticket_id", to: "Tickets.ticket_id" },
  { from: "TicketElements.fmc_id", to: "Identity.fmc_id" },
  { from: "Clashes.ticket_id", to: "Tickets.ticket_id" },
  { from: "Rooms.fmc_id", to: "Identity.fmc_id" },
  { from: "Structural.fmc_id", to: "Identity.fmc_id" },
];

/** A table as tidy CSV: the header, then its rows in the table's own column order (empty for null). */
export function tableCsv(def: TableDef, rows: Row[]): string {
  return csvLine(def.columns.map((c) => c.name)) + rows.map((r) => csvLine(def.columns.map((c) => {
    const v = r[c.name];
    return v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v)) ? "" : v;
  }))).join("");
}

// ---- the table builders --------------------------------------------------------------------------------------------------

/** An app's ids to Formcraft ids, once (findFmc walks the whole map for each element). */
export function identityIndex(map: IdentityMap, app: AppId): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of Object.values(map.entries)) { const id = e.apps[app]?.id; if (id) out.set(id, e.fmc); }
  return out;
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

/** Over, Under or On target against the target area, by more than the tolerance; No target without one. */
export function areaState(area: number | null, target: number | null, tolerancePct: number): { off_pct: number | null; state: string } {
  if (area === null || !target) return { off_pct: null, state: target ? "No area" : "No target" };
  const off = round(((area - target) / target) * 100, 1);
  return { off_pct: off, state: off > tolerancePct ? "Over" : off < -tolerancePct ? "Under" : "On target" };
}

/** A room as Revit's export_room_data gives it. */
export interface RevitRoom { uniqueId?: string; number?: string; name?: string; level?: string; department?: string; area_m2?: number }

/**
 * Rooms: Revit's rooms (when Revit answered) joined by number to the recipe tree's rooms (planned area, target). The
 * area against the target is the model's when there is one, otherwise the tree's plan. A room only in the tree is kept.
 */
export function roomRows(p: { revit: RevitRoom[] | null; tree: QuantityRow[]; identity: IdentityMap; tolerancePct: number }): Row[] {
  const fmcOf = identityIndex(p.identity, "revit");
  const treeBy = new Map<string, QuantityRow>();
  for (const t of p.tree) if (t.number && !treeBy.has(norm(t.number))) treeBy.set(norm(t.number), t);
  const used = new Set<string>(), keys = new Set<string>();
  const key = (k: string) => { let out = k || "(no number)"; for (let n = 2; keys.has(out); n++) out = `${k}#${n}`; keys.add(out); return out; };
  const rows: Row[] = [];
  for (const r of p.revit ?? []) {
    const t = r.number ? treeBy.get(norm(r.number)) : undefined;
    if (t) used.add(t.node);
    const area = Number.isFinite(r.area_m2) ? round(r.area_m2!, 2) : null;
    const target = t?.target_m2 ?? null;
    const a = areaState(area, target, p.tolerancePct);
    rows.push({ room_key: key(String(r.number ?? "").trim() || String(r.uniqueId ?? "")), room_number: r.number ?? "", name: r.name ?? "", level: r.level ?? t?.level ?? "",
      department: r.department || t?.department || "", model_area_m2: area, planned_area_m2: t?.area_m2 ?? null, target_m2: target, off_pct: a.off_pct, area_state: a.state,
      unique_id: r.uniqueId ?? "", fmc_id: r.uniqueId ? fmcOf.get(r.uniqueId) ?? "" : "", tree_node: t?.node ?? "", source: t ? "revit+tree" : "revit" });
  }
  for (const t of p.tree) {
    if (used.has(t.node)) continue;
    const a = areaState(t.area_m2, t.target_m2, p.tolerancePct);
    rows.push({ room_key: key(t.number || t.node), room_number: t.number, name: t.name, level: t.level, department: t.department, model_area_m2: null,
      planned_area_m2: t.area_m2, target_m2: t.target_m2, off_pct: a.off_pct, area_state: a.state, unique_id: "", fmc_id: "", tree_node: t.node, source: "tree" });
  }
  return rows;
}

/** Quantities by keynote code: the columns are named here, so nothing else (a rate) can travel with them. */
export function quantityRows(items: BoqItem[]): Row[] {
  return items.map((i) => ({ code: i.code, description: i.description, unit: i.unit, bill: i.group, package: i.package, category: i.category,
    count: i.count, qty: i.qty, why_no_qty: i.why_no_qty ?? "" }));
}

/** QA: one row per rule result. */
export function qaRows(results: RuleResult[], gate: string, model: string): Row[] {
  return results.map((r) => ({ finding_key: `${gate}|${r.id}`, gate, model, rule_id: r.id, rule: r.rule, severity: r.severity, state: r.state, where: r.where,
    element_count: r.element_ids.length, element_ids: r.element_ids.join(";"), fix_hint: r.fix_hint, excepted: r.excepted ?? "" }));
}

/**
 * Tickets and the elements they are on. Only what the register says about the work: status, priority, disciplines,
 * dates, where. Never the owner, the raiser, an answer's author or a note (rule 9).
 */
export function ticketRows(reg: Register | null, today: string, identity: IdentityMap): { tickets: Row[]; elements: Row[] } {
  const fmcOf = identityIndex(identity, "revit");
  const tickets: Row[] = [], elements: Row[] = [];
  for (const i of reg?.items ?? []) {
    const uids = i.where?.unique_ids ?? [];
    const ids = (i.element_ids ?? []).map(String);
    tickets.push({ ticket_id: i.id, title: i.title, status: i.status, shown_status: shownStatus(i, today), is_open: i.status === "Open" || i.status === "In progress" ? 1 : 0,
      is_overdue: overdue(i, today) ? 1 : 0, priority: i.priority, lead_discipline: i.lead, disciplines: (i.disciplines ?? []).join(";"), source: i.source ?? "review",
      assigned_to_kind: i.to ?? "", due: i.due || null, raised_on: (i.raised_at ?? "").slice(0, 10) || null, model: i.model ?? "", sheet: i.sheet ?? "",
      view: i.view ?? i.where?.view ?? "", elements: uids.length || ids.length, clash_test: i.links?.clash?.test ?? "", clash_name: i.links?.clash?.name ?? "",
      recipe_node: i.links?.recipe_node ?? "", family: i.links?.family ?? "" });
    const seen = new Set<string>();
    for (const u of uids) if (!seen.has(u)) { seen.add(u); elements.push({ ticket_id: i.id, unique_id: u, element_id: "", fmc_id: fmcOf.get(u) ?? "" }); }
    for (const e of ids) if (!seen.has(e)) { seen.add(e); elements.push({ ticket_id: i.id, unique_id: "", element_id: e, fmc_id: fmcOf.get(e) ?? "" }); }
  }
  return { tickets, elements };
}

/** Clashes from every test read, each with the ticket raised for it (fmc_review's clash tickets keep test and name). */
export function clashRows(tests: Array<{ test: string; rows: ClashRow[] }>, reg: Register | null, identity: IdentityMap): Row[] {
  const fmcOf = identityIndex(identity, "revit");
  const ticketOf = new Map<string, string>();
  for (const i of reg?.items ?? []) if (i.links?.clash) ticketOf.set(`${norm(i.links.clash.test)}|${norm(i.links.clash.name)}`, i.id);
  const model = (s: string) => (s || "").split(/[\\/]/).pop() ?? "";
  const keys = new Set<string>();
  const out: Row[] = [];
  for (const t of tests) for (const r of t.rows) {
    let k = `${t.test}|${r.name}`;
    for (let n = 2; keys.has(k); n++) k = `${t.test}|${r.name}#${n}`;
    keys.add(k);
    const a = r.item1 ?? ({} as ClashRow["item1"]), b = r.item2 ?? ({} as ClashRow["item2"]);
    out.push({ clash_key: k, test: t.test, name: r.name, status: r.status, distance_mm: Number.isFinite(r.distance_mm) ? r.distance_mm : null,
      item1_element_id: a.revit_id ?? "", item1_category: a.category ?? "", item1_model: model(a.source), item1_fmc_id: a.revit_id ? fmcOf.get(a.revit_id) ?? "" : "",
      item2_element_id: b.revit_id ?? "", item2_category: b.category ?? "", item2_model: model(b.source), item2_fmc_id: b.revit_id ? fmcOf.get(b.revit_id) ?? "" : "",
      ticket_id: ticketOf.get(`${norm(t.test)}|${norm(r.name)}`) ?? "" });
  }
  return out;
}

/**
 * Robot results: each member's NEd and MEd from the results package, found on the identity map through the run's bar
 * (<run>#<bar>, from the run's own bar list), so a member joins its Revit element and Formcraft id.
 */
export function structuralRows(rows: FeaRow[], bars: Array<{ n: number; id: number }> | null, identity: IdentityMap): Row[] {
  const fmcOfBar = identityIndex(identity, "robot");
  const barOf = new Map<number, number>((bars ?? []).map((b) => [b.id, b.n]));
  return rows.map((r) => {
    const n = barOf.get(r.id);
    const fmc = n !== undefined ? fmcOfBar.get(`${r.run}#${n}`) ?? "" : "";
    const revit = fmc ? identity.entries[fmc]?.apps.revit?.id ?? "" : "";
    return { run: r.run, element_id: String(r.id), unique_id: revit && !/^\d+$/.test(revit) ? revit : "", fmc_id: fmc, ned_kn: r.ned_kn, med_knm: r.med_knm };
  });
}

export function identityRows(map: IdentityMap): Row[] {
  return Object.values(map.entries).sort((a, b) => a.fmc.localeCompare(b.fmc)).map((e) => ({ fmc_id: e.fmc, kind: e.kind ?? "", name: e.name ?? "",
    revit_id: e.apps.revit?.id ?? "", robot_id: e.apps.robot?.id ?? "", navisworks_id: e.apps.navisworks?.id ?? "", rhino_id: e.apps.rhino?.id ?? "" }));
}

/** What became of one source: read (with its rows), or empty and why. */
export interface SourceNote { table: string; state: "read" | "empty" | "not read"; note: string }

export function sourceRows(notes: SourceNote[], rows: Record<string, Row[]>, readAt: string): Row[] {
  return notes.map((n) => ({ table_name: n.table, state: n.state, rows: rows[n.table]?.length ?? 0, note: n.note, read_at: readAt }));
}

// ---- the Power BI Project (PBIP) with a TMDL semantic model -------------------------------------------------------------

export const PROJECT = "FMC_Project";
export const DATA_DIR = "data";

/** A stable GUID from a name, so the same model is the same text on every build (lineage tags, relationship names). */
export function stableGuid(name: string): string {
  const h = crypto.createHash("sha1").update(`fmc-powerbi|${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** A TMDL name: as it is when it is a plain identifier, otherwise in single quotes (a quote doubled). */
export function tmdlName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

const DATA_TYPE: Record<ColType, string> = { text: "string", int: "int64", number: "double", date: "dateTime" };
const M_TYPE: Record<ColType, string> = { text: "type text", int: "Int64.Type", number: "type number", date: "type date" };
const T = "\t";

/** A table's Power Query: its CSV from DataFolder, headers promoted, empty cells as null, typed in en-US (dots for decimals). */
export function tableM(def: TableDef): string[] {
  const types = def.columns.map((c) => `{"${c.name}", ${M_TYPE[c.type]}}`).join(", ");
  return [
    "let",
    `    Source = Csv.Document(File.Contents(DataFolder & "${def.file}"), [Delimiter = ",", Columns = ${def.columns.length}, Encoding = 65001, QuoteStyle = QuoteStyle.Csv]),`,
    "    Headers = Table.PromoteHeaders(Source, [PromoteAllScalars = true]),",
    "    Blanks = Table.ReplaceValue(Headers, \"\", null, Replacer.ReplaceValue, Table.ColumnNames(Headers)),",
    `    Typed = Table.TransformColumnTypes(Blanks, {${types}}, "en-US")`,
    "in",
    "    Typed",
  ];
}

export function tableTmdl(def: TableDef): string {
  const L: string[] = [];
  L.push(`/// ${def.description}`, `table ${tmdlName(def.name)}`, `${T}lineageTag: ${stableGuid(`table|${def.name}`)}`, "");
  for (const m of def.measures) {
    L.push(`${T}/// ${m.description}`, `${T}measure ${tmdlName(m.name)} = ${m.expr}`);
    if (m.format) L.push(`${T}${T}formatString: ${m.format}`);
    L.push(`${T}${T}lineageTag: ${stableGuid(`measure|${def.name}|${m.name}`)}`, "");
  }
  for (const c of def.columns) {
    const numeric = c.type === "int" || c.type === "number";
    L.push(`${T}column ${tmdlName(c.name)}`, `${T}${T}dataType: ${DATA_TYPE[c.type]}`);
    if (c.type === "date") L.push(`${T}${T}formatString: yyyy-mm-dd`);
    L.push(`${T}${T}lineageTag: ${stableGuid(`column|${def.name}|${c.name}`)}`, `${T}${T}summarizeBy: ${numeric ? "sum" : "none"}`, `${T}${T}sourceColumn: ${c.name}`, "");
  }
  L.push(`${T}partition ${tmdlName(def.name)} = m`, `${T}${T}mode: import`, `${T}${T}source =`, ...tableM(def).map((l) => `${T}${T}${T}${T}${l}`), "");
  return L.join("\r\n");
}

/** An M text literal: quotes doubled. A Windows path's backslashes need nothing (M has no backslash escapes). */
const mText = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** The folder the tables read from, ending in a backslash, as the DataFolder parameter. */
export function dataFolderOf(root: string): string {
  return `${root.replace(/[\\/]+$/, "")}\\${DATA_DIR}\\`;
}

/**
 * The PBIP files, relative to the folder they go in: the .pbip, the semantic model (TMDL) and a one-page blank report.
 * dataFolder is the absolute folder of the CSVs (DataFolder in Power BI: Transform data › Edit parameters changes it).
 */
export function modelFiles(dataFolder: string, tables: TableDef[] = TABLES): Array<{ name: string; text: string }> {
  const sm = `${PROJECT}.SemanticModel`, rp = `${PROJECT}.Report`;
  const json = (o: unknown) => JSON.stringify(o, null, 2) + "\r\n";
  const model = [
    "model Model",
    `${T}culture: en-US`,
    `${T}defaultPowerBIDataSourceVersion: powerBI_V3`,
    `${T}sourceQueryCulture: en-US`,
    `${T}dataAccessOptions`,
    `${T}${T}legacyRedirects`,
    `${T}${T}returnErrorValuesAsNull`,
    "",
    `${T}annotation __PBI_TimeIntelligenceEnabled = 0`,
    "",
  ].join("\r\n");
  const expressions = [
    "/// The folder holding the Formcraft CSV tables (ends in a backslash). The stable 'latest' folder by default.",
    `expression DataFolder = ${mText(dataFolder)} meta [IsParameterQuery = true, Type = "Text", IsParameterQueryRequired = true]`,
    `${T}lineageTag: ${stableGuid("expression|DataFolder")}`,
    "",
    `${T}annotation PBI_ResultType = Text`,
    "",
  ].join("\r\n");
  const rels = RELATIONSHIPS.map((r) => {
    const [ft, fc] = r.from.split("."), [tt, tc] = r.to.split(".");
    return [`relationship ${stableGuid(`rel|${r.from}|${r.to}`)}`, `${T}fromColumn: ${tmdlName(ft)}.${tmdlName(fc)}`, `${T}toColumn: ${tmdlName(tt)}.${tmdlName(tc)}`, ""].join("\r\n");
  }).join("\r\n");
  const report = {
    config: JSON.stringify({ version: "5.43", themeCollection: {}, activeSectionIndex: 0 }),
    layoutOptimization: 0,
    resourcePackages: [],
    sections: [{ config: "{}", displayName: "Formcraft project", displayOption: 1, filters: "[]", height: 720, name: "ReportSection", ordinal: 0, visualContainers: [], width: 1280 }],
  };
  return [
    { name: `${PROJECT}.pbip`, text: json({ $schema: "https://developer.microsoft.com/json-schemas/fabric/pbip/pbipProperties/1.0.0/schema.json", version: "1.0",
      artifacts: [{ report: { path: rp } }], settings: { enableAutoRecovery: true } }) },
    { name: `${sm}/definition.pbism`, text: json({ $schema: "https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json",
      version: "4.0", settings: {} }) },
    { name: `${sm}/definition/database.tmdl`, text: `database\r\n${T}compatibilityLevel: 1567\r\n` },
    { name: `${sm}/definition/model.tmdl`, text: model },
    { name: `${sm}/definition/expressions.tmdl`, text: expressions },
    { name: `${sm}/definition/relationships.tmdl`, text: rels },
    ...tables.map((t) => ({ name: `${sm}/definition/tables/${t.name}.tmdl`, text: tableTmdl(t) })),
    { name: `${rp}/definition.pbir`, text: json({ $schema: "https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/1.0.0/schema.json",
      version: "1.0", datasetReference: { byPath: { path: `../${sm}` } } }) },
    { name: `${rp}/report.json`, text: json(report) },
  ];
}

/** The tables' CSV files under data/. */
export function dataFiles(rows: Record<string, Row[]>, tables: TableDef[] = TABLES): Array<{ name: string; text: string }> {
  return tables.map((t) => ({ name: `${DATA_DIR}/${t.file}`, text: tableCsv(t, rows[t.name] ?? []) }));
}

export function readme(dataFolder: string, built: string): string {
  return [
    "Formcraft project data model for Power BI (fmc_powerbi, hub step H2)",
    `Built ${built}. The tables read their CSV files from: ${dataFolder}`,
    "",
    "Open FMC_Project.pbip in Power BI Desktop, then Refresh. To read another folder: Transform data > Edit parameters > DataFolder",
    "(end it with a backslash). data\\FMC_Sources.csv says where each table came from and why a table is empty.",
    "Quantities only (no rates). Tickets are by discipline and priority; no person's name is in these files.",
    "",
  ].join("\r\n");
}

// ---- the gateway to Microsoft's Power BI Modeling MCP server (design only) ----------------------------------------------

/**
 * The gateway is not set up: Microsoft's Power BI Modeling MCP server is in preview and its package and command are to
 * be confirmed before the hub starts it (docs/HUB.md, "Power BI"). When it is set up it passes on only these read
 * operations; every write is refused until the owner decides otherwise.
 */
export const GATEWAY_ALLOWED: string[] = [];

export function gatewayStatus(): { set_up: false; state: string; allowed: string[]; writes: "refused"; note: string } {
  return { set_up: false, state: "not set up", allowed: GATEWAY_ALLOWED, writes: "refused",
    note: "The gateway to Microsoft's Power BI Modeling MCP server (preview) is designed, not built: its package and command are to be confirmed first (docs/HUB.md). The data model works without it." };
}
