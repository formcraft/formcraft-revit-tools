/**
 * Phase and revision planning. The add-in returns one compact snapshot per action.
 * This module decides the findings, the edits and the ledger line. It does not call Revit.
 */
import fs from "node:fs";
import path from "node:path";
import { ledgerDir } from "./ledger.js";
import {
  asBoolean, asNumber, asString, asStringList, citePhase, opCap, verdictFor,
  type CitedValue, type PhaseBankEntry, type PhaseVerdict,
} from "./phase_bank.js";

export const ID_CAP = 50;

export interface PhaseName { id: string; name: string; sequence: number }
export interface FilterName { id: string; name: string }
export interface RevisionName {
  id: string; sequence: number; description: string; issued: boolean;
  date: string; issued_by: string; issued_to: string;
}
export interface ViewName {
  id: string; name: string; view_type: string;
  phase_id: string; phase_name: string; filter_id: string; filter_name: string;
  sheet_id: string; sheet_number: string; is_template: boolean;
}
export interface ElementName {
  id: string; category: string;
  created_phase_id: string; demolished_phase_id: string;
  host_id: string; host_created_phase_id: string; host_demolished_phase_id: string;
  kind: string; room_number: string; room_name: string; mark: string; type_name: string;
}
export interface SheetName {
  id: string; number: string; name: string; set: string;
  revision_ids: string[]; titleblock_params: Record<string, string | null>;
  has_revision_schedule: boolean;
}
export interface ExtentName {
  element_id: string; view_id: string; sheet_id: string;
  min_u_mm: number; min_v_mm: number; max_u_mm: number; max_v_mm: number;
}
export interface PhaseSnapshot {
  phases: PhaseName[];
  filters: FilterName[];
  revisions: RevisionName[];
  views: ViewName[];
  elements: ElementName[];
  sheets: SheetName[];
  sheet_sets: { name: string; sheet_ids: string[] }[];
  extents: ExtentName[];
  partial?: boolean;
  element_total?: number;
  is_central?: boolean;
  resolved_document?: { title: string; path: string };
}

export interface IdPack { count: number; ids: string[]; truncated: boolean }

export function packIds(ids: string[], cap = ID_CAP): IdPack {
  const unique = [...new Set(ids.map((id) => String(id)).filter(Boolean))];
  return { count: unique.length, ids: unique.slice(0, cap), truncated: unique.length > cap };
}

