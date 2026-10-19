/**
 * The clash matrix (hub step H3, docs/CLASH_MATRIX.md): which pairs of disciplines or selection sets Navisworks tests,
 * and how. The kit has no clash matrix yet, so `fmc-clash-matrix/0.1` is the plugin's proposal (a kit change request);
 * when the kit publishes one, the kit wins (rule 7). Pure: the matrix in, the checked tests out.
 */
import { ROLE_CODES } from "./policy.js";
import { roleOfModel } from "./tickets.js";

export const MATRIX_SCHEMA = "fmc-clash-matrix/0.1";
export const TEST_TYPES = ["hard", "hard_conservative", "clearance", "duplicates"] as const;
export type TestType = (typeof TEST_TYPES)[number];
/** Every test this tool makes is named "FMC <id> …": the only tests it ever edits, runs or removes. */
export const TEST_PREFIX = "FMC ";

export interface MatrixSide { role?: string; roles?: string[]; set?: string }
export interface MatrixTest { id: string; a: MatrixSide; b: MatrixSide; type: TestType; tolerance_mm?: number; note?: string }
export interface ClashMatrix { schema: string; name: string; revision: string; approved?: string; tests: MatrixTest[] }

/** A test as the bridge gets it: a side is either roles or one set. */
export interface PlannedTest { id: string; name: string; type: TestType; tolerance_mm: number; a: { roles?: string[]; set?: string }; b: { roles?: string[]; set?: string } }

const sideRoles = (s: MatrixSide): string[] => [...new Set([...(s.role ? [s.role] : []), ...(s.roles ?? [])].map((r) => r.trim().toUpperCase()).filter(Boolean))];
const sideLabel = (s: MatrixSide) => (s.set ? `set ${s.set}` : sideRoles(s).join("+"));

/** What is wrong with a matrix, one sentence each; empty when it can be used. */
export function matrixProblems(m: unknown): string[] {
  const p: string[] = [];
  const x = m as Partial<ClashMatrix> | null;
  if (!x || typeof x !== "object") return ["The clash matrix isn't a JSON object"];
  if (x.schema !== MATRIX_SCHEMA) p.push(`schema must be "${MATRIX_SCHEMA}" (got ${JSON.stringify(x.schema ?? null)})`);
  if (!String(x.name ?? "").trim()) p.push("The matrix needs a name");
  if (!String(x.revision ?? "").trim()) p.push("The matrix needs a revision (e.g. P01)");
  if (!Array.isArray(x.tests) || !x.tests.length) { p.push("The matrix has no tests"); return p; }
  const seen = new Set<string>();
  x.tests.forEach((t, k) => {
    const at = `Test ${k + 1}${t?.id ? ` (${t.id})` : ""}`;
    if (!t || typeof t !== "object") { p.push(`${at} isn't an object`); return; }
    if (!/^[A-Za-z0-9._-]{1,24}$/.test(String(t.id ?? ""))) p.push(`${at}: id must be 1-24 letters, digits, dot, dash or underscore`);
    else if (seen.has(t.id)) p.push(`${at}: id ${t.id} is used twice`);
    else seen.add(t.id);
    if (!TEST_TYPES.includes(t.type as TestType)) p.push(`${at}: type must be ${TEST_TYPES.join(", ")}`);
    const tol = t.tolerance_mm;
    if (tol !== undefined && (typeof tol !== "number" || !Number.isFinite(tol) || tol < 0 || tol > 5000)) p.push(`${at}: tolerance_mm must be 0 to 5000`);
    if (t.type === "clearance" && !(typeof tol === "number" && tol > 0)) p.push(`${at}: a clearance test needs tolerance_mm above 0 (the clearance)`);
    for (const [name, side] of [["a", t.a], ["b", t.b]] as const) {
      if (!side || typeof side !== "object") { p.push(`${at}: side ${name} is missing`); continue; }
      const roles = sideRoles(side);
      const set = String(side.set ?? "").trim();
      if (set && roles.length) p.push(`${at}: side ${name} is either roles or a set, not both`);
      else if (!set && !roles.length) p.push(`${at}: side ${name} needs a role (role code, Manual 4.3) or a set`);
      for (const r of roles) if (!ROLE_CODES.includes(r)) p.push(`${at}: side ${name}: ${r} is not a role code (Manual 4.3)`);
    }
  });
  return p;
}

/** The test's name in Navisworks: "FMC <id> · <a> vs <b> (<type>[ <tol> mm])". The id is what identifies it later. */
export function testName(t: MatrixTest): string {
  const tol = t.tolerance_mm ? ` ${t.tolerance_mm} mm` : "";
  return `${TEST_PREFIX}${t.id} · ${sideLabel(t.a)} vs ${sideLabel(t.b)} (${t.type.replace("_", " ")}${tol})`;
}

/** The id a Formcraft test carries, or null for a person's test (the bridge reads names the same way). */
export function idOfTest(name: string): string | null {
  if (!name.startsWith(TEST_PREFIX)) return null;
  const rest = name.slice(TEST_PREFIX.length);
  const sp = rest.indexOf(" ");
  return sp < 0 ? rest : rest.slice(0, sp);
}

const side = (s: MatrixSide) => (String(s.set ?? "").trim() ? { set: String(s.set).trim() } : { roles: sideRoles(s) });

/** The checked matrix as the bridge's tests; only ids in `only` when given. */
export function planTests(m: ClashMatrix, only: string[] = []): PlannedTest[] {
  const want = new Set(only.map((o) => o.trim()).filter(Boolean));
  return m.tests.filter((t) => !want.size || want.has(t.id)).map((t) => ({
    id: t.id, name: testName(t), type: t.type, tolerance_mm: t.tolerance_mm ?? 0, a: side(t.a), b: side(t.b),
  }));
}

/**
 * What the open federation can test: for each planned test, the roles it needs that no model in the document carries.
 * Sets are checked by the bridge (they live in the document).
 */
export function coverage(tests: PlannedTest[], modelFiles: string[]) {
  const have = new Set(modelFiles.map(roleOfModel));
  return tests.map((t) => {
    const missing = [...(t.a.roles ?? []), ...(t.b.roles ?? [])].filter((r) => !have.has(r));
    return { id: t.id, name: t.name, ready: missing.length === 0, missing_roles: [...new Set(missing)] };
  });
}
