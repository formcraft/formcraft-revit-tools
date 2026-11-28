/**
 * fmc_visibility, server side: validate what the caller asks, check the shape of Revit's answer, and put it in order
 * and in words. Nothing here touches a file, a network or Revit. The reasons come from the add-in (read only, no
 * transaction); this module only checks and formats them, and never says 'visible' when a reason hides the element.
 */

/** The order the reasons are reported in (the same list as FmcVisibility.Order in the add-in). */
export const CHECK_ORDER = [
  "element_hidden", "temporary_hide", "category", "subcategory", "filter", "view_template", "workset", "design_option",
  "phase", "crop_region", "view_range", "section_box", "far_clip", "detail_level", "link", "owner_view",
  "discipline", "underlay", "revit_verdict",
] as const;

export const STATUSES = ["hides", "likely", "unknown", "info"] as const;
export type ReasonStatus = (typeof STATUSES)[number];
export type Visible = "yes" | "no" | "unknown";
export const MAX_ELEMENTS = 50;

export interface Reason {
  order: number;
  check: string;
  status: ReasonStatus;
  reason: string;
  evidence: Record<string, unknown>;
  fix: string;
}

export interface ElementRow {
  id: string;
  found: boolean;
  name: string;
  category: string;
  in_link?: boolean;
  visible: Visible;
  reasons: Reason[];
  passed: string[];
  not_applicable: Array<{ check: string; why: string }>;
  unknown_checks: string[];
  suggested_fixes: string[];
  explanation: string;
  notes?: string[];
}

/** Element ids as positive integers in text; refuses anything else, de-duplicates, caps the count. */
export function normalizeIds(input: unknown): { ids: string[]; problem?: string } {
  const list = Array.isArray(input) ? input : input === undefined || input === null || input === "" ? [] : [input];
  const ids: string[] = [];
  for (const raw of list) {
    const text = String(raw).trim();
    if (!/^[0-9]+$/.test(text) || /^0+$/.test(text) || text.length > 18) return { ids: [], problem: `"${text}" is not an element id (a positive whole number).` };
    const clean = text.replace(/^0+/, "");
    if (!ids.includes(clean)) ids.push(clean);
  }
  if (ids.length === 0) return { ids, problem: "element_ids is required: one or more element ids." };
  if (ids.length > MAX_ELEMENTS) return { ids: [], problem: `At most ${MAX_ELEMENTS} element ids per call (${ids.length} given).` };
  return { ids };
}

export function normalizeOptionalId(input: unknown, name: string): { id: string; problem?: string } {
  if (input === undefined || input === null || String(input).trim() === "") return { id: "" };
  const text = String(input).trim();
  if (!/^[0-9]+$/.test(text) || /^0+$/.test(text) || text.length > 18) return { id: "", problem: `${name} "${text}" is not an element id (a positive whole number).` };
  return { id: text.replace(/^0+/, "") };
}

/** no when any reason hides; unknown when none hides but one is likely or unknown; else yes. */
export function deriveVisible(reasons: Array<{ status: string }>): Visible {
  const s = reasons.map((r) => r.status);
  if (s.includes("hides")) return "no";
  if (s.includes("unknown") || s.includes("likely")) return "unknown";
  return "yes";
}

const rank = (check: string) => {
  const i = (CHECK_ORDER as readonly string[]).indexOf(check);
  return i < 0 ? 999 : i;
};

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value === undefined || value === null ? fallback : String(value);
}

function normalizeReason(raw: unknown, notes: string[]): Reason {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  let status = text(r.status) as ReasonStatus;
  if (!(STATUSES as readonly string[]).includes(status)) {
    notes.push(`A reason for ${text(r.check, "?")} had the status "${text(r.status)}"; it is treated as unknown.`);
    status = "unknown";
  }
  return {
    order: 0,
    check: text(r.check, "unknown_check"),
    status,
    reason: text(r.reason, "(no text)"),
    evidence: r.evidence && typeof r.evidence === "object" && !Array.isArray(r.evidence) ? (r.evidence as Record<string, unknown>) : {},
    fix: text(r.fix),
  };
}

const STATUS_WORD: Record<ReasonStatus, string> = { hides: "HIDES", likely: "LIKELY", unknown: "UNKNOWN", info: "note" };

