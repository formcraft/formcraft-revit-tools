/**
 * fmc_extstore (GAP-19): the Formcraft Extensible Storage record on elements. One fixed schema, FMC_ExtStore, holds the
 * element's FMC id, the batch that made or last stamped it, the recipe hash and the source. The Revit side
 * (commandset/Services/Fmc/FmcExtStore.cs) uses the same GUID; a test checks they agree.
 * Everything here is pure: no Revit, no files, so it is tested offline.
 */

/** The schema's fixed GUID. Never change it: elements stamped with it are found by it. */
export const EXTSTORE_SCHEMA_GUID = "cf567a49-572e-4e9a-afd1-f827205bd249";
export const EXTSTORE_SCHEMA_NAME = "FMC_ExtStore";
export const EXTSTORE_VENDOR = "Formcraft";
export const EXTSTORE_FIELDS = ["FmcId", "BatchId", "RecipeHash", "Source"] as const;

/** GUIDs other Formcraft schemas already use. The extstore schema must never be one of them. */
export const OTHER_FMC_SCHEMA_GUIDS = [
  "a9d9490d-63e7-4081-82bd-1ebf5b80654f", // FMC_DiagramSource
  "6b1a3f0e-4c2d-4f7a-9a51-2f8e0d9c7b31", // FMC_OpName
  "b49826ed-9229-41a3-85da-570aeca63984", // FMC_LiveData
];

export const EXTSTORE_SOURCES = ["recipe", "batch", "brief", "kit", "person", "import", "ai"] as const;
export type ExtSource = typeof EXTSTORE_SOURCES[number];

export interface ExtRecord {
  /** The element id in the document, as a string (ids are 64-bit on Revit 2024+). */
  id: string;
  fmc_id: string;
  batch_id: string;
  recipe_hash: string;
  source: string;
}

/** A row the Revit side reads back: the record plus where it sits. */
export interface ExtRow extends ExtRecord {
  unique_id?: string;
  category?: string;
  /** "owned_by_other" when another user holds it in a workshared model */
  checkout?: string;
  owner?: string;
}

const FMC_ID = /^FMC-[A-Z0-9][A-Z0-9_.-]{1,94}$/;
const BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const HASH = /^(sha256:)?[0-9a-f]{64}$/;
const ELEMENT_ID = /^-?[0-9]{1,19}$/;

/** What's wrong with one record (empty when it's fine). */
export function recordProblems(r: Partial<ExtRecord>): string[] {
  const out: string[] = [];
  const id = String(r.id ?? "").trim();
  if (!ELEMENT_ID.test(id) || id === "-1" || id === "0") out.push(`element id "${id}" isn't an element id`);
  const fmc = String(r.fmc_id ?? "").trim();
  if (!FMC_ID.test(fmc)) out.push(`${id}: FmcId "${fmc}" isn't an FMC id (FMC-, then capitals, digits, _ . -, up to 96 characters)`);
  const batch = String(r.batch_id ?? "").trim();
  if (!BATCH_ID.test(batch)) out.push(`${id}: BatchId "${batch}" is empty or has characters a batch id can't have`);
  const hash = String(r.recipe_hash ?? "").trim();
  if (hash && !HASH.test(hash)) out.push(`${id}: RecipeHash isn't a lowercase sha256 (64 hex, optional sha256: prefix)`);
  const source = String(r.source ?? "").trim();
  if (!(EXTSTORE_SOURCES as readonly string[]).includes(source)) out.push(`${id}: Source "${source}" isn't one of ${EXTSTORE_SOURCES.join(", ")}`);
  return out;
}

export function normalise(r: ExtRecord): ExtRecord {
  return { id: String(r.id).trim(), fmc_id: r.fmc_id.trim(), batch_id: r.batch_id.trim(), recipe_hash: (r.recipe_hash ?? "").trim(), source: r.source.trim() };
}

export type PlanAction = "create" | "update" | "same" | "skip";

export interface PlanRow {
  id: string;
  action: PlanAction;
  changes: Array<{ field: string; from: string; to: string }>;
  reason?: string;
}

const FIELD_OF: Record<string, keyof ExtRecord> = { FmcId: "fmc_id", BatchId: "batch_id", RecipeHash: "recipe_hash", Source: "source" };

/**
 * The write plan: each record against what the element holds now. An element another user owns is skipped (never
 * stamped). An element that already carries a different FmcId is skipped unless reassign is set: FMC ids are stable.
 */
