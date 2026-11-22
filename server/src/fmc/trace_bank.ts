/**
 * How fmc_trace reads a trace.* entry from the standards bank.
 * A provisional status never passes. A null value is UNKNOWN, and a numbered default is used
 * only when one exists, still labelled PROVISIONAL. Tables are read by size or by fixture.
 */

export type TraceStatus = "provisional" | "draft" | "approved" | "";

export interface TraceBankEntry {
  /** A number, a "1:N" ratio, null, or a table of those. */
  value: number | string | null | Record<string, number | string | null>;
  /** draft or approved, with a clause, may PASS. provisional never does. */
  status?: TraceStatus | string;
  /** Clause text. `note` is accepted as the same field. */
  clause?: string;
  note?: string;
  unit?: string;
  /** Used when value is a single percentage and the short-term allowance sits beside it. */
  short_term_pct?: number | null;
  /** Residual pressure in kPa when value is kg/cm². */
  kPa?: number | null;
}

export interface CitedLimit {
  key: string;
  /** Null when the bank value is null and there is no default. */
  value: number | null;
  source: "standards" | "provisional" | "unknown";
  clause: string;
}

/** The JSON shape Standards Bot should write for each trace.* key. */
export const TRACE_BANK_SHAPES: Record<string, TraceBankEntry> = {
  "trace.drain_fall_75": { value: "1:40", unit: "rise/run", status: "draft", clause: "clause text" },
  "trace.drain_fall_100": { value: "1:80", unit: "rise/run", status: "draft", clause: "clause text" },
  "trace.drain_fall_150": { value: "1:150", unit: "rise/run", status: "draft", clause: "clause text" },
  "trace.drain_fall_over": {
    value: { "225": "1:100", "300": "1:150" },
    unit: "rise/run", status: "draft", clause: "225 mm is 1:100. 300 mm and above is 1:150.",
  },
  "trace.drain_min_mm": { value: 100, unit: "mm", status: "draft", clause: "clause text" },
  "trace.vent_distance": { value: 300, unit: "mm", status: "draft", clause: "Vent connection within 300 mm of the trap outlet." },
  "trace.dead_leg": {
    value: { "12": 20, "22": 12, "28": 8, "over": 3 },
    unit: "m", status: "draft", clause: "Uninsulated hot water. Max length by pipe OD.",
  },
  "trace.supply_loading_units": {
    value: { wc_cistern: 0.25, basin: 0.25, urinal_flush_valve: 0.5, sink: 1, shower: 1, bath: 1.96, wc_flush_valve: 4.32 },
    status: "draft", clause: "Supply loading units. Not drainage fixture units.",
  },
  "trace.fixture_units": {
    value: { wc: 6, basin: 1, sink: 2, shower: 2, bath: 3, urinal: 3 },
    status: "draft", clause: "Drainage fixture units.",
  },
  "trace.pipe_capacity_fu": {
    value: { "15": 1, "22": 3, "28": 6, "32": 6, "40": 12, "50": 20, "54": 40 },
    unit: "FU", status: "draft", clause: "A size may be null.",
  },
  "trace.voltage_drop_pct": { value: 4, unit: "%", status: "draft", clause: "clause text" },
  "trace.voltage_drop_mV_per_A_m": {
    value: { "1.5": 29, "2.5": 18, "4": 11, "6": 7.3, "10": 4.4, "16": 2.8 },
    unit: "mV/A/m", status: "draft", clause: "Per cable size. A size may be null.",
  },
  "trace.cable_min_mm2": { value: 1.5, unit: "mm2", status: "draft", clause: "clause text" },
  "trace.phase_imbalance_max": {
    value: { max_pct: 5, short_term_pct: 10 },
    unit: "%", status: "draft", clause: "5% standing. 10% short-term allowance.",
  },
  "trace.residual_pressure_min": { value: 0.2, unit: "kg/cm2", kPa: 19.6, status: "draft", clause: "0.20 kg/cm² is 19.6 kPa." },
  "trace.overload_ratio": { value: 1, status: "draft", clause: "clause text" },
  "trace.max_points_per_circuit": { value: 10, status: "draft", clause: "clause text" },
  "trace.max_lights_per_circuit": { value: 12, status: "draft", clause: "clause text" },
  "trace.max_circuit_load_w": { value: 1000, unit: "W", status: "draft", clause: "clause text" },
  "trace.cross_connection": { value: 0, status: "draft", clause: "Supply must not join waste." },
  "trace.near_miss_mm": { value: 50, unit: "mm", status: "provisional", clause: "Joint tolerance." },
  "trace.touch_mm": { value: 10, unit: "mm", status: "provisional", clause: "Touch tolerance." },
  "trace.size_mismatch_mm": { value: 2, unit: "mm", status: "provisional", clause: "Size tolerance." },
  "trace.direction_deg": { value: 15, unit: "deg", status: "provisional", clause: "Direction tolerance." },
  "trace.connected_gap_mm": { value: 15, unit: "mm", status: "provisional", clause: "Connected gap." },
  "trace.voltage_tol_v": { value: 15, unit: "V", status: "provisional", clause: "Voltage tolerance." },
};

