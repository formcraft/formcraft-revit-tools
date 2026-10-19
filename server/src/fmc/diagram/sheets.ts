import { DIAGRAM_KINDS, DiagramKind, DrawView, ScanResult } from "./contract.js";
import { itemBox } from "./geometry.js";
import { Plan } from "./layout.js";
import { DEFAULT_DIAGRAM_KIT, DiagramKit } from "./symbols.js";
import { parseCsv } from "../ceiling/drawings.js";

/**
 * Line diagram sheets and Gate D (LD5, step E2 of docs/PLAN_ENGINEERING_SERVICES.md). Pure: no Revit, no files.
 *
 *  - diagramSheets: the kit's Sheet Register rows that hold diagrams (a drafting SLD or schematic view template in Placed,
 *    or a name that says single-line, riser, schematic or long section), each with the diagram kinds that go on it;
 *  - sheetPlan: which drafting views go on which register sheet, packed into the kit's A1 drawing area (SHT-013, SHT-014)
 *    in paper mm; a view that doesn't fit is left off and listed, never put on an invented sheet number;
 *  - gateD: each drawn diagram (its FMC_DiagramSource keys) against a fresh scan and plan.
 */

/** The drainage long section (civil): a sheet kind of its own, not drawn yet (the scan has no inverts, lengths or manholes). */
export const DRAINAGE_LONG = "p_drainage_long" as const;
export type SheetKind = DiagramKind | typeof DRAINAGE_LONG;

/** Why the drainage long section stays TBC: what the scan would need to read (none of it is read today). */
export const DRAINAGE_LONG_MISSING = [
  "pipe invert levels at each end (Revit's Start / End Invert Elevation): fmc_diagram_scan reads only size and system",
  "pipe lengths and gradients (Length, Slope) along each run",
  "manholes and inspection chambers with cover and invert levels: no node kind for them, and site drainage (C) structures aren't scanned",
  "ground levels along the run (the toposolid or survey points) for the ground line",
];

export interface RegisterSheet { number: string; name: string; role: string; scale: string; placed: string; kinds: SheetKind[] }
export interface UnmappedSheet { number: string; name: string; why: string }

const DIAGRAM_TEMPLATE = /VT_[A-Z]+_Drafting_(SLD|Schematic)/i;
const DIAGRAM_WORDS = /single[- ]line|\briser\b|schematic|long section|diagram/i;

/** Which diagram kinds a register row holds, from its name (and role): nothing guessed beyond these words. */
function kindsFor(role: string, name: string): SheetKind[] {
  const n = name.toLowerCase();
  const out: SheetKind[] = [];
  const add = (...k: SheetKind[]) => { for (const x of k) if (!out.includes(x)) out.push(x); };
  if (/single[- ]line/.test(n)) add("e_sld");
  if (/\briser\b/.test(n)) {
    if (/fire alarm/.test(n)) add("e_fa_riser");
    else if (/\belv\b|security|data/.test(n)) add("e_elv_riser");
    else if (/fire|sprinkler|hydrant/.test(n)) add("fp_schematic");
    else if (/water/.test(n)) add("p_water");
    else if (/control|bms/.test(n)) add("m_controls");
    else if (role === "E") add("e_power_riser", "e_fa_riser", "e_elv_riser");
  }
  if (/long section/.test(n) && /drain/.test(n)) add(DRAINAGE_LONG);
  if (/schematic|diagram/.test(n)) {
    if (/earthing|bonding|lightning/.test(n)) add("lp_schematic");
    if (/water/.test(n)) add("p_water");
    if (/drainage/.test(n) && !/long section/.test(n)) add("p_drainage");
    if (/fire (fighting|protection)|sprinkler/.test(n)) add("fp_schematic");
    if (/fire alarm/.test(n)) add("e_fa_riser");
    if (/refrigerant/.test(n)) add("m_refrigerant");
    if (/control|bms/.test(n)) add("m_controls");
  }
  return out;
}

