/**
 * Drafting-view plans for fmc_elec_diagrams and fmc_plumb_diagrams.
 * The graph uses the same panel, circuit and piping-system fields as fmc_trace.
 * A missing rating, load or pipe size is printed TBC. Nothing is sized here.
 */
import type { TraceSnapshot } from "./trace.js";

export type RiserStyle = "bands" | "elevation";

export interface DiagramItem {
  t: "line" | "text" | "symbol";
  points?: number[][];
  at?: number[];
  text?: string;
  style?: string;
  align?: "left" | "center" | "right";
  family?: string;
  type?: string;
  source_id?: string;
}

export interface DiagramView {
  name: string;
  kind: "e_sld" | "e_power_riser" | "e_earthing" | "p_riser" | "p_schematic";
  system: string;
  building: string;
  scale: number;
  items: DiagramItem[];
  notes: string[];
}

export interface LevelRow {
  name: string;
  elevation_mm: number;
  building?: string;
}

export interface ElecPanel {
  id: number;
  name: string;
  level?: string;
  elevation_mm?: number;
  building?: string;
  distribution?: string;
  voltage_ll?: number;
  voltage_lg?: number;
  phase?: string;
  main_a?: number;
  supply_from_id?: number;
}

export interface ElecCircuit {
  id: number;
  name?: string;
  number?: string;
  panel_id: number;
  panel_name?: string;
  voltage?: number;
  poles?: number;
  rating_a?: number;
  apparent_va?: number;
  element_ids?: number[];
  wire_size?: string;
}

export interface ElecDiagramInput {
  panels?: ElecPanel[];
  circuits?: ElecCircuit[];
  levels?: LevelRow[];
  symbols?: string[];
}

export interface PlumbSystem {
  id: number;
  name: string;
  classification?: string;
  domain?: string;
}

export interface PlumbElement {
  id: number;
  name?: string;
  kind?: string;
  system_ids?: number[];
  level?: string;
  elevation_mm?: number;
  size_mm?: number;
  x?: number;
  y?: number;
  z0?: number;
  z1?: number;
  vertical?: boolean;
  /** Pipe slope in percent (RBS_PIPE_SLOPE), when the add-in reads it. */
  slope_pct?: number | null;
  /** Pipe fixture units (RBS_PIPE_FIXTURE_UNITS_PARAM, cumulative along the run), when the add-in reads it. */
  fixture_units?: number | null;
}

export interface View3dNote {
  id: number;
  name: string;
  tiny?: boolean;
}

export interface PlumbDiagramInput {
  systems?: PlumbSystem[];
  elements?: PlumbElement[];
  levels?: LevelRow[];
  symbols?: string[];
  views_3d?: View3dNote[];
}

export interface DiagramPlan {
  views: DiagramView[];
  warnings: string[];
  supersedes_3d: View3dNote[];
  counts: { views: number; items: number; panels: number; circuits: number; systems: number };
  /** Plumbing only: which systems were drawn out of how many (PD-1). */
  selection?: SystemSelection;
  /** Plumbing only: per-system facts a plumbing connector can compare against (PD-6). */
  connector_input?: PlumbConnectorInput;
  /** One line for the top of the reply (PD-15). */
  summary?: string;
}

export interface SystemPick {
  /** System names (case-insensitive) or ids to draw. Empty draws every system, paged by offset and limit. */
  systems?: string[];
  offset?: number;
  limit?: number;
}

export interface SystemSelection {
  total: number;
  drawn: number;
  offset: number;
  limit: number;
  order: "name";
  drawn_names: string[];
  not_drawn: string[];
  not_found: string[];
}

export interface PlumbConnectorSystem {
  id: number;
  name: string;
  class: "water" | "drainage" | "vent" | "other";
  stacks: number;
  sizes_mm: number[];
  fixtures: number;
  fixture_units: number | null;
  fall_pct: { min: number; max: number } | null;
  levels: string[];
}

