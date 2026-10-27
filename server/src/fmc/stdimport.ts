/**
 * Standards digests into the kit (owner 27 Oct: "whenever we break down standards, they enter our prepared data
 * structure, fast"). A digest is one document read into rules: {id, file, title, relevance, rules [{key, value, unit,
 * clause}], gaps, procedures, clause_index}. mergeDigest folds it into the two kit files without overwriting anything:
 * a new key is added as proposed and cites the source; a key already there with the same value gains the source as
 * corroboration; a key with a different value is a conflict, reported and logged as a gap, never applied. The source
 * record is upserted by id (or the PDF's fingerprint), so reading a document again replaces its record instead of
 * adding a second. Keys stay a map (one lookup per key); each source lists its keys. Pure: the caller reads and writes.
 */
import { Source, SourceGap, SourcesFile, StandardEntry, StandardsFile } from "./standards.js";

export interface DigestRule { key: string; value: unknown; unit?: string; clause?: string; applies_to?: string }
export interface Digest {
  id: string; file?: string; title?: string; jurisdiction?: string; edition?: string; pages?: number; group?: string; relevance?: string;
  summary?: string; rules?: Array<DigestRule | string>; procedures?: unknown[]; clause_index?: Record<string, unknown>;
  conflicts?: unknown[]; gaps?: Array<Partial<SourceGap> | string>; read?: { parts?: string[]; not_read?: string[] }; sha256?: string;
}
export interface MergeReport { source: string; added: string[]; corroborated: string[]; conflicts: Array<{ key: string; kit: unknown; doc: unknown; clause?: string }>; skipped: string[] }

type Entry = StandardEntry & { sources?: string[]; clause?: string; applies_to?: string; conflicts?: Array<{ source: string; value: unknown; clause?: string }> };

/** Dotted lowercase keys: "Concrete Cover.Min XC1" → "concrete_cover.min_xc1". */
export function normKey(k: string): string {
  return k.trim().toLowerCase().replace(/[^a-z0-9.]+/g, "_").replace(/_*\._*/g, ".").replace(/^[._]+|[._]+$/g, "");
}

