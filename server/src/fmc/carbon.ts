/**
 * GAP-24 fmc_carbon: embodied carbon by material and by assembly (category and type), read only.
 * Revit 2025 has no embodied-carbon API (EmbodiedCarbonAsset is 2027), so the factors come from the kit:
 * 07_Materials/FMC_CarbonFactors.json beside FMC_Materials.json, or a file passed as `factors`.
 * No factor is built in. A material without a sourced factor is listed, never guessed.
 */
import fs from "node:fs";
import path from "node:path";
import { sameName } from "./gapcommon.js";

const win = path.win32;

export const CARBON_FACTORS_FILE = "FMC_CarbonFactors.json";
export const CARBON_OWNER_NOTE =
  "Carbon factors come from the kit file 07_Materials/FMC_CarbonFactors.json. Family Kit Loader is the co-owner who supplies and approves them. " +
  "This tool has no built-in factors and does not invent any.";

export interface CarbonFactor {
  /** A material name, or a material class when match is "class". */
  material: string;
  match?: "name" | "class";
  kgco2e_per_m3?: number;
  kgco2e_per_kg?: number;
  /** Only used with kgco2e_per_kg. Else the kit material's physical.density_kg_m3. */
  density_kg_m3?: number;
  stage?: string;
  source?: string;
  status?: string;
}

export interface FactorFile { status?: string; source?: string; date?: string; factors?: CarbonFactor[] }

export interface LoadedFactors { path: string; found: boolean; status: string; factors: CarbonFactor[]; problems: string[] }

export interface CarbonMaterial { id?: string; name: string; class?: string; volume_m3: number; area_m2?: number; elements?: number }
export interface CarbonAssembly { category: string; type: string; material: string; volume_m3: number; elements?: number }
export interface CarbonRead { title?: string; revit_version?: string; materials: CarbonMaterial[]; assemblies: CarbonAssembly[]; unmeasured?: Record<string, number>; elements_read?: number; capped?: boolean }

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

export function factorsPathFor(materialsFile: string, explicit = ""): string {
  if (explicit.trim()) return explicit.trim();
  if (!materialsFile.trim()) return "";
  return win.join(win.dirname(materialsFile.trim()), CARBON_FACTORS_FILE);
}

export function checkFactors(file: FactorFile): { factors: CarbonFactor[]; problems: string[] } {
  const factors: CarbonFactor[] = [];
  const problems: string[] = [];
  (Array.isArray(file.factors) ? file.factors : []).forEach((f, i) => {
    const where = `factors[${i}]${f && typeof f.material === "string" ? ` (${f.material})` : ""}`;
    if (!f || typeof f.material !== "string" || !f.material.trim()) { problems.push(`${where}: no material.`); return; }
    const perM3 = isNum(f.kgco2e_per_m3);
    const perKg = isNum(f.kgco2e_per_kg);
    if (perM3 === perKg) { problems.push(`${where}: give exactly one of kgco2e_per_m3 or kgco2e_per_kg, a positive number.`); return; }
    if (!String(f.source ?? "").trim()) { problems.push(`${where}: no source (an EPD, a database and version, or a standard). Not used.`); return; }
    factors.push(f);
  });
  return { factors, problems };
}

export function loadFactors(file: string, read: (p: string) => string = (p) => fs.readFileSync(p, "utf8"), exists: (p: string) => boolean = (p) => fs.existsSync(p)): LoadedFactors {
  if (!file || !exists(file)) return { path: file, found: false, status: "missing", factors: [], problems: [file ? `${file} was not found.` : "No factor file path."] };
  let parsed: FactorFile;
  try { parsed = JSON.parse(read(file)) as FactorFile; } catch (e) { return { path: file, found: true, status: "invalid", factors: [], problems: [`${file} is not JSON: ${e instanceof Error ? e.message : String(e)}`] }; }
  const checked = checkFactors(parsed);
  return { path: file, found: true, status: String(parsed.status ?? "draft").toLowerCase(), ...checked };
}

/** physical.density_kg_m3 from the kit materials file, by material name. Only numbers already in the kit. */
export function kitDensities(materialsJson: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const list = (materialsJson as { materials?: Array<{ name?: string; physical?: { density_kg_m3?: unknown } }> })?.materials;
  for (const m of Array.isArray(list) ? list : []) {
    const d = m?.physical?.density_kg_m3;
    if (m?.name && isNum(d)) out.set(m.name.toLowerCase(), d);
  }
  return out;
}