/** The register's diagram sheets (Role,Discipline,SheetNumber,SheetName,Series,Scale,Core,IssueSet,Placed). */
export function diagramSheets(csv: string): { sheets: RegisterSheet[]; unmapped: UnmappedSheet[] } {
  const rows = parseCsv(csv);
  const head = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const c = (k: string) => head.indexOf(k);
  const [cR, cN, cName, cScale, cPlaced] = [c("role"), c("sheetnumber"), c("sheetname"), c("scale"), c("placed")];
  const sheets: RegisterSheet[] = [], unmapped: UnmappedSheet[] = [];
  if (cN < 0 || cName < 0) return { sheets, unmapped };
  for (const r of rows.slice(1)) {
    const number = (r[cN] ?? "").trim(), name = (r[cName] ?? "").trim(), placed = cPlaced < 0 ? "" : (r[cPlaced] ?? "").trim();
    if (!number) continue;
    const byTemplate = DIAGRAM_TEMPLATE.test(placed), byName = DIAGRAM_WORDS.test(name);
    if (!byTemplate && !byName) continue;
    const role = cR < 0 ? number.split("-")[0] : (r[cR] ?? "").trim();
    const kinds = kindsFor(role, name);
    if (!kinds.length) {
      unmapped.push({ number, name, why: byTemplate ? `placed with ${placed} but its name names no diagram fmc_diagram draws (a detail sheet)` : "its name names no diagram fmc_diagram draws" });
      continue;
    }
    sheets.push({ number, name, role, scale: cScale < 0 ? "" : (r[cScale] ?? "").trim(), placed, kinds });
  }
  return { sheets, unmapped };
}

/** The sheet a kind goes on: the first row of the kind's own role, else the first row that holds it. */
export function sheetForKind(kind: SheetKind, sheets: RegisterSheet[]): RegisterSheet | null {
  const role = kind === DRAINAGE_LONG ? "P" : kind.split("_")[0].toUpperCase();
  const holding = sheets.filter((s) => s.kinds.includes(kind));
  return holding.find((s) => s.role.toUpperCase() === role) ?? holding[0] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// The sheet frame (the kit's sheets rulebook)

export interface DiagramFrame { title_block: string; origin: [number, number]; area: [number, number] }

/** The kit's sheet layout before the rulebook is read (FMC_Rulebook_Sheets.json: SHT-011 to SHT-014, A1 landscape). */
export const DEFAULT_FRAME: DiagramFrame = { title_block: "FMC_TitleBlock : A1", origin: [20, 10], area: [681, 574] };

/**
 * The A1 drawing area from the sheets rulebook: SHT-011 (the title block family and its A1 type), SHT-012 (A1 default),
 * SHT-013 (margins) and SHT-014 (drawing area). The default frame with the reason when the rulebook lacks one.
 */
export function a1Frame(rulebook: unknown): { frame: DiagramFrame; problem: string } {
  const rules = (rulebook && typeof rulebook === "object" ? (rulebook as Record<string, unknown>).rules : null) as Array<Record<string, any>> | null;
  const p = (id: string) => rules?.find((r) => r.id === id)?.check?.params as Record<string, any> | undefined;
  const tb = p("SHT-011"), size = p("SHT-012"), margin = p("SHT-013"), area = p("SHT-014");
  const family = typeof tb?.family === "string" ? tb.family : "";
  const types: string[] = Array.isArray(tb?.types) ? tb.types : [];
  const type = typeof size?.default === "string" ? size.default : "A1";
  const a = area?.drawing_area_mm;
  if (!family || !types.includes(type) || !Array.isArray(a) || a.length !== 2 || typeof margin?.margin_left_mm !== "number" || typeof margin?.margin_other_mm !== "number")
    return { frame: DEFAULT_FRAME, problem: "The sheets rulebook (SHT-011 to SHT-014) doesn't give the title block, margins and drawing area: the A1 defaults are used" };
  return { frame: { title_block: `${family} : ${type}`, origin: [margin.margin_left_mm, margin.margin_other_mm], area: [Number(a[0]), Number(a[1])] }, problem: "" };
}

// ---------------------------------------------------------------------------------------------------------------
// Views onto sheets

/** A view's extent on paper (mm): every item, with symbols and texts by their boxes. */
export function viewExtent(view: DrawView, kit: DiagramKit = DEFAULT_DIAGRAM_KIT): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const take = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const i of view.items) {
    if (i.t === "line") { for (const p of i.points) take(p[0], p[1]); continue; }
    const b = itemBox(i, kit);
    if (b) { take(b.x0, b.y0); take(b.x1, b.y1); } else take(i.at[0], i.at[1]);
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 0, y1: 0 };
}

/** size_mm: the viewport on paper; a title band (TITLE mm) is kept free below it. */
export interface PlacedView { name: string; kind: DiagramKind; size_mm: [number, number]; center_mm: [number, number]; warning?: string }
export interface PlannedSheet { number: string; name: string; title_block: string; kinds: SheetKind[]; views: PlacedView[]; left_off: Array<{ view: string; why: string }> }
export interface SheetPlan {
  sheets: PlannedSheet[];
  /** Diagram kinds with views but no sheet in the register. */
  no_sheet: Array<{ kind: DiagramKind; views: string[] }>;
  /** Sheet kinds the register asks for that aren't drawn (the drainage long section), with what is missing. */
  tbc: Array<{ kind: SheetKind; sheets: string[]; missing: string[] }>;
  unmapped: UnmappedSheet[];
  kit_change_requests: string[];
}