/** Same value, ignoring key order and number formatting ("2.0" = 2). */
export function sameValue(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown => {
    if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v);
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/**
 * Fold one digest into the kit. Rules of documents with relevance "none" (business law) are not put among the building
 * standards unless opts.all; the source is still registered. Returns new objects; the inputs are not changed.
 */
export function mergeDigest(kit: StandardsFile, reg: SourcesFile, d: Digest, opts: { all?: boolean; date?: string } = {}): { kit: StandardsFile; reg: SourcesFile; report: MergeReport } {
  if (!d?.id) throw new Error("A digest needs an id");
  const standards: Record<string, Entry> = { ...(kit.standards as Record<string, Entry>) };
  const report: MergeReport = { source: d.id, added: [], corroborated: [], conflicts: [], skipped: [] };
  const take = opts.all || (d.relevance ?? "").toLowerCase() !== "none";
  const keys = new Set<string>();
  for (const raw of d.rules ?? []) {
    const r: DigestRule = typeof raw === "string" ? { key: raw, value: null } : raw;
    const key = normKey(r.key ?? "");
    if (!key || r.value === null || r.value === undefined) { if (key) report.skipped.push(key); continue; }
    if (!take) { report.skipped.push(key); continue; }
    keys.add(key);
    const cite = `${d.id}${r.clause ? ` ${r.clause}` : ""}`;
    const had = standards[key];
    if (!had) {
      standards[key] = { value: r.value, unit: r.unit ?? "", note: cite, status: "proposed", sources: [d.id],
        ...(r.clause ? { clause: r.clause } : {}), ...(r.applies_to ? { applies_to: r.applies_to } : {}) };
      report.added.push(key);
    } else if (sameValue(had.value, r.value)) {
      standards[key] = { ...had, sources: [...new Set([...(had.sources ?? []), d.id])] };
      report.corroborated.push(key);
    } else {
      const others = (had.conflicts ?? []).filter((c) => c.source !== d.id);
      standards[key] = { ...had, conflicts: [...others, { source: d.id, value: r.value, ...(r.clause ? { clause: r.clause } : {}) }] };
      report.conflicts.push({ key, kit: had.value, doc: r.value, clause: r.clause });
    }
  }

  // the reader's own judgement: conflicts it found against a kit key under another name (planning.* vs site.*)
  for (const c of d.conflicts ?? []) {
    if (!take || !c || typeof c !== "object") continue;
    const o = c as { key?: string; kit_key?: string; doc_value?: unknown; value?: unknown; clause?: string };
    const key = normKey(o.kit_key ?? o.key ?? "");
    const had = standards[key], value = o.doc_value ?? o.value;
    if (!had || value === undefined || sameValue(had.value, value) || report.conflicts.some((x) => x.key === key)) continue;
    standards[key] = { ...had, conflicts: [...(had.conflicts ?? []).filter((x) => x.source !== d.id), { source: d.id, value, ...(o.clause ? { clause: o.clause } : {}) }] };
    report.conflicts.push({ key, kit: had.value, doc: value, clause: o.clause });
  }

  const gaps: SourceGap[] = (d.gaps ?? []).map((g, i) => {
    const o = typeof g === "string" ? { what: g } : g;
    return { id: `${d.id}-G${i + 1}`, what: o.what ?? "", where: o.where ?? "", kind: o.kind ?? "", status: o.status ?? "open" };
  });
  report.conflicts.forEach((c, i) => gaps.push({ id: `${d.id}-C${i + 1}`, what: `${c.key}: kit has ${JSON.stringify(c.kit)}, the document says ${JSON.stringify(c.doc)}`, where: c.clause ?? "", kind: "conflict", status: "open" }));
  const prev = reg.sources.find((s) => s.id === d.id || (d.sha256 && s.sha256 === d.sha256));
  const src: Source & Record<string, unknown> = {
    ...(prev ?? {}), id: d.id, title: d.title ?? prev?.title ?? d.id,
    ...(d.jurisdiction ? { jurisdiction: d.jurisdiction } : {}), ...(d.file ? { file: d.file } : {}), ...(d.sha256 ? { sha256: d.sha256 } : {}),
    ...(d.pages ? { pages: d.pages } : {}), revision: { ...(prev?.revision ?? {}), ...(d.edition ? { edition: d.edition } : {}) },
    read: { parts: d.read?.parts ?? [], not_read: d.read?.not_read ?? [], date: opts.date ?? new Date().toISOString().slice(0, 10), method: "digest (fmc-import-digests)" },
    keys: [...new Set([...(prev?.keys ?? []), ...keys])].sort(), gaps: [...(prev?.gaps ?? []).filter((g) => !g.id.startsWith(`${d.id}-`)), ...gaps],
    ...(d.group ? { group: d.group } : {}), ...(d.relevance ? { relevance: d.relevance } : {}), ...(d.summary ? { summary: d.summary } : {}),
    ...(d.procedures?.length ? { procedures: d.procedures } : {}), ...(d.clause_index && Object.keys(d.clause_index).length ? { clause_index: d.clause_index } : {}),
  };
  const sources = prev ? reg.sources.map((s) => (s === prev ? src : s)) : [...reg.sources, src];
  return { kit: { ...kit, standards }, reg: { ...reg, sources }, report };
}

/**
 * A decision on a conflict (owner 27 Oct: "fix all those conflicts"). keep: the kit value stands; adopt: the
 * document's value replaces it; set: a new value (a merged or stricter one); merge: fields added to an object value.
 * uses/range/note change alongside. The conflicts move to resolved with the decision, so the history stays; the
 * matching conflict gaps in the sources close.
 */
export interface Resolution { key: string; decision: "keep" | "adopt" | "set" | "merge"; value?: unknown; source?: string; uses?: Record<string, unknown>; range?: unknown[] | null; note?: string; reason: string }

export function applyResolutions(kit: StandardsFile, reg: SourcesFile, res: Resolution[], date = new Date().toISOString().slice(0, 10)): { kit: StandardsFile; reg: SourcesFile; applied: string[]; missing: string[] } {
  const standards: Record<string, Entry & { resolved?: unknown[] }> = { ...(kit.standards as Record<string, Entry>) };
  const applied: string[] = [], missing: string[] = [];
  for (const r of res) {
    const key = normKey(r.key), had = standards[key];
    if (!had) { missing.push(key); continue; }
    const pick = had.conflicts?.find((c) => !r.source || c.source === r.source);
    let value = had.value;
    if (r.decision === "adopt") { if (!pick) { missing.push(`${key} (no conflict to adopt)`); continue; } value = pick.value; }
    if (r.decision === "set") value = r.value;
    if (r.decision === "merge") value = { ...(had.value && typeof had.value === "object" ? (had.value as object) : { value: had.value }), ...(r.value as object) };
    const e: Entry & { resolved?: unknown[] } = { ...had, value, resolved: [...((had as { resolved?: unknown[] }).resolved ?? []), ...(had.conflicts ?? []).map((c) => ({ ...c, decision: r.decision, reason: r.reason, kit_was: had.value, date }))] };
    delete e.conflicts;
    if (r.uses) e.uses = { ...(had.uses ?? {}), ...r.uses };
    if (r.range === null) delete e.range; else if (r.range) e.range = r.range;
    if (r.note) e.note = `${r.note}${had.note ? ` | was: ${had.note}` : ""}`;
    if (r.decision !== "keep" && r.decision !== "merge") e.sources = [...new Set([...(had.sources ?? []), ...(pick ? [pick.source] : [])])];
    standards[key] = e; applied.push(key);
  }
  const done = new Set(applied);
  const sources = reg.sources.map((s) => ({ ...s, gaps: (s.gaps ?? []).map((g) => g.kind === "conflict" && done.has(g.what.split(":")[0]) ? { ...g, status: "resolved" } : g) }));
  return { kit: { ...kit, standards }, reg: { ...reg, sources }, applied, missing };
}