export function planWrites(records: ExtRecord[], existing: ExtRow[], opts: { reassign?: boolean } = {}): { rows: PlanRow[]; problems: string[] } {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const r of records) seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
  for (const [id, n] of seen) if (n > 1) problems.push(`element ${id} is in the write ${n} times`);
  const ids = new Map<string, string>();
  for (const r of records) {
    const other = ids.get(r.fmc_id);
    if (other && other !== r.id) problems.push(`FmcId ${r.fmc_id} is given to elements ${other} and ${r.id}`);
    ids.set(r.fmc_id, r.id);
  }
  for (const r of records) problems.push(...recordProblems(r));
  const byId = new Map(existing.map((e) => [String(e.id), e]));
  // an FmcId already used by a different element in the model
  const used = new Map<string, string>();
  for (const e of existing) if (e.fmc_id) used.set(e.fmc_id, String(e.id));
  const rows: PlanRow[] = [];
  for (const raw of records) {
    const r = normalise(raw);
    const now = byId.get(r.id);
    if (now?.checkout === "owned_by_other") { rows.push({ id: r.id, action: "skip", changes: [], reason: `owned by ${now.owner || "another user"}` }); continue; }
    const holder = used.get(r.fmc_id);
    if (holder && holder !== r.id) { rows.push({ id: r.id, action: "skip", changes: [], reason: `FmcId ${r.fmc_id} is already on element ${holder}` }); continue; }
    if (!now || !now.fmc_id) {
      rows.push({ id: r.id, action: "create", changes: EXTSTORE_FIELDS.map((f) => ({ field: f, from: "", to: r[FIELD_OF[f]] })) });
      continue;
    }
    if (now.fmc_id !== r.fmc_id && !opts.reassign) { rows.push({ id: r.id, action: "skip", changes: [], reason: `element already carries FmcId ${now.fmc_id} (set reassign to change it)` }); continue; }
    const changes = EXTSTORE_FIELDS
      .map((f) => ({ field: f, from: String(now[FIELD_OF[f]] ?? ""), to: r[FIELD_OF[f]] }))
      .filter((c) => c.from !== c.to);
    rows.push({ id: r.id, action: changes.length ? "update" : "same", changes });
  }
  return { rows, problems };
}

export interface AuditResult {
  stamped: number;
  batches: Record<string, number>;
  sources: Record<string, number>;
  duplicate_fmc_ids: Array<{ fmc_id: string; ids: string[] }>;
  invalid: Array<{ id: string; problems: string[] }>;
  owned_by_other: string[];
}

/** The model-wide audit: duplicates, bad values, counts by batch and source. */
export function auditRows(rows: ExtRow[]): AuditResult {
  const byFmc = new Map<string, string[]>();
  const batches: Record<string, number> = {};
  const sources: Record<string, number> = {};
  const invalid: AuditResult["invalid"] = [];
  const owned: string[] = [];
  for (const r of rows) {
    const list = byFmc.get(r.fmc_id) ?? [];
    list.push(String(r.id));
    byFmc.set(r.fmc_id, list);
    batches[r.batch_id || "(none)"] = (batches[r.batch_id || "(none)"] ?? 0) + 1;
    sources[r.source || "(none)"] = (sources[r.source || "(none)"] ?? 0) + 1;
    const p = recordProblems(r);
    if (p.length) invalid.push({ id: String(r.id), problems: p });
    if (r.checkout === "owned_by_other") owned.push(String(r.id));
  }
  const duplicate_fmc_ids = [...byFmc].filter(([, ids]) => ids.length > 1).map(([fmc_id, ids]) => ({ fmc_id, ids }));
  return { stamped: rows.length, batches, sources, duplicate_fmc_ids, invalid, owned_by_other: owned };
}

/** Rows from the Revit reply, typed and trimmed; anything that isn't a row is dropped. */
export function asRows(raw: unknown): ExtRow[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { rows?: unknown }).rows) ? (raw as { rows: unknown[] }).rows : [];
  return list.filter((x): x is Record<string, unknown> => !!x && typeof x === "object").map((x) => ({
    id: String(x.id ?? ""),
    fmc_id: String(x.fmc_id ?? ""),
    batch_id: String(x.batch_id ?? ""),
    recipe_hash: String(x.recipe_hash ?? ""),
    source: String(x.source ?? ""),
    unique_id: x.unique_id === undefined ? undefined : String(x.unique_id),
    category: x.category === undefined ? undefined : String(x.category),
    checkout: x.checkout === undefined ? undefined : String(x.checkout),
    owner: x.owner === undefined ? undefined : String(x.owner),
  }));
}