export interface PlumbConnectorInput {
  schema: "fmc-plumb-connector-input/1";
  systems: PlumbConnectorSystem[];
  note: string;
}

/** Which discipline each DIAGRAM_API_LIMITS line is about, by index (PD-14). */
const LIMIT_SCOPE: Array<"elec" | "plumb" | "both"> = ["elec", "elec", "elec", "both", "both", "elec", "plumb", "plumb", "both", "both"];

/** The API limits that apply to one diagram tool; the plumbing tool no longer prints panel and pole notes. */
export function diagramApiLimits(discipline: "elec" | "plumb"): string[] {
  return DIAGRAM_API_LIMITS.filter((_, index) => (LIMIT_SCOPE[index] ?? "both") === "both" || LIMIT_SCOPE[index] === discipline);
}

export const DIAGRAM_API_LIMITS = [
  "ElectricalSystem.SelectPanel fails when the panel DistributionSysType voltage or phase does not match the circuit connector voltage and poles, and when the panel has no distribution system. PolesNumber cannot be set.",
  "Connector.Voltage is the connector voltage. Connector has no poles property. Poles are RBS_ELEC_NUMBER_OF_POLES.",
  "DistributionSysType.VoltageLineToLine, VoltageLineToGround, ElectricalPhase, PhaseConfiguration and NumWires describe the panel. VoltageType.ActualValue is converted with UnitTypeId.Volts.",
  "A drafting view is ViewDrafting.Create. Detail lines are Document.Create.NewDetailCurve. Text is TextNote.Create. A kit symbol is NewFamilyInstance(XYZ, FamilySymbol, View) and only when that Generic Annotation or Detail Item is already loaded.",
  "A missing kit symbol is drawn as lines and text. The tool does not load a family from disk.",
  "The earthing view is a template. Electrode, pit and bond sizes are not read from the model.",
  "PipingSystem.Elements can be incomplete on a large system, the same limit fmc_trace reports. The diagram read does not walk Connector.AllRefs.",
  "A pipe with no ReferenceLevel is placed by its curve elevation. elevation risers use level elevation in millimetres, 12 paper mm per metre.",
  "A tiny 3D view whose name says schematic or riser is listed as superseded. It is not deleted.",
  "Apply is one transaction, one subtransaction per view. The model is not saved and a workshared model is not synchronised.",
];

const BOARD_SYMBOL = "FMC_DI_E_SLD_Board";
const BREAKER_SYMBOL = "FMC_DI_E_SLD_Breaker";
const PLUMB_SYMBOL = "FMC_DI_P_Schematic";
const TEXT = "FMC_Arial_2.5";
const LINE = "Thin Lines";
const WAYS_CAP = 40;
const SYSTEM_CAP = 16;

function viewName(name: string): string {
  const clean = name.replace(/[{}[\]|\\:;<>?]/g, "-").replace(/\s+/g, " ").trim();
  return (clean || "Diagram").slice(0, 80);
}

function text(at: number[], value: string, source?: string, align: "left" | "center" | "right" = "left"): DiagramItem {
  return { t: "text", at, text: value, style: TEXT, align, ...(source ? { source_id: source } : {}) };
}

function line(points: number[][], source?: string): DiagramItem {
  return { t: "line", points, style: LINE, ...(source ? { source_id: source } : {}) };
}

function box(x: number, y: number, w: number, h: number, source?: string): DiagramItem[] {
  return [
    line([[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]], source),
  ];
}

export function loadedSymbol(symbols: string[] | undefined, family: string): { family: string; type: string } | null {
  const hit = (symbols ?? []).find((item) => item.toLowerCase().startsWith(family.toLowerCase() + ":"));
  if (!hit) return null;
  const split = hit.indexOf(":");
  const type = hit.slice(split + 1).trim();
  const fam = hit.slice(0, split).trim();
  if (!fam || !type) return null;
  return { family: fam, type };
}