const SCALAR_DEFAULTS: Record<string, number> = {
  "trace.drain_fall_75": 1 / 40,
  "trace.drain_fall_100": 1 / 80,
  "trace.drain_fall_150": 1 / 150,
  "trace.vent_distance": 300,
  "trace.vent_max_mm": 300,
  "trace.drain_min_mm": 100,
  "trace.cable_min_mm2": 1.5,
  "trace.voltage_drop_pct": 4,
  "trace.overload_ratio": 1,
  "trace.max_points_per_circuit": 10,
  "trace.max_lights_per_circuit": 12,
  "trace.max_circuit_load_w": 1000,
  "trace.cross_connection": 0,
  "trace.near_miss_mm": 50,
  "trace.touch_mm": 10,
  "trace.size_mismatch_mm": 2,
  "trace.direction_deg": 15,
  "trace.connected_gap_mm": 15,
  "trace.voltage_tol_v": 15,
  "trace.residual_pressure_min": 19.6,
  "trace.phase_imbalance_pct": 5,
};

const TABLE_DEFAULTS: Record<string, Record<string, number>> = {
  "trace.drain_fall_over": { "225": 1 / 100, "300": 1 / 150 },
  "trace.dead_leg": { "12": 20, "22": 12, "28": 8, "over": 3 },
  "trace.supply_loading_units": {
    wc_cistern: 0.25, basin: 0.25, urinal_flush_valve: 0.5, sink: 1, shower: 1, bath: 1.96, wc_flush_valve: 4.32,
  },
  "trace.fixture_units": { wc: 6, basin: 1, sink: 2, shower: 2, bath: 3, urinal: 3 },
  "trace.pipe_capacity_fu": { "15": 1, "22": 3, "28": 6, "32": 6, "40": 12, "50": 20, "54": 40 },
  "trace.voltage_drop_mV_per_A_m": { "1.5": 29, "2.5": 18, "4": 11, "6": 7.3, "10": 4.4, "16": 2.8 },
  "trace.phase_imbalance_max": { max_pct: 5, short_term_pct: 10 },
};

/** Numbers still published for older callers. Tables are not flattened into this map. */
export const PHASE2_DEFAULTS: Record<string, number> = { ...SCALAR_DEFAULTS };

function clauseOf(entry: Partial<TraceBankEntry> | undefined): string {
  return (entry?.clause || entry?.note || "").trim();
}

