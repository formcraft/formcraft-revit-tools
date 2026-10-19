/**
 * The engineering grid (E0, docs/PLAN_ENGINEERING_SERVICES.md): 23 building systems by 7 capabilities, one honest state
 * per cell, read from docs/tracker/mep_matrix.json (fmc-mep-matrix/0.1). The pane, the build tracker and the Master
 * Board read the same file; the counts are computed here, never stored. Pure apart from reading the file.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const MATRIX_SCHEMA = "fmc-mep-matrix/0.1";

/** The only states a cell may have, most advanced first. */
export const MATRIX_STATES = ["Tested in Revit", "Built, Revit check due", "Partly built", "Kit calculation only", "Planned", "Not applicable"] as const;
export type MatrixState = (typeof MATRIX_STATES)[number];

export const MATRIX_SYSTEM_COUNT = 23;
export const MATRIX_CAPABILITY_COUNT = 7;
export const MATRIX_DISCIPLINES = ["E", "M", "P", "FP", "LP", "S"] as const;

const CELL = z.object({
  system: z.string().min(1),
  capability: z.string().min(1),
  state: z.enum(MATRIX_STATES),
  evidence: z.array(z.string().min(1)),
  feature: z.string().regex(/^(F\d{2,3})?$/),
  step: z.string().regex(/^(E[1-4])?$/),
  note: z.string(),
});

const MATRIX = z.object({
  schema: z.literal(MATRIX_SCHEMA),
  title: z.string().default(""),
  updated: z.string().default(""),
  rules: z.array(z.string()).default([]),
  states: z.array(z.string()).default([]),
  disciplines: z.record(z.string()),
  capabilities: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), meaning: z.string().min(1) })),
  systems: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), discipline: z.enum(MATRIX_DISCIPLINES) })),
  cells: z.array(CELL),
});

export type Matrix = z.infer<typeof MATRIX>;
export type MatrixCell = z.infer<typeof CELL>;

/** Problems with a matrix, in plain words; empty when it is sound. With repoRoot, every evidence path must exist there. */
export function validateMatrix(raw: unknown, repoRoot = ""): { matrix: Matrix | null; errors: string[] } {
  const parsed = MATRIX.safeParse(raw);
  if (!parsed.success) return { matrix: null, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const m = parsed.data;
  const errors: string[] = [];
  if (m.systems.length !== MATRIX_SYSTEM_COUNT) errors.push(`${m.systems.length} systems, expected ${MATRIX_SYSTEM_COUNT}`);
  if (m.capabilities.length !== MATRIX_CAPABILITY_COUNT) errors.push(`${m.capabilities.length} capabilities, expected ${MATRIX_CAPABILITY_COUNT}`);
  const dup = (ids: string[], what: string) => ids.filter((x, i) => ids.indexOf(x) !== i).forEach((x) => errors.push(`${what} ${x} twice`));
  dup(m.systems.map((s) => s.id), "System");
  dup(m.capabilities.map((c) => c.id), "Capability");
  for (const s of m.systems) if (!m.disciplines[s.discipline]) errors.push(`System ${s.id}: discipline ${s.discipline} has no name`);
  const want = m.systems.length * m.capabilities.length;
  if (m.cells.length !== want) errors.push(`${m.cells.length} cells, expected ${want}`);
  const sys = new Set(m.systems.map((s) => s.id)), caps = new Set(m.capabilities.map((c) => c.id));
  const seen = new Set<string>();
  for (const c of m.cells) {
    const key = `${c.system}.${c.capability}`;
    if (!sys.has(c.system)) errors.push(`Cell ${key}: unknown system`);
    if (!caps.has(c.capability)) errors.push(`Cell ${key}: unknown capability`);
    if (seen.has(key)) errors.push(`Cell ${key} twice`);
    seen.add(key);
    const built = c.state === "Tested in Revit" || c.state === "Built, Revit check due" || c.state === "Partly built";
    if (built && c.evidence.length === 0) errors.push(`Cell ${key}: "${c.state}" needs evidence`);
    if (!built && c.evidence.length > 0) errors.push(`Cell ${key}: "${c.state}" lists evidence; only built cells do`);
    if (c.state === "Not applicable" && !c.note.trim()) errors.push(`Cell ${key}: "Not applicable" needs a reason in the note`);
    for (const e of c.evidence) {
      if (path.isAbsolute(e) || e.includes("\\") || e.split("/").includes("..")) errors.push(`Cell ${key}: evidence ${e} must be a repo path with forward slashes`);
      else if (repoRoot && !fs.existsSync(path.join(repoRoot, e))) errors.push(`Cell ${key}: evidence ${e} is not in the repo`);
    }
  }
  return { matrix: errors.length ? null : m, errors };
}

const readJson = (file: string): unknown => { try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch { return undefined; } };

/** Where the matrix is: the argument, FMC_MEP_MATRIX, the repo's docs/tracker beside this build, or the copy shipped in build/. */
export function matrixCandidates(file = "", env: NodeJS.ProcessEnv = process.env): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [file, env.FMC_MEP_MATRIX ?? "", path.resolve(here, "..", "..", "..", "docs", "tracker", "mep_matrix.json"), path.resolve(here, "..", "mep_matrix.json")]
    .filter(Boolean);
}