function symbol(at: number[], family: string, type: string, source?: string): DiagramItem {
  return { t: "symbol", family, type, at, ...(source ? { source_id: source } : {}) };
}

function buildingOf(panel: ElecPanel): string {
  const name = (panel.building ?? "").trim();
  return name || "Building";
}

function levelRows(named: Array<{ level?: string; elevation_mm?: number }>, given: LevelRow[] | undefined): LevelRow[] {
  const map = new Map<string, LevelRow>();
  for (const row of given ?? []) {
    if (!row.name) continue;
    map.set(row.name, { name: row.name, elevation_mm: row.elevation_mm ?? 0, building: row.building });
  }
  for (const row of named) {
    const name = (row.level ?? "").trim();
    if (!name || map.has(name)) continue;
    map.set(name, { name, elevation_mm: row.elevation_mm ?? 0 });
  }
  return [...map.values()];
}

/** Highest level at the top. elevation uses 12 paper mm per metre of level height. */
export function levelYs(levels: LevelRow[], style: RiserStyle): Map<string, number> {
  const rows = [...levels].sort((a, b) => b.elevation_mm - a.elevation_mm || a.name.localeCompare(b.name));
  const map = new Map<string, number>();
  if (style === "elevation" && rows.length) {
    const min = Math.min(...rows.map((row) => row.elevation_mm));
    for (const row of rows) map.set(row.name, Math.round((20 + ((row.elevation_mm - min) / 1000) * 12) * 10) / 10);
    return map;
  }
  rows.forEach((row, index) => map.set(row.name, 20 + (rows.length - 1 - index) * 36));
  return map;
}

function wayText(circuit: ElecCircuit): string {
  const number = (circuit.number || circuit.name || String(circuit.id)).trim();
  const rating = circuit.rating_a && circuit.rating_a > 0 ? `${circuit.rating_a} A` : "rating TBC";
  const poles = circuit.poles && circuit.poles > 0 ? `${circuit.poles}P` : "poles TBC";
  const load = circuit.apparent_va && circuit.apparent_va > 0 ? `${Math.round(circuit.apparent_va)} VA` : "load TBC";
  const wire = (circuit.wire_size ?? "").trim();
  return [number, rating, poles, load, wire].filter(Boolean).join("  ");
}

function isFeeder(circuit: ElecCircuit, panelIds: Set<number>): boolean {
  return (circuit.element_ids ?? []).some((id) => panelIds.has(id) && id !== circuit.panel_id);
}

function planSld(panels: ElecPanel[], circuits: ElecCircuit[], symbols: string[] | undefined, building: string): DiagramView {
  const panelIds = new Set(panels.map((panel) => panel.id));
  const board = loadedSymbol(symbols, BOARD_SYMBOL);
  const breaker = loadedSymbol(symbols, BREAKER_SYMBOL);
  const items: DiagramItem[] = [];
  const notes: string[] = [];
  if (!board) notes.push(`${BOARD_SYMBOL} is not loaded. Boards are lines and text.`);
  if (!breaker) notes.push(`${BREAKER_SYMBOL} is not loaded. Breakers are lines and text.`);
  const sorted = [...panels].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  let x = 16;
  let top = 40;
  for (const panel of sorted) {
    const ways = circuits
      .filter((circuit) => circuit.panel_id === panel.id)
      .sort((a, b) => wayText(a).localeCompare(wayText(b)) || a.id - b.id);
    const shown = ways.slice(0, WAYS_CAP);
    if (ways.length > WAYS_CAP) notes.push(`${panel.name}: ${ways.length - WAYS_CAP} ways are not on this view.`);
    const busY = 28 + shown.length * 11;
    top = Math.max(top, busY + 28);
    items.push(...box(x, busY, 62, 10, `panel:${panel.id}`));
    items.push(text([x, busY + 22], panel.name, `panel:${panel.id}`));
    const dist = [panel.distribution, panel.main_a ? `${panel.main_a} A` : ""].filter(Boolean).join("  ");
    if (dist) items.push(text([x, busY + 16], dist, `panel:${panel.id}`));
    if (board) items.push(symbol([x + 31, busY + 5], board.family, board.type, `panel:${panel.id}`));
    shown.forEach((circuit, index) => {
      const y = busY - 8 - index * 11;
      const feeder = isFeeder(circuit, panelIds);
      items.push(line([[x + 20, busY], [x + 20, y], [x + 58, y]], `circuit:${circuit.id}`));
      items.push(text([x + 2, y + 4], wayText(circuit) + (feeder ? "  feeder" : ""), `circuit:${circuit.id}`));
      if (breaker) items.push(symbol([x + 20, y], breaker.family, breaker.type, `circuit:${circuit.id}`));
    });
    x += 78;
  }
  items.unshift(text([16, top + 8], `Single-line ${building}`, "title"));
  return {
    name: viewName(building === "Building" ? "E-SLD" : `E-SLD-${building}`),
    kind: "e_sld", system: building, building, scale: 50, items, notes,
  };
}

