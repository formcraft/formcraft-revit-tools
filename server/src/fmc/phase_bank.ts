/**
 * phase.* and revision.* from FMC_Standards_Building.json.
 * A missing key uses the provisional default below. provisional never passes.
 * draft or approved with a clause (or note) can pass. A null value is UNKNOWN
 * unless a provisional default exists, in which case that default is used and labelled PROVISIONAL.
 * No new config file: these keys live in the standards bank when the founder approves them.
 */

export type PhaseSource = "standards" | "provisional" | "unknown";

export interface PhaseBankEntry {
  value: unknown;
  status?: string;
  clause?: string;
  note?: string;
  unit?: string;
}

export interface CitedValue {
  key: string;
  value: unknown;
  source: PhaseSource;
  clause: string;
}

export const PHASE_DEFAULTS: Record<string, unknown> = {
  "phase.existing_name": "Existing",
  "phase.new_work_name": "New Construction",
  "phase.visible_filters": ["Show Complete", "Show New", "Show Previous + New"],
  "phase.suspicious_filters": ["None", "Show Previous + Demo"],
  "phase.room_match": "number",
  "phase.max_ops": 50,
  "phase.demo_in_first_allowed": false,
  "phase.host_match": "same",
  "revision.description_prefix": "FMC",
  "revision.cloud_pad_mm": 300,
  "revision.max_clouds": 50,
  "revision.titleblock_params": ["Current Revision", "Current Revision Date"],
  "revision.schedule_required": true,
  "revision.sequence_step": 1,
};

/** One example object per key, the shape a standards-bank entry uses. */
export const PHASE_BANK_SHAPES: Record<string, Record<string, unknown>> = {
  "phase.existing_name": { value: "Existing", status: "provisional", clause: "", note: "Phase treated as Existing. Demolition in this phase is a finding." },
  "phase.new_work_name": { value: "New Construction", status: "provisional", clause: "", note: "Name of the new-work phase. A batch still declares its own phase." },
  "phase.visible_filters": { value: ["Show Complete", "Show New", "Show Previous + New"], status: "provisional", clause: "", note: "Phase filters that keep new work visible." },
  "phase.suspicious_filters": { value: ["None", "Show Previous + Demo"], status: "provisional", clause: "", note: "Phase filters that hide new work." },
  "phase.room_match": { value: "number", status: "provisional", clause: "", note: "number or name. How a room or space is matched across phases." },
  "phase.max_ops": { value: 50, unit: "ops", status: "provisional", clause: "", note: "Operations in one fmc_phase apply. The tool never sends more than 50." },
  "phase.demo_in_first_allowed": { value: false, status: "provisional", clause: "", note: "false: demolition in the first phase is a finding." },
  "phase.host_match": { value: "same", status: "provisional", clause: "", note: "same: a hosted family must share the host's created and demolished phases." },
  "revision.description_prefix": { value: "FMC", status: "provisional", clause: "", note: "Prefix when a revision is opened without a description." },
  "revision.cloud_pad_mm": { value: 300, unit: "mm", status: "provisional", clause: "", note: "Padding around the changed elements' extents." },
  "revision.max_clouds": { value: 50, status: "provisional", clause: "", note: "Clouds in one revision_cloud call. The tool never places more than 50." },
  "revision.titleblock_params": { value: ["Current Revision", "Current Revision Date"], status: "provisional", clause: "", note: "Titleblock parameters an issue checks. Blank or missing blocks Issued. The tool does not invent a signature." },
  "revision.schedule_required": { value: true, status: "provisional", clause: "", note: "true: a sheet in the issue set needs a revision schedule." },
  "revision.sequence_step": { value: 1, status: "provisional", clause: "", note: "How many sequence steps an issue bump represents. Revit assigns the number." },
};

function clauseOf(entry: PhaseBankEntry | undefined): string {
  return (entry?.clause || entry?.note || "").trim();
}

function statusOf(entry: PhaseBankEntry | undefined): string {
  return (entry?.status ?? "").trim().toLowerCase();
}