/** One plain-language paragraph per element, from the reasons only. */
export function explain(row: Omit<ElementRow, "explanation">, viewName: string): string {
  const label = `Element ${row.id}${row.name || row.category ? ` (${[row.category, row.name].filter(Boolean).join(": ")})` : ""}`;
  const head = !row.found
    ? `${label}: not found.`
    : row.visible === "yes"
      ? `${label} is visible in "${viewName}": no check found a reason to hide it.`
      : row.visible === "no"
        ? `${label} is NOT visible in "${viewName}".`
        : `${label}: visibility in "${viewName}" is UNKNOWN (nothing hides it for certain, but a check could not decide or is only likely).`;
  const lines = row.reasons.map((r) => `  ${r.order}. [${STATUS_WORD[r.status]}] ${r.check}: ${r.reason}${r.fix && r.status !== "info" ? ` Fix (not applied): ${r.fix}` : ""}`);
  return [head, ...lines].join("\n");
}

/** Check Revit's answer against what was asked; every asked id gets a row, none is dropped silently. */
export function normalizeReply(raw: unknown, askedIds: string[]): { ok: true; reply: Record<string, unknown> } | { ok: false; message: string } {
  if (!raw || typeof raw !== "object") return { ok: false, message: "Revit's reply was empty. That is an error, not 'visible'." };
  const body = raw as Record<string, unknown>;
  if (!Array.isArray(body.elements)) return { ok: false, message: "Revit's reply had no elements list. That is an error, not 'visible'." };
  const view = (body.view && typeof body.view === "object" ? body.view : {}) as Record<string, unknown>;
  const viewName = text(view.name, "the view");
  const byId = new Map<string, Record<string, unknown>>();
  for (const e of body.elements) if (e && typeof e === "object") byId.set(text((e as Record<string, unknown>).id), e as Record<string, unknown>);

  const rows: ElementRow[] = [];
  for (const id of askedIds) {
    const notes: string[] = [];
    const e = byId.get(id);
    if (!e) {
      const reasons: Reason[] = [{ order: 1, check: "element", status: "unknown", reason: "Revit returned no answer for this element id.", evidence: {}, fix: "Ask again for this id." }];
      const partial = { id, found: false, name: "", category: "", visible: "unknown" as Visible, reasons, passed: [], not_applicable: [], unknown_checks: ["element"], suggested_fixes: ["Ask again for this id."] };
      rows.push({ ...partial, explanation: explain(partial, viewName) });
      continue;
    }
    const reasons = (Array.isArray(e.reasons) ? e.reasons : []).map((r) => normalizeReason(r, notes));
    reasons.sort((a, b) => rank(a.check) - rank(b.check));
    reasons.forEach((r, i) => { r.order = i + 1; });
    const derived = deriveVisible(reasons);
    const claimed = text(e.visible);
    if (claimed !== derived) notes.push(`Revit said visible="${claimed}"; the reasons give "${derived}", which is what is reported.`);
    const passed = Array.isArray(e.passed) ? e.passed.map(String) : [];
    const na = (Array.isArray(e.not_applicable) ? e.not_applicable : []).map((x) => {
      const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
      return { check: text(o.check), why: text(o.why) };
    });
    const unknownChecks = [...new Set(reasons.filter((r) => r.status === "unknown").map((r) => r.check))];
    const fixes = [...new Set(reasons.filter((r) => r.status !== "info" && r.fix).map((r) => r.fix))];
    const partial = {
      id, found: e.found !== false, name: text(e.name), category: text(e.category),
      ...(e.in_link === true ? { in_link: true } : {}),
      visible: derived, reasons, passed, not_applicable: na, unknown_checks: unknownChecks, suggested_fixes: fixes,
      ...(notes.length ? { notes } : {}),
    };
    rows.push({ ...partial, explanation: explain(partial, viewName) });
  }
  const summary = { yes: 0, no: 0, unknown: 0 };
  for (const r of rows) summary[r.visible] += 1;
  return {
    ok: true,
    reply: {
      tool: "fmc_visibility", model_changed: false, fixes_applied: false,
      document: text(body.document), view, link_instance: body.link_instance ?? null,
      summary, elements: rows,
    },
  };
}