function planRiser(panels: ElecPanel[], levels: LevelRow[], building: string, style: RiserStyle): DiagramView {
  const ys = levelYs(levels, style);
  const items: DiagramItem[] = [];
  const notes: string[] = [];
  if (style === "elevation") notes.push("Riser bands use level elevation, 12 mm on paper per metre.");
  const placed = new Map<number, { x: number; y: number }>();
  const byLevel = new Map<string, ElecPanel[]>();
  for (const panel of panels) {
    const level = (panel.level ?? "").trim() || "(no level)";
    const list = byLevel.get(level) ?? [];
    list.push(panel);
    byLevel.set(level, list);
    if (!ys.has(level)) ys.set(level, 20);
  }
  for (const [level, list] of byLevel) {
    list.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
    const y = ys.get(level) ?? 20;
    items.push(text([4, y + 8], level, `level:${level}`));
    list.forEach((panel, index) => {
      const x = 36 + index * 70;
      placed.set(panel.id, { x, y });
      items.push(...box(x, y, 60, 14, `panel:${panel.id}`));
      const main = panel.main_a ? `${panel.main_a} A` : "main TBC";
      items.push(text([x + 2, y + 12], `${panel.name}  ${main}`, `panel:${panel.id}`));
      if (panel.distribution) items.push(text([x + 2, y + 6], panel.distribution, `panel:${panel.id}`));
    });
  }
  for (const panel of panels) {
    const from = panel.supply_from_id;
    if (!from || !placed.has(from) || !placed.has(panel.id)) continue;
    const a = placed.get(from)!;
    const b = placed.get(panel.id)!;
    items.push(line([[a.x + 30, a.y], [b.x + 30, b.y]], `feeder:${from}:${panel.id}`));
    items.push(text([(a.x + b.x) / 2, (a.y + b.y) / 2 + 4], "feeder", `feeder:${from}:${panel.id}`));
  }
  const top = Math.max(40, ...[...ys.values()].map((y) => y + 24));
  items.unshift(text([16, top], `Power riser ${building}`, "title"));
  return {
    name: viewName(building === "Building" ? "E-Power-Riser" : `E-Power-Riser-${building}`),
    kind: "e_power_riser", system: building, building, scale: 50, items, notes,
  };
}