function text(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function lower(value: unknown): string {
  return text(value).toLowerCase();
}

export function normalizeSnapshot(raw: unknown): PhaseSnapshot {
  const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const list = (key: string) => Array.isArray(row[key]) ? row[key] as unknown[] : [];
  const phases = list("phases").map((item) => {
    const r = item as Record<string, unknown>;
    return { id: text(r.id), name: text(r.name), sequence: Number(r.sequence) || 0 };
  }).filter((item) => item.id || item.name);
  const filters = list("filters").map((item) => {
    const r = item as Record<string, unknown>;
    return { id: text(r.id), name: text(r.name) };
  });
  const revisions = list("revisions").map((item) => {
    const r = item as Record<string, unknown>;
    return {
      id: text(r.id), sequence: Number(r.sequence) || 0, description: text(r.description),
      issued: r.issued === true, date: text(r.date), issued_by: text(r.issued_by), issued_to: text(r.issued_to),
    };
  });
  const views = list("views").map((item) => {
    const r = item as Record<string, unknown>;
    return {
      id: text(r.id), name: text(r.name), view_type: text(r.view_type),
      phase_id: text(r.phase_id), phase_name: text(r.phase_name),
      filter_id: text(r.filter_id), filter_name: text(r.filter_name),
      sheet_id: text(r.sheet_id), sheet_number: text(r.sheet_number),
      is_template: r.is_template === true,
    };
  });
  const elements = list("elements").map((item) => {
    const r = item as Record<string, unknown>;
    return {
      id: text(r.id), category: text(r.category) || "Model",
      created_phase_id: text(r.created_phase_id), demolished_phase_id: text(r.demolished_phase_id),
      host_id: text(r.host_id), host_created_phase_id: text(r.host_created_phase_id),
      host_demolished_phase_id: text(r.host_demolished_phase_id),
      kind: text(r.kind) || "model", room_number: text(r.room_number), room_name: text(r.room_name),
      mark: text(r.mark), type_name: text(r.type_name),
    };
  }).filter((item) => item.id);
  const sheets = list("sheets").map((item) => {
    const r = item as Record<string, unknown>;
    const params = r.titleblock_params && typeof r.titleblock_params === "object" ? r.titleblock_params as Record<string, unknown> : {};
    const titleblock_params: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(params)) titleblock_params[key] = value == null ? null : String(value);
    return {
      id: text(r.id), number: text(r.number), name: text(r.name), set: text(r.set),
      revision_ids: Array.isArray(r.revision_ids) ? r.revision_ids.map((id) => text(id)).filter(Boolean) : [],
      titleblock_params, has_revision_schedule: r.has_revision_schedule === true,
    };
  });
  const sheet_sets = list("sheet_sets").map((item) => {
    const r = item as Record<string, unknown>;
    return {
      name: text(r.name),
      sheet_ids: Array.isArray(r.sheet_ids) ? r.sheet_ids.map((id) => text(id)).filter(Boolean) : [],
    };
  }).filter((item) => item.name);
  const extents = list("extents").map((item) => {
    const r = item as Record<string, unknown>;
    return {
      element_id: text(r.element_id), view_id: text(r.view_id), sheet_id: text(r.sheet_id),
      min_u_mm: Number(r.min_u_mm) || 0, min_v_mm: Number(r.min_v_mm) || 0,
      max_u_mm: Number(r.max_u_mm) || 0, max_v_mm: Number(r.max_v_mm) || 0,
    };
  });
  const doc = row.resolved_document && typeof row.resolved_document === "object" ? row.resolved_document as Record<string, unknown> : null;
  return {
    phases, filters, revisions, views, elements, sheets, sheet_sets, extents,
    partial: row.partial === true, element_total: typeof row.element_total === "number" ? row.element_total : elements.length,
    is_central: row.is_central === true,
    ...(doc ? { resolved_document: { title: text(doc.title), path: text(doc.path) } } : {}),
  };
}

export function findPhase(snapshot: PhaseSnapshot, key: string): PhaseName | undefined {
  const want = lower(key);
  if (!want) return undefined;
  return snapshot.phases.find((phase) => lower(phase.id) === want || lower(phase.name) === want);
}

function firstPhase(snapshot: PhaseSnapshot): PhaseName | undefined {
  return [...snapshot.phases].sort((a, b) => a.sequence - b.sequence)[0];
}

function sequenceOf(snapshot: PhaseSnapshot, id: string): number {
  if (!id) return 0;
  return snapshot.phases.find((phase) => phase.id === id)?.sequence ?? 0;
}

function presentIn(snapshot: PhaseSnapshot, element: ElementName, phase: PhaseName): boolean {
  const demo = sequenceOf(snapshot, element.demolished_phase_id);
  if (demo && demo <= phase.sequence) return false;
  // A room or space belongs to the phase it was created in. A wall carries forward until it is demolished.
  if (element.kind === "room" || element.kind === "space") return element.created_phase_id === phase.id;
  const created = sequenceOf(snapshot, element.created_phase_id);
  if (!created || created > phase.sequence) return false;
  return true;
}

const SKIP_VIEWS = new Set(["drawingsheet", "schedule", "legend", "projectbrowser", "systembrowser", "internal", "draftingview", "panelschedule", "columnschedule"]);

export function auditableViews(snapshot: PhaseSnapshot): ViewName[] {
  return snapshot.views.filter((view) => !view.is_template && !SKIP_VIEWS.has(lower(view.view_type).replace(/\s+/g, "")));
}

export interface Finding {
  code: string;
  count: number;
  ids: string[];
  truncated: boolean;
  verdict: PhaseVerdict;
  key: string;
  standard: CitedValue;
}