export function loadMatrix(file = "", env: NodeJS.ProcessEnv = process.env): { file: string; matrix: Matrix | null; errors: string[] } {
  for (const f of matrixCandidates(file, env)) {
    if (!fs.existsSync(f)) continue;
    const raw = readJson(f);
    if (raw === undefined) return { file: f, matrix: null, errors: [`${f} is not valid JSON`] };
    return { file: f, ...validateMatrix(raw) };
  }
  return { file: "", matrix: null, errors: ["mep_matrix.json not found (docs/tracker or the server build)"] };
}

type Counts = Record<MatrixState, number>;
const zero = (): Counts => Object.fromEntries(MATRIX_STATES.map((s) => [s, 0])) as Counts;

export interface MatrixLine { id: string; name: string; by_state: Counts; tested: number; applicable: number }
export interface MatrixSummary {
  cells: number; applicable: number; tested: number; built: number;
  by_state: Counts;
  headline: string;
  per_system: Array<MatrixLine & { discipline: string }>;
  per_capability: MatrixLine[];
}

/** The counts: by state, per system and per capability. "Built" counts tested and built-awaiting-check cells. */
export function summarize(m: Matrix): MatrixSummary {
  const by_state = zero();
  const line = (id: string, name: string, cells: MatrixCell[]): MatrixLine => {
    const c = zero();
    for (const x of cells) c[x.state]++;
    return { id, name, by_state: c, tested: c["Tested in Revit"], applicable: cells.length - c["Not applicable"] };
  };
  for (const c of m.cells) by_state[c.state]++;
  const applicable = m.cells.length - by_state["Not applicable"];
  const tested = by_state["Tested in Revit"];
  const built = tested + by_state["Built, Revit check due"];
  return {
    cells: m.cells.length, applicable, tested, built, by_state,
    headline: `${tested} of ${applicable} cells tested in Revit · ${by_state["Built, Revit check due"]} built, Revit check due · ` +
      `${by_state["Partly built"]} partly built · ${by_state["Kit calculation only"]} kit calculation only · ${by_state["Planned"]} planned`,
    per_system: m.systems.map((s) => ({ ...line(s.id, s.name, m.cells.filter((c) => c.system === s.id)), discipline: s.discipline })),
    per_capability: m.capabilities.map((k) => line(k.id, k.name, m.cells.filter((c) => c.capability === k.id))),
  };
}

/** The grid as rows: one per system, the state of each capability in order. */
export function matrixGrid(m: Matrix): { capabilities: string[]; rows: Array<{ system: string; discipline: string; states: string[] }> } {
  const at = new Map(m.cells.map((c) => [`${c.system}.${c.capability}`, c.state]));
  return {
    capabilities: m.capabilities.map((c) => c.name),
    rows: m.systems.map((s) => ({ system: s.name, discipline: s.discipline, states: m.capabilities.map((c) => at.get(`${s.id}.${c.id}`) ?? "") })),
  };
}