function decide(key: string, value: unknown, entry: PhaseBankEntry | undefined, nullFallback: boolean): CitedValue {
  if (value == null) return { key, value: null, source: "unknown", clause: clauseOf(entry) || "Bank value is null." };
  if (nullFallback) return { key, value, source: "provisional", clause: "Bank value is null. PROVISIONAL default used." };
  const status = statusOf(entry);
  const clause = clauseOf(entry);
  if (status === "provisional") return { key, value, source: "provisional", clause: clause || "PROVISIONAL bank entry." };
  if ((status === "draft" || status === "approved" || status === "") && clause) return { key, value, source: "standards", clause };
  return { key, value, source: "provisional", clause: clause || "PROVISIONAL. The bank entry has no clause." };
}

/** Keep a phase.* or revision.* object. A non-object is ignored. Never throws. */
export function phaseEntriesFromStandards(standards: Record<string, unknown> | null | undefined): Record<string, PhaseBankEntry> {
  const out: Record<string, PhaseBankEntry> = {};
  if (!standards || typeof standards !== "object") return out;
  for (const [key, raw] of Object.entries(standards)) {
    if ((!key.startsWith("phase.") && !key.startsWith("revision.")) || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    out[key] = {
      value: "value" in row ? row.value : null,
      status: typeof row.status === "string" ? row.status : undefined,
      clause: typeof row.clause === "string" ? row.clause : undefined,
      note: typeof row.note === "string" ? row.note : undefined,
      unit: typeof row.unit === "string" ? row.unit : undefined,
    };
  }
  return out;
}

export function citePhase(key: string, bank?: Record<string, PhaseBankEntry>): CitedValue {
  const entry = bank?.[key];
  const fallback = PHASE_DEFAULTS[key];
  if (!entry) {
    return fallback === undefined
      ? { key, value: null, source: "unknown", clause: "No bank entry and no default." }
      : { key, value: fallback, source: "provisional", clause: "PROVISIONAL default. Not in the standards bank." };
  }
  if (entry.value == null) {
    if (fallback === undefined) return decide(key, null, entry, false);
    return decide(key, fallback, entry, true);
  }
  return decide(key, entry.value, entry, false);
}

export type PhaseVerdict = "PASS" | "FAIL" | "PROVISIONAL" | "UNKNOWN";

/** A clean check passes only against a draft or approved entry that has a clause. Provisional never passes. Null is UNKNOWN. */
export function verdictFor(ok: boolean, cited: CitedValue): PhaseVerdict {
  if (cited.source === "unknown" || cited.value == null) return "UNKNOWN";
  if (!ok) return "FAIL";
  if (cited.source === "provisional") return "PROVISIONAL";
  return "PASS";
}

export function asString(cited: CitedValue): string | null {
  if (cited.value == null) return null;
  if (typeof cited.value === "string") return cited.value;
  if (typeof cited.value === "number" || typeof cited.value === "boolean") return String(cited.value);
  return null;
}

export function asNumber(cited: CitedValue): number | null {
  if (typeof cited.value === "number" && Number.isFinite(cited.value)) return cited.value;
  if (typeof cited.value === "string" && cited.value.trim() && Number.isFinite(Number(cited.value))) return Number(cited.value);
  return null;
}

export function asBoolean(cited: CitedValue): boolean | null {
  if (typeof cited.value === "boolean") return cited.value;
  if (cited.value === "true") return true;
  if (cited.value === "false") return false;
  return null;
}

export function asStringList(cited: CitedValue): string[] | null {
  if (!Array.isArray(cited.value)) return null;
  const list = cited.value.map((item) => String(item).trim()).filter(Boolean);
  return list;
}

/** The apply cap. A bank value above 50 is still 50. A missing value is the provisional 50. */
export function opCap(bank?: Record<string, PhaseBankEntry>, key = "phase.max_ops"): { cap: number; cited: CitedValue } {
  const cited = citePhase(key, bank);
  const raw = asNumber(cited);
  const cap = raw == null ? 50 : Math.max(1, Math.min(50, Math.floor(raw)));
  return { cap, cited };
}