function worseCited(a: CitedValue, b: CitedValue): CitedValue {
  const rank: Record<string, number> = { unknown: 0, provisional: 1, standards: 2 };
  return (rank[a.source] ?? 0) <= (rank[b.source] ?? 0) ? a : b;
}

function finding(code: string, ids: string[], cited: CitedValue, cap: number): Finding {
  const packed = packIds(ids, cap);
  return {
    code, count: packed.count, ids: packed.ids, truncated: packed.truncated,
    verdict: verdictFor(packed.count === 0, cited), key: cited.key, standard: cited,
  };
}

export function auditPhase(snapshot: PhaseSnapshot, bank?: Record<string, PhaseBankEntry>, cap = ID_CAP): { findings: Finding[]; standards: CitedValue[] } {
  const existing = citePhase("phase.existing_name", bank);
  const demoAllowed = citePhase("phase.demo_in_first_allowed", bank);
  const hostMatch = citePhase("phase.host_match", bank);
  const roomMatch = citePhase("phase.room_match", bank);
  const suspicious = citePhase("phase.suspicious_filters", bank);
  const visible = citePhase("phase.visible_filters", bank);
  const existingName = lower(asString(existing) ?? "");
  const allowFirst = asBoolean(demoAllowed) === true;
  const hostsMustMatch = lower(asString(hostMatch) ?? "same") === "same";
  const matchBy = lower(asString(roomMatch) ?? "number") === "name" ? "name" : "number";
  const badFilters = new Set((asStringList(suspicious) ?? []).map((name) => name.toLowerCase()));
  const first = firstPhase(snapshot);

  const before: string[] = [];
  const inExisting: string[] = [];
  const hosts: string[] = [];
  for (const element of snapshot.elements) {
    const created = sequenceOf(snapshot, element.created_phase_id);
    const demo = sequenceOf(snapshot, element.demolished_phase_id);
    if (created && demo && demo < created) before.push(element.id);
    if (element.demolished_phase_id) {
      const demoPhase = snapshot.phases.find((phase) => phase.id === element.demolished_phase_id);
      const namedExisting = !!existingName && lower(demoPhase?.name) === existingName;
      const inFirst = !!first && demoPhase?.id === first.id && !allowFirst;
      if (namedExisting || inFirst) inExisting.push(element.id);
    }
    if (hostsMustMatch && element.host_id) {
      const createdDiff = element.created_phase_id !== element.host_created_phase_id;
      const demoDiff = element.demolished_phase_id !== element.host_demolished_phase_id;
      if (createdDiff || demoDiff) hosts.push(element.id);
    }
  }

  const missing: string[] = [];
  const ordered = [...snapshot.phases].sort((a, b) => a.sequence - b.sequence);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const here = ordered[i];
    for (const kind of ["room", "space"]) {
      const earlier = snapshot.elements.filter((element) => element.kind === kind && presentIn(snapshot, element, prev));
      const nowKeys = new Set(snapshot.elements.filter((element) => element.kind === kind && presentIn(snapshot, element, here)).map((element) => roomKey(element, matchBy)).filter(Boolean));
      for (const element of earlier) {
        const key = roomKey(element, matchBy);
        if (!key || nowKeys.has(key)) continue;
        const demo = sequenceOf(snapshot, element.demolished_phase_id);
        if (demo && demo <= here.sequence) continue;
        missing.push(element.id);
      }
    }
  }

  const noFilter: string[] = [];
  const suspiciousIds: string[] = [];
  for (const view of auditableViews(snapshot)) {
    if (!view.filter_name) noFilter.push(view.id);
    else if (badFilters.has(lower(view.filter_name))) suspiciousIds.push(view.id);
  }

  const findings = [
    finding("PHASE-DEMO-BEFORE-CREATE", before, demoAllowed, cap),
    finding("PHASE-DEMO-IN-EXISTING", inExisting, worseCited(existing, demoAllowed), cap),
    finding("PHASE-HOST-MISMATCH", hosts, hostMatch, cap),
    finding("PHASE-ROOM-MISSING", missing, roomMatch, cap),
    finding("PHASE-VIEW-NO-FILTER", noFilter, visible, cap),
    finding("PHASE-VIEW-SUSPICIOUS-FILTER", suspiciousIds, suspicious, cap),
  ];
  return { findings, standards: [existing, demoAllowed, hostMatch, roomMatch, suspicious, visible] };
}