function asRatio(value: unknown): number | null | undefined {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const ratio = /^1\s*:\s*(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (ratio) return 1 / Number(ratio[1]);
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isTable(value: TraceBankEntry["value"]): value is Record<string, number | string | null> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** Keep a trace.* object from the standards file. A non-object is ignored. Never throws. */
export function traceEntriesFromStandards(standards: Record<string, unknown> | null | undefined): Record<string, TraceBankEntry> {
  const out: Record<string, TraceBankEntry> = {};
  if (!standards || typeof standards !== "object") return out;
  for (const [key, raw] of Object.entries(standards)) {
    if (!key.startsWith("trace.") || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const value = ("value" in row ? row.value : null) as TraceBankEntry["value"];
    out[key] = {
      value: value === undefined ? null : value,
      status: typeof row.status === "string" ? row.status : undefined,
      clause: typeof row.clause === "string" ? row.clause : undefined,
      note: typeof row.note === "string" ? row.note : undefined,
      unit: typeof row.unit === "string" ? row.unit : undefined,
      short_term_pct: typeof row.short_term_pct === "number" || row.short_term_pct === null ? row.short_term_pct as number | null : undefined,
      kPa: typeof row.kPa === "number" || row.kPa === null ? row.kPa as number | null : undefined,
    };
  }
  return out;
}

function statusOf(entry: TraceBankEntry | undefined): string {
  return (entry?.status ?? "").trim().toLowerCase();
}

function cited(key: string, value: number | null, entry: TraceBankEntry | undefined, nullFallback: boolean): CitedLimit {
  const clause = clauseOf(entry);
  const status = statusOf(entry);
  if (value == null) {
    return { key, value: null, source: "unknown", clause: clause || "Bank value is null." };
  }
  if (nullFallback) {
    return { key, value, source: "provisional", clause: "Bank value is null. PROVISIONAL default used." };
  }
  if (status === "provisional") {
    return { key, value, source: "provisional", clause: clause || "PROVISIONAL bank entry." };
  }
  if ((status === "draft" || status === "approved" || status === "") && clause) {
    return { key, value, source: "standards", clause };
  }
  return { key, value, source: "provisional", clause: clause || "PROVISIONAL. The bank entry has no clause." };
}

export function citeLimit(key: string, bank?: Record<string, TraceBankEntry>): CitedLimit {
  const entry = bank?.[key];
  if (!entry) {
    const fallback = SCALAR_DEFAULTS[key];
    return fallback == null
      ? { key, value: null, source: "unknown", clause: "No bank entry and no default." }
      : { key, value: fallback, source: "provisional", clause: "PROVISIONAL default. Not in the standards bank." };
  }
  if (isTable(entry.value)) {
    return { key, value: null, source: "unknown", clause: clauseOf(entry) || "This key is a table. Read it by size or by fixture." };
  }
  const parsed = asRatio(entry.value);
  if (parsed === undefined) {
    return { key, value: null, source: "unknown", clause: clauseOf(entry) || "The bank value is not a number." };
  }
  if (parsed === null) {
    const fallback = SCALAR_DEFAULTS[key];
    if (fallback == null) return cited(key, null, entry, false);
    return cited(key, fallback, entry, true);
  }
  if (key === "trace.residual_pressure_min") {
    const pressure = entry.kPa != null ? entry.kPa : parsed <= 5 ? parsed * 98.0665 : parsed;
    return cited(key, pressure, entry, false);
  }
  return cited(key, parsed, entry, false);
}

export function citeCell(key: string, cell: string, bank?: Record<string, TraceBankEntry>): CitedLimit {
  const entry = bank?.[key];
  const fallback = TABLE_DEFAULTS[key]?.[cell];
  if (!entry || !isTable(entry.value)) {
    if (fallback == null) return { key, value: null, source: "unknown", clause: `No value for ${cell}.` };
    return { key, value: fallback, source: "provisional", clause: "PROVISIONAL default. Not in the standards bank." };
  }
  const raw = entry.value[cell];
  const parsed = raw === undefined ? undefined : asRatio(raw);
  if (parsed === undefined || parsed === null) {
    if (fallback == null) return cited(key, null, entry, false);
    return { key, value: fallback, source: "provisional", clause: parsed === null ? "Bank value is null. PROVISIONAL default used." : "PROVISIONAL default. The table has no row for this size." };
  }
  return cited(`${key}.${cell}`, parsed, entry, false);
}

export function fallLimit(sizeMm: number, bank?: Record<string, TraceBankEntry>): CitedLimit {
  if (sizeMm <= 75) return citeLimit("trace.drain_fall_75", bank);
  if (sizeMm <= 100) return citeLimit("trace.drain_fall_100", bank);
  if (sizeMm <= 150) return citeLimit("trace.drain_fall_150", bank);
  return citeCell("trace.drain_fall_over", sizeMm <= 225 ? "225" : "300", bank);
}

export function deadLegLimitMm(sizeMm: number, bank?: Record<string, TraceBankEntry>): CitedLimit {
  const cell = sizeMm <= 12 ? "12" : sizeMm <= 22 ? "22" : sizeMm <= 28 ? "28" : "over";
  const metres = citeCell("trace.dead_leg", cell, bank);
  if (metres.value == null) return metres;
  return { ...metres, value: metres.value * 1000 };
}

export function pipeCapacity(sizeMm: number, bank?: Record<string, TraceBankEntry>): CitedLimit {
  const steps = [15, 22, 28, 32, 40, 50, 54];
  const nominal = steps.find((step) => sizeMm <= step) ?? 54;
  return citeCell("trace.pipe_capacity_fu", String(nominal), bank);
}

export function nextPipeSize(sizeMm: number, units: number, bank?: Record<string, TraceBankEntry>): { nominal: number; limit: CitedLimit } | null {
  for (const nominal of [15, 22, 28, 32, 40, 50, 54]) {
    if (nominal <= sizeMm) continue;
    const limit = citeCell("trace.pipe_capacity_fu", String(nominal), bank);
    if (limit.value != null && limit.value >= units) return { nominal, limit };
  }
  return null;
}

export function loadingUnits(name: string, bank?: Record<string, TraceBankEntry>): { units: number | null; known: boolean; key: string; limit: CitedLimit } {
  const text = name.toLowerCase();
  const cell = /flush/.test(text) && /wc|closet/.test(text) ? "wc_flush_valve"
    : /urinal/.test(text) && /flush/.test(text) ? "urinal_flush_valve"
      : /\bwc\b|cistern|water closet|closet/.test(text) ? "wc_cistern"
        : /basin/.test(text) ? "basin"
          : /sink/.test(text) ? "sink"
            : /shower/.test(text) ? "shower"
              : /\bbath\b/.test(text) ? "bath"
                : /urinal/.test(text) ? "urinal_flush_valve"
                  : "";
  if (!cell) return { units: null, known: false, key: "trace.supply_loading_units", limit: citeCell("trace.supply_loading_units", "basin", bank) };
  const limit = citeCell("trace.supply_loading_units", cell, bank);
  return { units: limit.value, known: limit.value != null, key: "trace.supply_loading_units", limit };
}

export function voltageDropMv(areaMm2: number, bank?: Record<string, TraceBankEntry>): CitedLimit {
  const steps = ["1.5", "2.5", "4", "6", "10", "16"];
  const cell = steps.find((step) => areaMm2 <= Number(step) + 0.01) ?? "16";
  const match = steps.reduce((best, step) => Math.abs(Number(step) - areaMm2) < Math.abs(Number(best) - areaMm2) ? step : best, steps[0]);
  return citeCell("trace.voltage_drop_mV_per_A_m", match, bank);
}

export function phaseLimits(bank?: Record<string, TraceBankEntry>): { standing: CitedLimit; shortTerm: CitedLimit } {
  const entry = bank?.["trace.phase_imbalance_max"];
  const standing = citeCell("trace.phase_imbalance_max", "max_pct", bank);
  let short = citeCell("trace.phase_imbalance_max", "short_term_pct", bank);
  if (entry && !isTable(entry.value) && entry.short_term_pct != null) {
    short = cited("trace.phase_imbalance_max.short_term_pct", entry.short_term_pct, entry, false);
  }
  if (!entry) {
    return {
      standing: { key: "trace.phase_imbalance_max", value: 5, source: "provisional", clause: "PROVISIONAL default. Not in the standards bank." },
      shortTerm: { key: "trace.phase_imbalance_max", value: 10, source: "provisional", clause: "PROVISIONAL default. Not in the standards bank." },
    };
  }
  if (!isTable(entry.value) && asRatio(entry.value) != null) {
    const single = citeLimit("trace.phase_imbalance_max", bank);
    return { standing: single, shortTerm: short.value == null ? { ...single, value: 10, source: "provisional", clause: "PROVISIONAL short-term allowance." } : short };
  }
  return { standing, shortTerm: short };
}