export function factorFor(material: { name: string; class?: string }, factors: CarbonFactor[]): CarbonFactor | undefined {
  return factors.find((f) => (f.match ?? "name") === "name" && sameName(f.material, material.name))
    ?? (material.class ? factors.find((f) => f.match === "class" && sameName(f.material, material.class)) : undefined);
}

type Kg = { kg: number; method: string } | { reason: string };

function kgFor(material: { name: string; class?: string }, volume: number, factors: CarbonFactor[], densities: Map<string, number>): Kg & { factor?: CarbonFactor } {
  const f = factorFor(material, factors);
  if (!f) return { reason: "no factor" };
  if (isNum(f.kgco2e_per_m3)) return { kg: volume * f.kgco2e_per_m3, method: "volume x kgCO2e/m3", factor: f };
  const density = isNum(f.density_kg_m3) ? f.density_kg_m3 : densities.get(material.name.toLowerCase());
  if (!isNum(density)) return { reason: "factor is per kg and no density is in the factor or the kit material", factor: f };
  return { kg: volume * density * (f.kgco2e_per_kg as number), method: "volume x density x kgCO2e/kg", factor: f };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function computeCarbon(read: CarbonRead, loaded: LoadedFactors, densities: Map<string, number>) {
  const rows = [] as Array<Record<string, unknown>>;
  const unfactored = [] as Array<Record<string, unknown>>;
  let total = 0;
  let volume = 0;
  let factoredVolume = 0;
  let provisional = loaded.status !== "approved";
  for (const m of read.materials ?? []) {
    volume += m.volume_m3 || 0;
    const got = kgFor(m, m.volume_m3 || 0, loaded.factors, densities);
    if ("kg" in got) {
      total += got.kg;
      factoredVolume += m.volume_m3 || 0;
      if (String(got.factor?.status ?? "").toLowerCase() !== "approved") provisional = true;
      rows.push({ material: m.name, class: m.class ?? "", volume_m3: r2(m.volume_m3), kgco2e: r2(got.kg), method: got.method, factor_source: got.factor?.source ?? "", stage: got.factor?.stage ?? "" });
    } else if ((m.volume_m3 || 0) > 0) {
      unfactored.push({ material: m.name, class: m.class ?? "", volume_m3: r2(m.volume_m3), reason: got.reason });
    }
  }
  const assemblies = (read.assemblies ?? []).map((a) => {
    const cls = (read.materials ?? []).find((m) => sameName(m.name, a.material))?.class;
    const got = kgFor({ name: a.material, class: cls }, a.volume_m3 || 0, loaded.factors, densities);
    return { category: a.category, type: a.type, material: a.material, volume_m3: r2(a.volume_m3), kgco2e: "kg" in got ? r2(got.kg) : null };
  });
  const byAssembly = new Map<string, { category: string; type: string; volume_m3: number; kgco2e: number; unfactored_m3: number }>();
  for (const a of assemblies) {
    const k = `${a.category}\u0001${a.type}`;
    const row = byAssembly.get(k) ?? { category: a.category, type: a.type, volume_m3: 0, kgco2e: 0, unfactored_m3: 0 };
    row.volume_m3 = r2(row.volume_m3 + a.volume_m3);
    if (a.kgco2e == null) row.unfactored_m3 = r2(row.unfactored_m3 + a.volume_m3); else row.kgco2e = r2(row.kgco2e + a.kgco2e);
    byAssembly.set(k, row);
  }
  const noFactors = loaded.factors.length === 0;
  const status = noFactors ? "NO_FACTORS" : unfactored.length ? "PARTIAL" : provisional ? "PROVISIONAL" : "COMPLETE";
  return {
    status,
    can_pass: status === "COMPLETE",
    totals: noFactors ? { kgco2e: null, tco2e: null } : { kgco2e: r2(total), tco2e: Math.round(total) / 1000 },
    volume_m3: r2(volume),
    coverage: volume > 0 ? Math.round((factoredVolume / volume) * 1000) / 10 : 0,
    materials: rows,
    unfactored,
    assemblies: [...byAssembly.values()].sort((a, b) => b.kgco2e - a.kgco2e || b.volume_m3 - a.volume_m3),
  };
}