function roomKey(element: ElementName, matchBy: "number" | "name"): string {
  return lower(matchBy === "name" ? element.room_name : element.room_number);
}

export interface PhaseOp {
  op: string;
  ids: string[];
  phase_id?: string;
  filter_id?: string;
  code: string;
}

export interface BatchPlan {
  phase: PhaseName;
  mismatches: { code: string; ids: string[] }[];
  ops: PhaseOp[];
  capped: boolean;
  cap: number;
  standards: CitedValue[];
}

export function planBatchCheck(snapshot: PhaseSnapshot, input: { phase: string; ids?: string[]; demolish_ids?: string[]; view?: string }, bank?: Record<string, PhaseBankEntry>): { ok: true; plan: BatchPlan } | { ok: false; code: string; message: string } {
  const phase = findPhase(snapshot, input.phase);
  if (!phase) return { ok: false, code: "FMC-PHASE-UNKNOWN", message: `[FMC-PHASE-UNKNOWN] No phase named "${input.phase}". Refusing to use another phase.` };
  const visible = citePhase("phase.visible_filters", bank);
  const existing = citePhase("phase.existing_name", bank);
  const demoAllowed = citePhase("phase.demo_in_first_allowed", bank);
  const { cap, cited: capCited } = opCap(bank);
  const names = new Set((asStringList(visible) ?? []).map((name) => name.toLowerCase()));
  const filter = snapshot.filters.find((item) => names.has(lower(item.name)));
  const existingName = lower(asString(existing) ?? "");
  const first = firstPhase(snapshot);
  const allowFirst = asBoolean(demoAllowed) === true;
  const createdIds = (input.ids ?? []).map((id) => text(id)).filter(Boolean);
  const demolishIds = new Set((input.demolish_ids ?? []).map((id) => text(id)).filter(Boolean));
  const byId = new Map(snapshot.elements.map((element) => [element.id, element]));
  const mismatches: { code: string; ids: string[] }[] = [];
  const ops: PhaseOp[] = [];
  const createdFix: string[] = [];
  const clearDemo: string[] = [];
  const demoFix: string[] = [];
  const blocked: string[] = [];

  for (const id of createdIds) {
    if (demolishIds.has(id)) continue;
    const element = byId.get(id);
    if (element && element.created_phase_id === phase.id && !element.demolished_phase_id) continue;
    if (!element || element.created_phase_id !== phase.id) createdFix.push(id);
    if (element?.demolished_phase_id) clearDemo.push(id);
  }
  for (const id of demolishIds) {
    const element = byId.get(id);
    const createdSeq = element ? sequenceOf(snapshot, element.created_phase_id) : 0;
    const phaseIsExisting = (!!existingName && lower(phase.name) === existingName) || (!!first && phase.id === first.id && !allowFirst);
    if (phaseIsExisting || (createdSeq && createdSeq >= phase.sequence)) {
      blocked.push(id);
      continue;
    }
    if (!element || element.demolished_phase_id !== phase.id) demoFix.push(id);
  }
  if (createdFix.length) {
    mismatches.push({ code: "PHASE-CREATED-MISMATCH", ids: createdFix });
    for (const id of createdFix) ops.push({ op: "set_created", ids: [id], phase_id: phase.id, code: "PHASE-CREATED-MISMATCH" });
  }
  if (clearDemo.length) {
    mismatches.push({ code: "PHASE-DEMOLISHED-MISMATCH", ids: clearDemo });
    for (const id of clearDemo) ops.push({ op: "clear_demolished", ids: [id], code: "PHASE-DEMOLISHED-MISMATCH" });
  }
  if (demoFix.length) {
    mismatches.push({ code: "PHASE-DEMOLISHED-MISMATCH", ids: demoFix });
    for (const id of demoFix) ops.push({ op: "set_demolished", ids: [id], phase_id: phase.id, code: "PHASE-DEMOLISHED-MISMATCH" });
  }
  if (blocked.length) mismatches.push({ code: "PHASE-DEMO-IN-EXISTING", ids: blocked });

  const wanted = text(input.view);
  let views = auditableViews(snapshot).filter((view) => lower(view.phase_id) === lower(phase.id) || lower(view.phase_name) === lower(phase.name));
  if (wanted) {
    const hit = snapshot.views.find((view) => lower(view.id) === lower(wanted) || lower(view.name) === lower(wanted));
    if (!hit) return { ok: false, code: "FMC-PHASE-VIEW", message: `[FMC-PHASE-VIEW] No view "${wanted}" in this document.` };
    views = [hit];
  }
  const viewPhase: string[] = [];
  const viewFilter: string[] = [];
  for (const view of views) {
    const phaseBad = lower(view.phase_id) !== lower(phase.id) && lower(view.phase_name) !== lower(phase.name);
    const filterBad = names.size > 0 && !names.has(lower(view.filter_name));
    if (!phaseBad && !filterBad) continue;
    if (phaseBad) viewPhase.push(view.id);
    if (filterBad) viewFilter.push(view.id);
    ops.push({
      op: "set_view", ids: [view.id], phase_id: phase.id,
      ...(filter && filterBad ? { filter_id: filter.id } : {}),
      code: phaseBad ? "PHASE-VIEW-PHASE" : "PHASE-VIEW-FILTER",
    });
  }
  if (viewPhase.length) mismatches.push({ code: "PHASE-VIEW-PHASE", ids: viewPhase });
  if (viewFilter.length) mismatches.push({ code: "PHASE-VIEW-FILTER", ids: viewFilter });
  return {
    ok: true,
    plan: {
      phase, mismatches, ops, capped: ops.length > cap, cap,
      standards: [visible, existing, demoAllowed, capCited],
    },
  };
}

