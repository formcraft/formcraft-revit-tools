/**
 * ai_element_filter cursor paging (tool research 1-25, approved 28 Nov), in the token shape FILTER_TOOL_SPEC 5.6 sets
 * for fmc_filter (build plan item 32), so the new tool can take the same cursors:
 *   "c1." + base64url JSON { rs, d, l, a, v, h }
 *   rs result set (none here: ""), d document index (0), l link instance (0), a the last element id returned,
 *   v the document version when the first page was read, h a hash of the query.
 * Pages are in element-id order, so "after id a" is well defined. A cursor for another query is refused; a model whose
 * version moved since the first page is FMC-FILTER-STALE unless on_change is "continue".
 */
import { createHash } from "node:crypto";

export interface FilterCursor { rs: string; d: number; l: number; a: number; v: string; h: string }

const PAGING_KEYS = new Set(["skip", "maxElements", "afterId", "cursor", "on_change"]);

/** A stable hash of the filter (paging keys left out, keys sorted). */
export function queryHash(data: Record<string, unknown>): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
        .filter((key) => !PAGING_KEYS.has(key) && (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, sorted((value as Record<string, unknown>)[key])]));
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(sorted(data))).digest("hex").slice(0, 16);
}

export function encodeCursor(c: FilterCursor): string {
  return "c1." + Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(token: string): FilterCursor | null {
  const text = String(token ?? "").trim();
  if (!text.startsWith("c1.")) return null;
  try {
    const c = JSON.parse(Buffer.from(text.slice(3), "base64url").toString("utf8")) as FilterCursor;
    if (typeof c.a !== "number" || !Number.isFinite(c.a) || typeof c.h !== "string") return null;
    return { rs: String(c.rs ?? ""), d: Number(c.d ?? 0), l: Number(c.l ?? 0), a: c.a, v: String(c.v ?? ""), h: c.h };
  } catch {
    return null;
  }
}

export type CursorCheck = { ok: true; afterId: number; cursor: FilterCursor | null } | { ok: false; code: string; message: string };

/** What to send for this call: the after-id from a valid cursor for this same query, or none for a first page. */
export function cursorStart(data: Record<string, unknown>, token: string | undefined): CursorCheck {
  if (!token || !token.trim()) return { ok: true, afterId: -1, cursor: null };
  const c = decodeCursor(token);
  if (!c) return { ok: false, code: "FMC-FILTER-CURSOR", message: "[FMC-FILTER-CURSOR] The cursor is not one this tool gave. Pass it back unchanged, or start again without cursor." };
  if (c.h !== queryHash(data)) return { ok: false, code: "FMC-FILTER-CURSOR", message: "[FMC-FILTER-CURSOR] The cursor belongs to another filter. Use the same filter as the first page, or start again without cursor." };
  return { ok: true, afterId: c.a, cursor: c };
}

export interface AddinPaging { total?: number; from?: number; to?: number; remaining?: number; last_id?: number; document_version?: string; ids?: number[] }

/** The paging block of the answer, with the next cursor (null on the last page) and a stale check against the cursor. */
export function pagingReply(data: Record<string, unknown>, prior: FilterCursor | null, paging: AddinPaging | undefined, onChange: "fail" | "continue"):
  { ok: true; page: Record<string, unknown> } | { ok: false; code: string; message: string; page: Record<string, unknown> } {
  const version = String(paging?.document_version ?? "");
  const firstVersion = prior ? prior.v : version;
  const changed = !!prior && !!prior.v && !!version && prior.v !== version;
  const remaining = Number(paging?.remaining ?? 0);
  const last = Number(paging?.last_id ?? -1);
  const next = remaining > 0 && last >= 0 ? encodeCursor({ rs: "", d: 0, l: 0, a: last, v: firstVersion, h: queryHash(data) }) : null;
  const page = {
    total: paging?.total ?? null, from: paging?.from ?? null, to: paging?.to ?? null, remaining, order: "element_id",
    cursor: next, document_version: version || null, ...(changed ? { model_changed: true } : {}),
  };
  if (changed && onChange === "fail") {
    return { ok: false, code: "FMC-FILTER-STALE", page,
      message: "[FMC-FILTER-STALE] The model changed since the first page (its document version moved). Start again without cursor, or pass on_change \"continue\" to carry on after the last id." };
  }
  return { ok: true, page };
}