function planEarthing(): DiagramView {
  const nodes = [
    ["Supply", "Incoming supply"],
    ["MET", "Main earth terminal"],
    ["Electrode", "Earth electrode"],
    ["Bar", "Earth bar"],
    ["Water", "Bond to water"],
    ["Gas", "Bond to gas"],
    ["LP", "Lightning bond"],
  ];
  const items: DiagramItem[] = [text([16, 78], "Earthing schematic", "title")];
  nodes.forEach((node, index) => {
    const x = 16 + (index % 4) * 58;
    const y = index < 4 ? 48 : 22;
    items.push(...box(x, y, 50, 16, `earth:${node[0]}`));
    items.push(text([x + 2, y + 12], node[0], `earth:${node[0]}`));
    items.push(text([x + 2, y + 6], node[1], `earth:${node[0]}`));
    if (index > 0) items.push(line([[16 + 25, 56], [x + 25, y + 16]], `earth-link:${node[0]}`));
  });
  items.push(text([16, 12], "Template. Electrode, pit and bond sizes are not read from the model.", "note"));
  return {
    name: "E-Earthing", kind: "e_earthing", system: "Earthing", building: "", scale: 50, items,
    notes: ["Template drafting view. It is not a survey of the model earth path."],
  };
}

export function planElecDiagrams(input: ElecDiagramInput, style: RiserStyle = "bands"): DiagramPlan {
  const panels = input.panels ?? [];
  const circuits = input.circuits ?? [];
  const warnings: string[] = [];
  const views: DiagramView[] = [];
  if (!panels.length) warnings.push("No panels were read. The single-line and the riser are not drawn.");
  const buildings = [...new Set(panels.map(buildingOf))].sort();
  for (const building of buildings) {
    const mine = panels.filter((panel) => buildingOf(panel) === building);
    const ids = new Set(mine.map((panel) => panel.id));
    views.push(planSld(mine, circuits.filter((circuit) => ids.has(circuit.panel_id)), input.symbols, building));
    const levels = levelRows(mine, (input.levels ?? []).filter((row) => !row.building || row.building === building));
    views.push(planRiser(mine, levels, building, style));
  }
  views.push(planEarthing());
  return {
    views,
    warnings,
    supersedes_3d: [],
    counts: { views: views.length, items: views.reduce((sum, view) => sum + view.items.length, 0), panels: panels.length, circuits: circuits.length, systems: 0 },
  };
}

export function plumbClass(system: { name?: string; classification?: string }): "water" | "drainage" | "vent" | "other" {
  const text = `${system.name ?? ""} ${system.classification ?? ""}`.toLowerCase();
  if (/\bvent\b/.test(text)) return "vent";
  if (/sanitary|sewer|soil|waste|foul|storm|rain|drain|\bsvp\b|\brwp\b/.test(text)) return "drainage";
  if (/cold|hot|domestic|water|\bdcw\b|\bdhw\b/.test(text)) return "water";
  return "other";
}

function stackKey(element: PlumbElement): string {
  const x = Math.round((element.x ?? 0) / 500) * 500;
  const y = Math.round((element.y ?? 0) / 500) * 500;
  return `${x}|${y}`;
}

function modeSize(values: number[]): number {
  const counts = new Map<number, number>();
  for (const value of values) if (value > 0) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = 0;
  let n = 0;
  for (const [value, count] of counts) if (count > n || (count === n && value > best)) { best = value; n = count; }
  return best;
}