export interface CloudPlan {
  revision_id: string;
  clouds: { view_id: string; sheet_id: string; element_ids: string[]; min_u_mm: number; min_v_mm: number; max_u_mm: number; max_v_mm: number }[];
  skipped_views: string[];
  capped: boolean;
  cap: number;
  pad_mm: number;
  standard: CitedValue;
}

export function planClouds(snapshot: PhaseSnapshot, input: { revision_id: string; element_ids?: string[] }, bank?: Record<string, PhaseBankEntry>): CloudPlan {
  const padCited = citePhase("revision.cloud_pad_mm", bank);
  const pad = asNumber(padCited) ?? 300;
  const { cap } = opCap(bank, "revision.max_clouds");
  const wanted = new Set((input.element_ids ?? []).map((id) => text(id)).filter(Boolean));
  const extents = snapshot.extents.filter((row) => !wanted.size || wanted.has(row.element_id));
  const groups = new Map<string, ExtentName[]>();
  const skipped = new Set<string>();
  for (const row of extents) {
    const view = snapshot.views.find((item) => item.id === row.view_id);
    const onSheet = lower(view?.view_type) === "drawingsheet" || !!row.sheet_id || !!view?.sheet_id;
    if (!onSheet) { skipped.add(row.view_id); continue; }
    const list = groups.get(row.view_id) ?? [];
    list.push(row);
    groups.set(row.view_id, list);
  }
  const clouds = [...groups.entries()].map(([viewId, rows]) => {
    const minU = Math.min(...rows.map((row) => row.min_u_mm)) - pad;
    const minV = Math.min(...rows.map((row) => row.min_v_mm)) - pad;
    const maxU = Math.max(...rows.map((row) => row.max_u_mm)) + pad;
    const maxV = Math.max(...rows.map((row) => row.max_v_mm)) + pad;
    return {
      view_id: viewId,
      sheet_id: rows.find((row) => row.sheet_id)?.sheet_id || snapshot.views.find((view) => view.id === viewId)?.sheet_id || "",
      element_ids: [...new Set(rows.map((row) => row.element_id))],
      min_u_mm: minU, min_v_mm: minV,
      max_u_mm: maxU === minU ? minU + pad : maxU,
      max_v_mm: maxV === minV ? minV + pad : maxV,
    };
  });
  return { revision_id: input.revision_id, clouds, skipped_views: [...skipped], capped: clouds.length > cap, cap, pad_mm: pad, standard: padCited };
}

