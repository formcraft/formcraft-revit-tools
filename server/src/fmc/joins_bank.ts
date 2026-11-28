/**
 * joins.* from FMC_Standards_Building.json.
 * A missing key uses the provisional default below and is labelled. provisional never passes.
 * draft or approved with a clause can pass. A null value uses the provisional default when one
 * exists, and is labelled. A null status (missing, blank, or "null") is UNKNOWN.
 * No new config file: these keys live in the standards bank when the founder approves them.
 */

export type JoinsSource = "standards" | "provisional" | "unknown";

export interface JoinsBankEntry {
  value: unknown;
  status?: string | null;
  clause?: string;
  note?: string;
  unit?: string;
}

export interface CitedValue {
  key: string;
  value: unknown;
  source: JoinsSource;
  clause: string;
}

export const JOINS_DEFAULTS: Record<string, number> = {
  "joins.gap_mm": 10,
  "joins.overlap_mm": 5,
  "joins.near_miss_mm": 50,
  "joins.leak_min_mm": 10,
  "joins.host_offset_mm": 20,
  "joins.search_mm": 300,
  "joins.scan_cap": 800,
  "joins.voxel_mm": 250,
  "joins.max_ops": 50,
  "joins.max_rays": 48,
  "joins.max_pairs": 400,
};

/** One example object per key, the shape a standards-bank entry uses. */
export const JOINS_BANK_SHAPES: Record<string, Record<string, unknown>> = {
  "joins.gap_mm": { value: 10, unit: "mm", status: "provisional", clause: "", note: "Face gap above this, and beyond joins.near_miss_mm, is JOIN-GAP. An unjoined wall end is JOIN-WALL-END-OPEN." },
  "joins.overlap_mm": { value: 5, unit: "mm", status: "provisional", clause: "", note: "Overlap past this is JOIN-OVERLAP. A larger overlap is reported and left for a person." },
  "joins.near_miss_mm": { value: 50, unit: "mm", status: "provisional", clause: "", note: "A gap above joins.gap_mm and within this is JOIN-NEAR-MISS. Snap stays inside this distance." },
  "joins.leak_min_mm": { value: 10, unit: "mm", status: "provisional", clause: "", note: "Envelope openings smaller than this are not leaks. SEALED needs this key draft or approved, with a clause." },
  "joins.host_offset_mm": { value: 20, unit: "mm", status: "provisional", clause: "", note: "Host, face or level offset past this is a hosting finding. Wall base offset uses it as JOIN-BASE-OFFSET." },
  "joins.search_mm": { value: 300, unit: "mm", status: "provisional", clause: "", note: "Pairs farther apart than this are not compared. An attach or a rehost stays inside this distance." },
  "joins.scan_cap": { value: 800, unit: "elements", status: "provisional", clause: "", note: "An unscoped collector above this count is refused (FMC-JOINS-SCOPE). A scoped collector still stops at this count and marks partial." },
  "joins.voxel_mm": { value: 250, unit: "mm", status: "provisional", clause: "", note: "Edge and voxel step for the pressure test. The sample is capped (joins.max_rays, joins.max_pairs)." },
  "joins.max_ops": { value: 50, unit: "ops", status: "provisional", clause: "", note: "Operations in one fmc_joins_apply. The tool never sends more than 50." },
  "joins.max_rays": { value: 48, unit: "rays", status: "provisional", clause: "", note: "Rays from an interior seed. A capped sample with no leak is UNKNOWN, not SEALED." },
  "joins.max_pairs": { value: 400, unit: "pairs", status: "provisional", clause: "", note: "Element pairs measured in one read. Further pairs are left for a tighter scope." },
};

export const JOINS_KEYS = Object.keys(JOINS_DEFAULTS);

function clauseOf(entry: JoinsBankEntry | undefined): string {
  return (entry?.clause || entry?.note || "").trim();
}

/** Keep a joins.* object. A non-object is ignored. Never throws. */
export function joinsEntriesFromStandards(standards: Record<string, unknown> | null | undefined): Record<string, JoinsBankEntry> {
  const out: Record<string, JoinsBankEntry> = {};
  if (!standards || typeof standards !== "object") return out;
  for (const [key, raw] of Object.entries(standards)) {
    if (!key.startsWith("joins.") || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    out[key] = {
      value: "value" in row ? row.value : null,
      status: row.status == null ? ("status" in row ? null : undefined) : String(row.status),
      clause: typeof row.clause === "string" ? row.clause : undefined,
      note: typeof row.note === "string" ? row.note : undefined,
      unit: typeof row.unit === "string" ? row.unit : undefined,
    };
  }
  return out;
}

export function citeJoins(key: string, bank?: Record<string, JoinsBankEntry>): CitedValue {
  const entry = bank?.[key];
  const fallback = JOINS_DEFAULTS[key];
  if (!entry) {
    return fallback === undefined
      ? { key, value: null, source: "unknown", clause: "No bank entry and no default." }
      : { key, value: fallback, source: "provisional", clause: "PROVISIONAL default. Not in the standards bank." };
  }
  if (entry.value == null) {
    if (fallback === undefined) return { key, value: null, source: "unknown", clause: clauseOf(entry) || "Bank value is null." };
    return { key, value: fallback, source: "provisional", clause: "Bank value is null. PROVISIONAL default used." };
  }
  const status = entry.status == null ? "" : String(entry.status).trim().toLowerCase();
  const clause = clauseOf(entry);
  if (status === "" || status === "null") {
    return { key, value: entry.value, source: "unknown", clause: clause || "Null status is UNKNOWN." };
  }
  if (status === "provisional") {
    return { key, value: entry.value, source: "provisional", clause: clause || "PROVISIONAL bank entry." };
  }
  if ((status === "draft" || status === "approved") && clause) {
    return { key, value: entry.value, source: "standards", clause };
  }
  if (status === "draft" || status === "approved") {
    return { key, value: entry.value, source: "provisional", clause: "PROVISIONAL. The bank entry has no clause." };
  }
  return { key, value: entry.value, source: "unknown", clause: clause || "Null status is UNKNOWN." };
}

export type JoinsVerdict = "PASS" | "FAIL" | "PROVISIONAL" | "UNKNOWN";

/**
 * A clean check passes only against a draft or approved entry that has a clause. Provisional never passes. Null is UNKNOWN.
 * P-fmc_joins-02: a finding against a provisional limit is not FAIL either; it is PROVISIONAL (advisory) until the key is draft or approved.
 */
export function verdictFor(ok: boolean, cited: CitedValue): JoinsVerdict {
  if (cited.source === "unknown" || cited.value == null) return "UNKNOWN";
  if (cited.source === "provisional") return "PROVISIONAL";
  if (!ok) return "FAIL";
  return "PASS";
}

export function asNumber(cited: CitedValue): number | null {
  if (typeof cited.value === "number" && Number.isFinite(cited.value)) return cited.value;
  if (typeof cited.value === "string" && cited.value.trim() && Number.isFinite(Number(cited.value))) return Number(cited.value);
  return null;
}

/** The apply cap. A bank value above 50 is still 50. A missing value is the provisional 50. */
export function opCap(bank?: Record<string, JoinsBankEntry>): { cap: number; cited: CitedValue } {
  const cited = citeJoins("joins.max_ops", bank);
  const raw = asNumber(cited);
  const cap = raw == null ? 50 : Math.max(1, Math.min(50, Math.floor(raw)));
  return { cap, cited };
}