const GAP = 10;      // mm between viewports
const TITLE = 12;    // mm under each viewport for its title

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Which views go on which register sheet, and where: rows of viewports from the top left of the drawing area, in the
 * plan's order (the diagram kinds' order, then the view names). Centres are mm from the sheet's lower-left corner.
 */
export function sheetPlan(plan: Plan, register: { sheets: RegisterSheet[]; unmapped: UnmappedSheet[] }, frame: DiagramFrame = DEFAULT_FRAME,
  kit: DiagramKit = DEFAULT_DIAGRAM_KIT, only: string[] = []): SheetPlan {
  const want = new Set(only.map((s) => s.toLowerCase()));
  const views = plan.views.map((v) => v.view).filter((v) => !want.size || want.has(v.name.toLowerCase()));
  const out: SheetPlan = { sheets: [], no_sheet: [], tbc: [], unmapped: register.unmapped, kit_change_requests: [] };
  const byNumber = new Map<string, PlannedSheet>();
  const sheetOf = (s: RegisterSheet) => {
    let p = byNumber.get(s.number);
    if (!p) { p = { number: s.number, name: s.name, title_block: frame.title_block, kinds: s.kinds, views: [], left_off: [] }; byNumber.set(s.number, p); }
    return p;
  };
  const order = (k: string) => DIAGRAM_KINDS.indexOf(k as DiagramKind);
  // every register diagram sheet is listed, even before anything is drawn for it
  for (const s of register.sheets) if (s.kinds.some((k) => k !== DRAINAGE_LONG)) sheetOf(s);
  const queue = new Map<string, DrawView[]>();
  for (const v of views) {
    const s = sheetForKind(v.kind, register.sheets);
    if (!s) {
      const e = out.no_sheet.find((x) => x.kind === v.kind) ?? (out.no_sheet.push({ kind: v.kind, views: [] }), out.no_sheet[out.no_sheet.length - 1]);
      e.views.push(v.name);
      continue;
    }
    sheetOf(s);
    (queue.get(s.number) ?? (queue.set(s.number, []), queue.get(s.number)!)).push(v);
  }
  const [ox, oy] = frame.origin, [aw, ah] = frame.area;
  for (const [number, list] of queue) {
    const sheet = byNumber.get(number)!;
    list.sort((a, b) => order(a.kind) - order(b.kind) || a.name.localeCompare(b.name));
    let x = ox, top = oy + ah, rowH = 0;
    for (const v of list) {
      const e = viewExtent(v, kit);
      const w = e.x1 - e.x0, h = e.y1 - e.y0 + TITLE;
      if (x > ox && x + w > ox + aw) { x = ox; top -= rowH + GAP; rowH = 0; }
      const tooBig = w > aw || h > ah;
      if (top - h < oy && !(tooBig && sheet.views.length === 0)) {
        sheet.left_off.push({ view: v.name, why: tooBig ? `bigger than the drawing area (${r1(w)} × ${r1(h)} mm on a ${aw} × ${ah} mm area)` : `no room left on ${number}` });
        continue;
      }
      const placed: PlacedView = { name: v.name, kind: v.kind, size_mm: [r1(w), r1(h - TITLE)], center_mm: [r1(x + w / 2), r1(top - (h - TITLE) / 2)] };
      if (tooBig) placed.warning = `${v.name} is bigger than the drawing area (${r1(w)} × ${r1(h)} mm): a person rearranges or splits it`;
      sheet.views.push(placed);
      x += w + GAP;
      rowH = Math.max(rowH, h);
    }
    if (sheet.left_off.length)
      out.kit_change_requests.push(`${number} ${sheet.name}: ${sheet.left_off.length} view(s) don't fit (${sheet.left_off.map((l) => l.view).join(", ")}). ` +
        "Add a continuation sheet for it to the Sheet Register (03_Master_Data\\FMC_Sheet_Register.csv); the tool never invents a sheet number");
  }
  for (const n of out.no_sheet)
    out.kit_change_requests.push(`No Sheet Register row holds the ${n.kind} diagram (${n.views.join(", ")}): add one (03_Master_Data\\FMC_Sheet_Register.csv) so its views go on a sheet`);
  const long = register.sheets.filter((s) => s.kinds.includes(DRAINAGE_LONG));
  if (long.length) out.tbc.push({ kind: DRAINAGE_LONG, sheets: long.map((s) => `${s.number} ${s.name}`), missing: DRAINAGE_LONG_MISSING });
  out.sheets = [...byNumber.values()].sort((a, b) => a.number.localeCompare(b.number));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Gate D: each drawn diagram against a fresh scan

/** What fmc_diagram_drawn reports per drafting view that holds items this tool drew. */
export interface DrawnView {
  name: string;
  view_id: string | null;
  /** FMC_DiagramSource keys of the view's items: "view|source_id or index|t". */
  keys: string[];
  tbc_texts: number;
  kept_by_hand: number;
  sheets: string[];
}

export type GateState = "Pass" | "Warn" | "Fail" | "Not checked";
export interface GateLine { check: string; state: GateState; detail: string }
export interface GateView { view: string; state: GateState; drawn: boolean; sheet: string; missing: string[]; gone: string[]; tbc_drawn: number; tbc_planned: number; kept_by_hand: number }

/** The source ids a drawn view's keys name (index keys, for items with no source, are left out). */
export function drawnSources(v: DrawnView): string[] {
  const out = new Set<string>();
  const prefix = `${v.name}|`;
  for (const k of v.keys) {
    if (!k.startsWith(prefix)) continue;
    const rest = k.slice(prefix.length);
    const bar = rest.lastIndexOf("|");
    const src = bar < 0 ? rest : rest.slice(0, bar);
    if (src && !/^\d+$/.test(src)) out.add(src);
  }
  return [...out].sort();
}

const STATE_ORDER: Record<GateState, number> = { Fail: 0, Warn: 1, "Not checked": 2, Pass: 3 };
const worst = (s: GateState[]) => s.reduce<GateState>((a, b) => (STATE_ORDER[b] < STATE_ORDER[a] ? b : a), "Pass");

/**
 * Gate D: for every diagram view the plan makes from the fresh scan, and every diagram view drawn in the model, the
 * items in the model missing from the drawing (Fail: regenerate), drawn items no longer in the model (Fail), and the
 * TBC values printed (Warn: the engineer fills them in the model). A planned view not drawn yet is a Warn.
 */
export function gateD(plan: Plan, drawn: DrawnView[], scan: ScanResult, kit: DiagramKit = DEFAULT_DIAGRAM_KIT, kinds: readonly DiagramKind[] = DIAGRAM_KINDS):
  { verdict: GateState; lines: GateLine[]; views: GateView[]; summary: string } {
  const inModel = new Set<string>();
  for (const d of scan.diagrams) { for (const n of d.nodes) inModel.add(n.id); for (const e of d.edges) if (e.id) inModel.add(e.id); }
  for (const v of plan.views) for (const i of v.view.items) if (i.source_id) inModel.add(i.source_id);
  const prefixes = kinds.map((k) => kit.layout.view_names[k]).filter(Boolean).map((p) => p.toLowerCase());
  const isDiagram = (name: string) => plan.views.some((v) => v.view.name === name) || prefixes.some((p) => name.toLowerCase().startsWith(p));
  const drawnBy = new Map(drawn.filter((d) => isDiagram(d.name)).map((d) => [d.name, d]));
  const views: GateView[] = [];
  for (const p of plan.views) {
    const d = drawnBy.get(p.view.name);
    const expected = [...new Set(p.view.items.map((i) => i.source_id).filter((s): s is string => !!s))].sort();
    if (!d) {
      views.push({ view: p.view.name, state: "Warn", drawn: false, sheet: "", missing: expected, gone: [], tbc_drawn: 0, tbc_planned: p.tbc, kept_by_hand: 0 });
      continue;
    }
    const have = new Set(drawnSources(d));
    const missing = expected.filter((s) => !have.has(s));
    const gone = [...have].filter((s) => !inModel.has(s));
    const state: GateState = missing.length || gone.length ? "Fail" : d.tbc_texts > 0 || p.tbc > 0 ? "Warn" : "Pass";
    views.push({ view: p.view.name, state, drawn: true, sheet: d.sheets.join(", "), missing, gone, tbc_drawn: d.tbc_texts, tbc_planned: p.tbc, kept_by_hand: d.kept_by_hand });
  }
  for (const d of drawnBy.values()) {
    if (plan.views.some((v) => v.view.name === d.name)) continue;
    const gone = drawnSources(d).filter((s) => !inModel.has(s));
    views.push({ view: d.name, state: "Fail", drawn: true, sheet: d.sheets.join(", "), missing: [], gone, tbc_drawn: d.tbc_texts, tbc_planned: 0, kept_by_hand: d.kept_by_hand });
  }
  const s = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const drawnViews = views.filter((v) => v.drawn);
  const notDrawn = views.filter((v) => !v.drawn);
  const stale = drawnViews.filter((v) => !plan.views.some((p) => p.view.name === v.view));
  const missing = drawnViews.reduce((a, v) => a + v.missing.length, 0);
  const gone = drawnViews.reduce((a, v) => a + v.gone.length, 0);
  const tbc = drawnViews.reduce((a, v) => a + v.tbc_drawn, 0);
  const lines: GateLine[] = [];
  if (!views.length) {
    lines.push({ check: "Diagrams in the model", state: "Not checked", detail: "The scan finds no systems to draw and no diagram is drawn: nothing to compare" });
  } else {
    lines.push({ check: "Every diagram is drawn", state: notDrawn.length ? "Warn" : "Pass",
      detail: notDrawn.length ? `${s(notDrawn.length, "view")} not drawn yet: ${notDrawn.map((v) => v.view).join(", ")} (Generate in the pane, or fmc_diagram draw)` : `${s(drawnViews.length, "view")} drawn` });
    lines.push({ check: "Items in the model are on the drawing", state: drawnViews.length ? (missing ? "Fail" : "Pass") : "Not checked",
      detail: !drawnViews.length ? "No view drawn yet" : missing ? `${s(missing, "item")} in the model missing from ${drawnViews.filter((v) => v.missing.length).map((v) => `${v.view} (${v.missing.length})`).join(", ")}: regenerate (a symbol the draw said isn't loaded stays missing until its family is loaded)` : "Every item the scan finds is drawn" });
    lines.push({ check: "Drawn items are still in the model", state: drawnViews.length ? (gone || stale.length ? "Fail" : "Pass") : "Not checked",
      detail: !drawnViews.length ? "No view drawn yet" : gone || stale.length
        ? [gone ? `${s(gone, "drawn item")} no longer in the model (${drawnViews.filter((v) => v.gone.length).map((v) => `${v.view} (${v.gone.length})`).join(", ")})` : "",
          stale.length ? `${s(stale.length, "drawn view")} the model no longer makes: ${stale.map((v) => v.view).join(", ")}` : ""].filter(Boolean).join("; ") + ": regenerate"
        : "Every drawn item is still in the model" });
    const planned = drawnViews.reduce((a, v) => a + v.tbc_planned, 0);
    const tbcDetail = [tbc ? `${s(tbc, "text")} with TBC on the drawings (${drawnViews.filter((v) => v.tbc_drawn).map((v) => `${v.view} ${v.tbc_drawn}`).join(", ")})` : "",
      planned ? `${s(planned, "value")} TBC in the model now (${drawnViews.filter((v) => v.tbc_planned).map((v) => `${v.view} ${v.tbc_planned}`).join(", ")})` : ""].filter(Boolean).join("; ");
    lines.push({ check: "TBC values", state: drawnViews.length ? (tbc || planned ? "Warn" : "Pass") : "Not checked",
      detail: !drawnViews.length ? "No view drawn yet" : tbcDetail ? `${tbcDetail}: the engineer fills the values in the model and regenerates` : "No TBC on the drawings or in the model" });
    const off = drawnViews.filter((v) => !v.sheet);
    lines.push({ check: "Drawn diagrams are on a sheet", state: drawnViews.length ? (off.length ? "Warn" : "Pass") : "Not checked",
      detail: !drawnViews.length ? "No view drawn yet" : off.length ? `${s(off.length, "view")} on no sheet: ${off.map((v) => v.view).join(", ")} (fmc_diagram sheets)` : "Every drawn view is on a sheet" });
  }
  const verdict = worst(lines.map((l) => l.state));
  const summary = verdict === "Fail" ? "Gate D fails: a drawing and the model disagree; regenerate the diagrams (the engineer's notes are kept)."
    : verdict === "Warn" ? "Gate D passes with warnings: the drawings match the model, but some values are TBC or some views aren't drawn or placed yet."
      : verdict === "Pass" ? "Gate D passes: every diagram matches the model and is on its sheet. The engineer signs it off."
        : "Gate D not checked: nothing to compare.";
  views.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.view.localeCompare(b.view));
  return { verdict, lines, views, summary };
}