export function findRevision(snapshot: PhaseSnapshot, key: string): RevisionName | undefined {
  const want = lower(key);
  if (!want) return undefined;
  return snapshot.revisions.find((revision) => lower(revision.id) === want || String(revision.sequence) === want || lower(revision.description) === want);
}

export interface CategoryBucket { added: IdPack; removed: IdPack; changed: IdPack }
export interface ComparePack {
  mode: "phase" | "revision";
  from: string;
  to: string;
  by_category: Record<string, CategoryBucket>;
  totals: { added: number; removed: number; changed: number };
  suitable_for: "handoff";
  partial: boolean;
}

function bucket(added: string[], removed: string[], changed: string[]): CategoryBucket {
  return { added: packIds(added), removed: packIds(removed), changed: packIds(changed) };
}

export function comparePhases(snapshot: PhaseSnapshot, fromKey: string, toKey: string): { ok: true; pack: ComparePack } | { ok: false; code: string; message: string } {
  const from = findPhase(snapshot, fromKey);
  const to = findPhase(snapshot, toKey);
  if (!from || !to) {
    const missing = !from ? fromKey : toKey;
    return { ok: false, code: "FMC-PHASE-UNKNOWN", message: `[FMC-PHASE-UNKNOWN] No phase named "${missing}".` };
  }
  const groups = new Map<string, { added: string[]; removed: string[]; changed: string[] }>();
  const take = (category: string) => {
    const row = groups.get(category) ?? { added: [], removed: [], changed: [] };
    groups.set(category, row);
    return row;
  };
  const removedByMark = new Map<string, { id: string; category: string }>();
  const addedByMark = new Map<string, { id: string; category: string }>();
  for (const element of snapshot.elements) {
    const was = presentIn(snapshot, element, from);
    const now = presentIn(snapshot, element, to);
    if (now && !was) {
      take(element.category).added.push(element.id);
      if (element.mark) addedByMark.set(`${element.category}\n${lower(element.mark)}`, { id: element.id, category: element.category });
    } else if (was && !now) {
      take(element.category).removed.push(element.id);
      if (element.mark) removedByMark.set(`${element.category}\n${lower(element.mark)}`, { id: element.id, category: element.category });
    }
  }
  for (const [key, removed] of removedByMark) {
    const added = addedByMark.get(key);
    if (!added || added.category !== removed.category) continue;
    const row = take(removed.category);
    row.removed = row.removed.filter((id) => id !== removed.id);
    row.added = row.added.filter((id) => id !== added.id);
    row.changed.push(removed.id, added.id);
  }
  return { ok: true, pack: finishCompare("phase", from.name, to.name, groups, snapshot.partial === true) };
}

function finishCompare(mode: "phase" | "revision", from: string, to: string, groups: Map<string, { added: string[]; removed: string[]; changed: string[] }>, partial: boolean): ComparePack {
  const by_category: Record<string, CategoryBucket> = {};
  const totals = { added: 0, removed: 0, changed: 0 };
  for (const [category, row] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!row.added.length && !row.removed.length && !row.changed.length) continue;
    by_category[category] = bucket(row.added, row.removed, row.changed);
    totals.added += row.added.length;
    totals.removed += row.removed.length;
    totals.changed += new Set(row.changed).size;
  }
  return { mode, from, to, by_category, totals, suitable_for: "handoff", partial };
}

export interface RevisionLedgerLine {
  at: string;
  tool: "fmc_phase";
  action: string;
  batch_id: string;
  revision_id: string;
  revision_sequence: number | null;
  revision_description: string;
  document: { title: string; path: string };
  element_ids: string[];
  categories: Record<string, string>;
  clouds: { id: string; view_id: string; sheet_id: string }[];
  issued: boolean | null;
}

export function revisionLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(ledgerDir(env), "FMC_Revisions.jsonl");
}