function planPlumbSystem(system: PlumbSystem, elements: PlumbElement[], levels: LevelRow[], symbols: string[] | undefined, style: RiserStyle, superseded: View3dNote[]): DiagramView[] {
  const kind = plumbClass(system);
  const mark = loadedSymbol(symbols, PLUMB_SYMBOL);
  const mine = elements.filter((element) => (element.system_ids ?? []).includes(system.id));
  const systemLevels = levelRows(mine, levels);
  const ys = levelYs(systemLevels.length ? systemLevels : [{ name: "(no level)", elevation_mm: 0 }], style);
  const verticals = mine.filter((element) => element.vertical && (element.kind === "pipe" || element.kind === "flex_pipe" || !element.kind));
  const stacks = new Map<string, PlumbElement[]>();
  for (const pipe of verticals) {
    const key = stackKey(pipe);
    const list = stacks.get(key) ?? [];
    list.push(pipe);
    stacks.set(key, list);
  }
  if (!stacks.size) stacks.set("stack", []);
  const riserItems: DiagramItem[] = [text([16, Math.max(...ys.values()) + 28], `${kind} riser ${system.name}`, `system:${system.id}`)];
  const notes: string[] = [];
  if (style === "elevation") notes.push("Riser bands use level elevation, 12 mm on paper per metre.");
  if (!mark) notes.push(`${PLUMB_SYMBOL} is not loaded. Stacks are lines and text.`);
  if (kind === "vent") notes.push("Vent stack.");
  let column = 0;
  for (const [key, pipes] of [...stacks.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const x = 40 + column * 62;
    column += 1;
    const size = modeSize(pipes.map((pipe) => pipe.size_mm ?? 0));
    const title = kind === "vent" ? "Vent" : `Stack ${column}`;
    riserItems.push(text([x, Math.max(...ys.values()) + 16], `${title}${size ? `  ${size} mm` : "  size TBC"}`, `stack:${system.id}:${key}`));
    if (mark) riserItems.push(symbol([x + 16, Math.max(...ys.values()) + 8], mark.family, mark.type, `stack:${system.id}:${key}`));
    const names = [...ys.keys()];
    names.forEach((level, index) => {
      const y = ys.get(level) ?? 20;
      if (column === 1) riserItems.push(text([4, y + 8], level, `level:${level}`));
      const fixtures = mine.filter((element) => element.kind === "fixture" && (element.level ?? "") === level).length;
      const branches = mine.filter((element) => (element.kind === "pipe" || element.kind === "flex_pipe") && !element.vertical && (element.level ?? "") === level).length;
      riserItems.push(line([[x + 16, y + 18], [x + 16, y]], `stack:${system.id}:${key}:${level}`));
      riserItems.push(text([x + 20, y + 8], `fixtures ${fixtures}  branches ${branches}`, `level:${system.id}:${level}`));
      if (index < names.length - 1) {
        const between = modeSize(pipes.filter((pipe) => (pipe.level ?? "") === level || (pipe.level ?? "") === names[index + 1]).map((pipe) => pipe.size_mm ?? 0)) || size;
        riserItems.push(text([x + 20, y + 16], between ? `${between} mm` : "size TBC", `size:${system.id}:${level}`));
      }
    });
  }
  const fixtureCount = mine.filter((element) => element.kind === "fixture").length;
  const sizes = [...new Set(mine.map((element) => element.size_mm ?? 0).filter((size) => size > 0))].sort((a, b) => a - b);
  const drain = drainageFacts(mine);
  if (kind === "drainage") {
    notes.push(drain.fall ? `Fall ${drain.fall.min}-${drain.fall.max} % on horizontal pipes.` : "Fall TBC: no pipe slope was read.");
    notes.push(drain.fixture_units !== null ? `Fixture units ${drain.fixture_units} (largest pipe value).` : "Fixture units TBC.");
  }
  const equipment = mine.filter((element) => element.kind === "equipment").map((element) => element.name || String(element.id)).slice(0, 8);
  const schematic: DiagramItem[] = [
    text([16, 70], `${kind} schematic ${system.name}`, `system:${system.id}`),
    line([[16, 40], [160, 40]], `system:${system.id}`),
    text([16, 52], system.classification || "classification TBC", `system:${system.id}`),
    text([70, 52], `${stacks.size} stack${stacks.size === 1 ? "" : "s"}`, `system:${system.id}`),
    text([110, 52], `${fixtureCount} fixtures`, `system:${system.id}`),
    text([16, 28], sizes.length ? `sizes ${sizes.join(", ")} mm` : "sizes TBC", `system:${system.id}`),
  ];
  if (kind === "drainage") {
    schematic.push(text([16, 8], `${drain.fall ? `fall ${drain.fall.min}-${drain.fall.max} %` : "fall TBC"}  ${drain.fixture_units !== null ? `FU ${drain.fixture_units}` : "FU TBC"}`, `system:${system.id}`));
  }
  if (equipment.length) schematic.push(text([16, 18], equipment.join(", "), `system:${system.id}`));
  if (superseded.length && kind !== "vent") {
    notes.push(`Replaces 3D schematic ${superseded.map((view) => view.name).join(", ")}. The 3D view is left in place.`);
  }
  const safe = viewName(system.name || String(system.id));
  return [
    { name: viewName(`P-Riser-${safe}`), kind: "p_riser", system: system.name, building: "", scale: 50, items: riserItems, notes: [...notes] },
    { name: viewName(`P-Schematic-${safe}`), kind: "p_schematic", system: system.name, building: "", scale: 50, items: schematic, notes: [] },
  ];
}

/** Slope range of horizontal pipes and the largest pipe fixture-unit value (Revit accumulates them along the run). */
export function drainageFacts(elements: PlumbElement[]): { fall: { min: number; max: number } | null; fixture_units: number | null } {
  const slopes = elements.filter((element) => !element.vertical && typeof element.slope_pct === "number" && element.slope_pct > 0).map((element) => element.slope_pct as number);
  const units = elements.map((element) => element.fixture_units).filter((value): value is number => typeof value === "number" && value > 0);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    fall: slopes.length ? { min: round(Math.min(...slopes)), max: round(Math.max(...slopes)) } : null,
    fixture_units: units.length ? round(Math.max(...units)) : null,
  };
}

