/**
 * Track R (Robot Structural Analysis): the pure part. Revit's analytical members become Robot nodes and bars, Robot's
 * results become rows for the kit's FMC_FEA_ fields. The engineer decides everything that is engineering (rule 5):
 * the supports, the load cases, the loads, the code and the sections. Nothing here has a default for those.
 */

export interface Member {
  id: number;
  kind: "column" | "beam";
  start: [number, number, number];
  end: [number, number, number];
  section: string;
  b_mm: number;
  h_mm: number;
  material_class: string;
  concrete_grade: string;
  steel_grade: string;
  mark?: string;
  /** Revit's UniqueId: the hub's identity map keeps Revit elements by it (it survives sessions). */
  unique_id?: string;
}

export interface RobotNode { n: number; x: number; y: number; z: number }
export interface RobotBar {
  n: number; start: number; end: number; id: number; kind: string; section: string;
  b_mm: number; h_mm: number; material_class: string; grade: string;
}
export interface RobotModel { nodes: RobotNode[]; bars: RobotBar[]; supports: number[]; skipped: Array<{ id: number; why: string }> }

export const NATURES = ["PERMANENT", "EXPLOATATION", "WIND", "SNOW", "TEMPERATURE", "ACCIDENTAL", "SEISMIC"] as const;
export interface LoadCase { name: string; nature: string; self_weight: boolean }
export interface EngineerForm { supports: "Fixed" | "Pinned"; cases: LoadCase[]; engineer: string }

/** Ends within `tolMm` are one node; nodes are numbered in the order they are met, from 1. */
export function assemble(members: Member[], tolMm = 1): RobotModel {
  const nodes: RobotNode[] = [];
  const skipped: RobotModel["skipped"] = [];
  const node = (p: [number, number, number]) => {
    const hit = nodes.find((q) => Math.abs(q.x - p[0]) <= tolMm && Math.abs(q.y - p[1]) <= tolMm && Math.abs(q.z - p[2]) <= tolMm);
    if (hit) return hit.n;
    nodes.push({ n: nodes.length + 1, x: p[0], y: p[1], z: p[2] });
    return nodes.length;
  };
  const bars: RobotBar[] = [];
  const columnEnds: Array<{ bottom: number; top: number }> = [];
  for (const m of members) {
    if (!Array.isArray(m.start) || !Array.isArray(m.end) || m.start.length !== 3 || m.end.length !== 3) { skipped.push({ id: m.id, why: "no analytical ends" }); continue; }
    const a = node(m.start), b = node(m.end);
    if (a === b) { skipped.push({ id: m.id, why: "its two ends are the same point" }); continue; }
    const concrete = m.material_class === "Concrete";
    bars.push({ n: bars.length + 1, start: a, end: b, id: m.id, kind: m.kind, section: m.section, b_mm: m.b_mm, h_mm: m.h_mm,
      material_class: m.material_class, grade: concrete ? m.concrete_grade : m.steel_grade });
    if (m.kind === "column") {
      const lowFirst = m.start[2] <= m.end[2];
      columnEnds.push({ bottom: lowFirst ? a : b, top: lowFirst ? b : a });
    }
  }
  // A support is the bottom of a column that isn't the top of another column (a stacked column sits on the one below).
  const tops = new Set(columnEnds.map((c) => c.top));
  const supports = [...new Set(columnEnds.map((c) => c.bottom).filter((n) => !tops.has(n)))].sort((x, y) => x - y);
  return { nodes, bars, supports, skipped };
}

/** The engineer's form: every field is theirs, so nothing missing is filled in. */
export function checkForm(raw: unknown): { form: EngineerForm | null; problems: string[] } {
  const problems: string[] = [];
  const f = (raw ?? {}) as Record<string, unknown>;
  const supports = f.supports;
  if (supports !== "Fixed" && supports !== "Pinned") problems.push("The engineer chooses the column-base supports: Fixed or Pinned");
  const engineer = typeof f.engineer === "string" ? f.engineer.trim() : "";
  if (!engineer) problems.push("The engineer's name is needed: the run is theirs");
  const cases: LoadCase[] = [];
  if (!Array.isArray(f.cases) || f.cases.length === 0) problems.push("The engineer names at least one load case");
  else f.cases.forEach((c, i) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const nature = typeof o.nature === "string" ? o.nature.trim().toUpperCase() : "";
    if (!name) problems.push(`Case ${i + 1}: a name is needed`);
    if (!(NATURES as readonly string[]).includes(nature)) problems.push(`Case ${i + 1}: the nature is one of ${NATURES.join(", ")}`);
    if (typeof o.self_weight !== "boolean") problems.push(`Case ${i + 1}: say whether Robot adds the self-weight (true or false)`);
    cases.push({ name, nature, self_weight: o.self_weight === true });
  });
  if (problems.length) return { form: null, problems };
  return { form: { supports: supports as "Fixed" | "Pinned", cases, engineer }, problems };
}

/** FEA-yyyymmdd-hhmm, in local time: the run's name, its folder files and the value of FMC_FEA_Run_Ref. */
export function runRef(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `FEA-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export interface BarResult { n: number; id: number; ned_kn: number; med_knm: number; ned_case?: string; med_case?: string }
export interface FeaRow { id: number; ned_kn: number; med_knm: number; run: string }

/** Robot's bar results back to Revit elements by the run's own mapping; a bar the run didn't send is left out. */
export function mapResults(sent: Array<{ n: number; id: number }>, results: BarResult[], run: string): { rows: FeaRow[]; unknown: number[] } {
  const byBar = new Map(sent.map((b) => [b.n, b.id]));
  const rows: FeaRow[] = [];
  const unknown: number[] = [];
  for (const r of results) {
    const id = byBar.get(r.n);
    if (id === undefined || id !== r.id) { unknown.push(r.n); continue; }
    if (!Number.isFinite(r.ned_kn) || !Number.isFinite(r.med_knm)) { unknown.push(r.n); continue; }
    rows.push({ id, ned_kn: r.ned_kn, med_knm: r.med_knm, run });
  }
  return { rows, unknown };
}