export function readRevisionLedger(env: NodeJS.ProcessEnv = process.env): RevisionLedgerLine[] {
  let text = "";
  try { text = fs.readFileSync(revisionLedgerPath(env), "utf8"); } catch { return []; }
  const out: RevisionLedgerLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as RevisionLedgerLine); } catch { /* a broken line is skipped */ }
  }
  return out;
}

export function appendRevisionLedger(line: RevisionLedgerLine, env: NodeJS.ProcessEnv = process.env): string {
  const file = revisionLedgerPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(line) + "\n");
  return file;
}

function sameDoc(line: RevisionLedgerLine, title: string, file: string): boolean {
  if (!title && !file) return true;
  return lower(line.document?.title) === lower(title) || (!!file && lower(line.document?.path) === lower(file));
}

export function compareRevisions(lines: RevisionLedgerLine[], fromKey: string, toKey: string, document?: { title?: string; path?: string }): ComparePack {
  const title = text(document?.title);
  const file = text(document?.path);
  const pick = (key: string) => {
    const want = lower(key);
    const ids = new Map<string, string>();
    for (const line of lines) {
      if (!sameDoc(line, title, file)) continue;
      const hit = lower(line.revision_id) === want || String(line.revision_sequence ?? "") === want || lower(line.revision_description) === want;
      if (!hit) continue;
      for (const id of line.element_ids ?? []) ids.set(String(id), line.categories?.[id] || "Model");
    }
    return ids;
  };
  const from = pick(fromKey);
  const to = pick(toKey);
  const groups = new Map<string, { added: string[]; removed: string[]; changed: string[] }>();
  const take = (category: string) => {
    const row = groups.get(category) ?? { added: [], removed: [], changed: [] };
    groups.set(category, row);
    return row;
  };
  for (const [id, category] of to) {
    if (from.has(id)) take(category).changed.push(id);
    else take(category).added.push(id);
  }
  for (const [id, category] of from) if (!to.has(id)) take(category).removed.push(id);
  return finishCompare("revision", fromKey, toKey, groups, false);
}

export interface IssueCheck {
  sheet_id: string;
  number: string;
  missing_params: string[];
  blank_params: string[];
  has_revision_schedule: boolean;
  schedule_ok: boolean;
}

export function checkIssue(snapshot: PhaseSnapshot, sheetIds: string[], bank?: Record<string, PhaseBankEntry>): { checks: IssueCheck[]; ok: boolean; params: CitedValue; schedule: CitedValue; step: CitedValue } {
  const params = citePhase("revision.titleblock_params", bank);
  const schedule = citePhase("revision.schedule_required", bank);
  const step = citePhase("revision.sequence_step", bank);
  const names = asStringList(params) ?? [];
  const needSchedule = asBoolean(schedule) !== false;
  const wanted = new Set(sheetIds);
  const checks = snapshot.sheets.filter((sheet) => wanted.has(sheet.id)).map((sheet) => {
    const missing_params = names.filter((name) => !(name in sheet.titleblock_params));
    const blank_params = names.filter((name) => name in sheet.titleblock_params && !text(sheet.titleblock_params[name]));
    const schedule_ok = !needSchedule || sheet.has_revision_schedule;
    return { sheet_id: sheet.id, number: sheet.number, missing_params, blank_params, has_revision_schedule: sheet.has_revision_schedule, schedule_ok };
  });
  const ok = checks.length > 0 && checks.every((row) => !row.missing_params.length && !row.blank_params.length && row.schedule_ok);
  return { checks, ok, params, schedule, step };
}

export function sheetIdsForSet(snapshot: PhaseSnapshot, name: string): string[] {
  const want = lower(name);
  const named = snapshot.sheet_sets.find((set) => lower(set.name) === want);
  if (named) return named.sheet_ids;
  return snapshot.sheets.filter((sheet) => lower(sheet.set) === want).map((sheet) => sheet.id);
}

export function categoriesFor(snapshot: PhaseSnapshot, ids: string[]): Record<string, string> {
  const byId = new Map(snapshot.elements.map((element) => [element.id, element.category]));
  const out: Record<string, string> = {};
  for (const id of ids) out[id] = byId.get(id) || "Model";
  return out;
}