/** Systems in name order, then picked by name or id, then paged (PD-1). The cap stays 16 views pairs per call. */
export function pickSystems(systems: PlumbSystem[], pick: SystemPick = {}): { shown: PlumbSystem[]; selection: SystemSelection } {
  const ordered = [...systems].sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { numeric: true }) || a.id - b.id);
  const wanted = (pick.systems ?? []).map((item) => String(item).trim()).filter(Boolean);
  const notFound: string[] = [];
  let pool = ordered;
  if (wanted.length) {
    const hit = (system: PlumbSystem, key: string) => String(system.id) === key || (system.name || "").toLowerCase() === key.toLowerCase();
    for (const key of wanted) if (!ordered.some((system) => hit(system, key))) notFound.push(key);
    pool = ordered.filter((system) => wanted.some((key) => hit(system, key)));
  }
  const offset = Math.max(0, Math.floor(pick.offset ?? 0));
  const limit = Math.min(SYSTEM_CAP, Math.max(1, Math.floor(pick.limit ?? SYSTEM_CAP)));
  const shown = pool.slice(offset, offset + limit);
  const shownIds = new Set(shown.map((system) => system.id));
  const notDrawn = pool.filter((system) => !shownIds.has(system.id)).map((system) => system.name || String(system.id));
  return {
    shown,
    selection: {
      total: systems.length, drawn: shown.length, offset, limit, order: "name",
      drawn_names: shown.map((system) => system.name || String(system.id)),
      not_drawn: notDrawn.slice(0, 40), not_found: notFound,
    },
  };
}

export function plumbConnectorInput(systems: PlumbSystem[], elements: PlumbElement[]): PlumbConnectorInput {
  return {
    schema: "fmc-plumb-connector-input/1",
    systems: systems.map((system) => {
      const mine = elements.filter((element) => (element.system_ids ?? []).includes(system.id));
      const stacks = new Set(mine.filter((element) => element.vertical && (element.kind === "pipe" || element.kind === "flex_pipe" || !element.kind)).map(stackKey));
      const drain = drainageFacts(mine);
      return {
        id: system.id,
        name: system.name,
        class: plumbClass(system),
        stacks: stacks.size,
        sizes_mm: [...new Set(mine.map((element) => element.size_mm ?? 0).filter((size) => size > 0))].sort((a, b) => a - b),
        fixtures: mine.filter((element) => element.kind === "fixture").length,
        fixture_units: drain.fixture_units,
        fall_pct: drain.fall,
        levels: [...new Set(mine.map((element) => element.level ?? "").filter(Boolean))].sort(),
      };
    }),
    note: "No plumbing connector exists in this server yet; this block is the input it would compare against (PD-6).",
  };
}

export function planPlumbDiagrams(input: PlumbDiagramInput, style: RiserStyle = "bands", pick: SystemPick = {}): DiagramPlan {
  const systems = (input.systems ?? []).filter((system) => !system.domain || system.domain === "piping");
  const warnings: string[] = [];
  const superseded = (input.views_3d ?? []).filter((view) => view.tiny !== false && /schematic|riser/i.test(view.name));
  const { shown, selection } = pickSystems(systems, pick);
  if (selection.not_drawn.length) {
    warnings.push(`${selection.not_drawn.length} piping system(s) are not drawn (at most ${SYSTEM_CAP} per call; use systems, offset or limit): ${selection.not_drawn.slice(0, 8).join(", ")}${selection.not_drawn.length > 8 ? ", ..." : ""}.`);
  }
  if (selection.not_found.length) warnings.push(`Not found: ${selection.not_found.join(", ")}.`);
  if (!shown.length) warnings.push("No piping systems were read.");
  const levels = input.levels ?? [];
  const elements = input.elements ?? [];
  const views = shown.flatMap((system) => planPlumbSystem(system, elements, levels, input.symbols, style, superseded));
  const items = views.reduce((sum, view) => sum + view.items.length, 0);
  const symbolLoaded = !!loadedSymbol(input.symbols, PLUMB_SYMBOL);
  return {
    views,
    warnings,
    supersedes_3d: superseded,
    counts: { views: views.length, items, panels: 0, circuits: 0, systems: shown.length },
    selection,
    connector_input: plumbConnectorInput(shown, elements),
    summary: `${shown.length} of ${systems.length} piping systems drawn; ${views.length} views, ${items} items; ${PLUMB_SYMBOL} ${symbolLoaded ? "loaded" : "not loaded (lines and text)"}${warnings.length ? `; ${warnings.length} warning(s)` : ""}.`,
  };
}

export function elecInputFromTrace(snapshot: TraceSnapshot): ElecDiagramInput {
  return {
    panels: (snapshot.electrical?.panels ?? []).map((panel) => ({
      id: panel.id,
      name: panel.name,
      distribution: panel.distribution,
      main_a: panel.main_a,
      supply_from_id: panel.supply_from_id,
    })),
    circuits: (snapshot.electrical?.circuits ?? []).map((circuit) => ({
      id: circuit.id,
      name: circuit.name,
      number: circuit.number,
      panel_id: circuit.panel_id,
      panel_name: circuit.panel_name,
      voltage: circuit.voltage,
      poles: circuit.poles,
      rating_a: circuit.rating_a,
      apparent_va: circuit.apparent_va,
      element_ids: circuit.element_ids,
      wire_size: circuit.wire_size,
    })),
    levels: [],
  };
}

export function plumbInputFromTrace(snapshot: TraceSnapshot): PlumbDiagramInput {
  const systems = (snapshot.flow?.systems ?? []).filter((system) => system.domain === "piping");
  const elements = (snapshot.flow?.elements ?? [])
    .filter((element) => element.domain === "piping" || element.domain === "both")
    .map((element) => {
      const box = element.bbox ?? [];
      const dx = box.length === 6 ? Math.abs(box[3] - box[0]) : 0;
      const dy = box.length === 6 ? Math.abs(box[4] - box[1]) : 0;
      const dz = box.length === 6 ? Math.abs(box[5] - box[2]) : 0;
      return {
        id: element.id,
        name: element.name,
        kind: element.kind,
        system_ids: element.system_ids,
        x: box.length === 6 ? (box[0] + box[3]) / 2 : 0,
        y: box.length === 6 ? (box[1] + box[4]) / 2 : 0,
        z0: box[2],
        z1: box[5],
        vertical: dz > dx && dz > dy && dz > 1500,
      };
    });
  return { systems, elements, levels: [] };
}
