/**
 * Which open document a call may use.
 * An explicit document is an exact title or an exact path. It is never replaced with the active document.
 * No match is FMC-DOC-NOT-FOUND. More than one match is FMC-DOC-AMBIGUOUS.
 * A write (and any other call that is not a session inventory) with several project documents and no
 * document is FMC-DOC-REQUIRED.
 */

export const DOC_NOT_FOUND = "FMC-DOC-NOT-FOUND";
export const DOC_AMBIGUOUS = "FMC-DOC-AMBIGUOUS";
export const DOC_REQUIRED = "FMC-DOC-REQUIRED";

export interface OpenDocRef {
  title: string;
  path: string;
  family?: boolean;
}

export interface ResolvedDocument {
  title: string;
  path: string;
}

export type DocResolveOk = { ok: true; document: ResolvedDocument | null; pin: boolean };
export type DocResolveFail = { ok: false; code: typeof DOC_NOT_FOUND | typeof DOC_AMBIGUOUS | typeof DOC_REQUIRED; message: string };
export type DocResolveResult = DocResolveOk | DocResolveFail;

export function normDocKey(value: string): string {
  return value.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

export function sameDocKey(a: string, b: string): boolean {
  const left = normDocKey(a);
  const right = normDocKey(b);
  return left.length > 0 && left === right;
}

/** Exact title or exact path. A file name alone is neither, unless that is the title. */
export function matchesOpenDoc(doc: OpenDocRef, key: string): boolean {
  const named = key.trim();
  if (!named) return false;
  if (doc.title && sameDocKey(doc.title, named)) return true;
  if (doc.path && sameDocKey(doc.path, named)) return true;
  return false;
}

export function looksLikeRevitPath(key: string): boolean {
  return /[\\/]/.test(key) && /\.(rvt|rfa|rte|rft)$/i.test(key.trim());
}

function fileTitle(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.(rvt|rfa|rte|rft)$/i, "");
}

export function asOpenDocs(open: Array<string | OpenDocRef> | undefined): OpenDocRef[] {
  const out: OpenDocRef[] = [];
  for (const item of open ?? []) {
    if (typeof item === "string") {
      const text = item.trim();
      if (!text) continue;
      out.push(looksLikeRevitPath(text) ? { title: fileTitle(text), path: text, family: /\.rfa$/i.test(text) } : { title: text, path: "", family: false });
      continue;
    }
    if (!item) continue;
    const title = typeof item.title === "string" ? item.title : "";
    const path = typeof item.path === "string" ? item.path : "";
    if (!title.trim() && !path.trim()) continue;
    out.push({ title, path, family: item.family === true });
  }
  return out;
}

function label(doc: OpenDocRef): string {
  return doc.path || doc.title;
}

function listed(docs: OpenDocRef[]): string {
  return docs.map((doc) => doc.title || doc.path).join("; ");
}

/**
 * A send_code or keynote reply may carry the document as a title string or as {title, path}.
 * Either form becomes resolved_document. A path string keeps the path and takes its file name as the title.
 */
export function resolvedDocumentFrom(value: unknown): ResolvedDocument | null {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    if (looksLikeRevitPath(text) || /[\\/]/.test(text)) return { title: fileTitle(text), path: text };
    return { title: text, path: "" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const nested = row.resolved_document ?? row.document;
  if (nested != null && nested !== value) {
    const inner = resolvedDocumentFrom(nested);
    if (inner) return inner;
  }
  const title = typeof row.title === "string" ? row.title : "";
  const path = typeof row.path === "string" ? row.path : "";
  if (!title.trim() && !path.trim()) return null;
  return { title, path };
}

export function attachResolvedDocument<T>(value: T, doc: ResolvedDocument | null | undefined): T {
  if (!doc || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  if (resolvedDocumentFrom(row.resolved_document)) return value;
  return { ...row, resolved_document: { title: doc.title, path: doc.path } } as T;
}

/** Fields a shaped send_code reply keeps: the object form, plus resolved_document. */
export function shapedDocumentFields(value: unknown): { document?: ResolvedDocument; resolved_document?: ResolvedDocument } {
  const resolved = resolvedDocumentFrom(value);
  if (!resolved) return {};
  return { document: resolved, resolved_document: resolved };
}

export interface ResolveOpenInput {
  named?: string;
  open: Array<string | OpenDocRef>;
  /** Session inventory and family-document creation may omit document. */
  allowOmit?: boolean;
  /** This command may name a file that is not open yet. That is not the active document. */
  allowClosedPath?: boolean;
  /** fmc_new_local and fmc_grids_from_link: a missing name is refused even when one model is open. */
  forceMessage?: string;
}

export function resolveOpenDocument(input: ResolveOpenInput): DocResolveResult {
  const named = (input.named ?? "").trim();
  const open = asOpenDocs(input.open);
  if (!named && input.forceMessage) {
    return { ok: false, code: DOC_REQUIRED, message: input.forceMessage };
  }
  if (named) {
    const hits = open.filter((doc) => matchesOpenDoc(doc, named));
    if (hits.length > 1) {
      return {
        ok: false,
        code: DOC_AMBIGUOUS,
        message: `[${DOC_AMBIGUOUS}] "${named}" matches ${hits.length} open documents (${hits.map(label).join("; ")}). Pass the full path. Refusing to use the active document.`,
      };
    }
    if (hits.length === 1) {
      return { ok: true, document: { title: hits[0].title ?? "", path: hits[0].path ?? "" }, pin: true };
    }
    if (open.length === 0) return { ok: true, document: null, pin: false };
    if (input.allowClosedPath && looksLikeRevitPath(named)) {
      return { ok: true, document: { title: fileTitle(named), path: named }, pin: false };
    }
    return {
      ok: false,
      code: DOC_NOT_FOUND,
      message: `[${DOC_NOT_FOUND}] No open document has title or path "${named}". Open: ${listed(open) || "none"}. Refusing to use the active document.`,
    };
  }
  if (input.allowOmit) return { ok: true, document: null, pin: false };
  if (open.length === 0) return { ok: true, document: null, pin: false };
  const projects = open.filter((doc) => !doc.family);
  const choose = projects.length > 0 ? projects : open;
  if (choose.length > 1) {
    return {
      ok: false,
      code: DOC_REQUIRED,
      message: `[${DOC_REQUIRED}] ${choose.length} documents are open (${listed(choose)}). Pass document with a title or a full path. Refusing to use the active document.`,
    };
  }
  const only = choose[0];
  return { ok: true, document: { title: only.title ?? "", path: only.path ?? "" }, pin: true };
}

/**
 * The lease was taken on one document. A write resolved to another document does not borrow it.
 * Title, full path, or the same file name (the batch line's existing key) all count as the same document.
 */
/** True when any name in the lease is this document. */
export function leaseCoversAny(held: string | string[] | undefined, doc: ResolvedDocument, sameFile: (held: string, asked: string | undefined) => boolean): boolean {
  const list = Array.isArray(held) ? held : held ? [held] : [];
  return list.some((name) => leaseCovers(name, doc, sameFile));
}

export function leaseCovers(held: string, doc: ResolvedDocument, sameFile: (held: string, asked: string | undefined) => boolean): boolean {
  const key = held.trim();
  if (!key) return false;
  if (sameDocKey(key, doc.title) || sameDocKey(key, doc.path)) return true;
  return sameFile(key, doc.title) || sameFile(key, doc.path);
}

function fileTitleOf(value: string): string {
  const file = value.split(/[\\/]/).pop() ?? value;
  return file.replace(/\.(rvt|rfa|rte|rft)$/i, "");
}

/** True when one name is the other with a trailing `_USER` removed. */
export function isUserSuffixPair(a: string, b: string): boolean {
  const left = a.trim();
  const right = b.trim();
  if (!left || !right || sameDocKey(left, right)) return false;
  const bare = (value: string) => fileTitleOf(value).replace(/_user$/i, "");
  return sameDocKey(bare(left), fileTitleOf(right)) || sameDocKey(bare(right), fileTitleOf(left));
}

/**
 * The document a call may name. When one of the two names is the other with `_USER` removed,
 * the name that still has `_USER` wins. A stripped model number is not substituted for the local.
 */
export function preferUnstrippedDocument(target?: string, explicit?: string): string | undefined {
  const outer = (target ?? "").trim();
  const named = (explicit ?? "").trim();
  if (outer && named && isUserSuffixPair(outer, named)) {
    if (/_user$/i.test(fileTitleOf(outer))) return outer;
    if (/_user$/i.test(fileTitleOf(named))) return named;
  }
  return outer || named || undefined;
}

/**
 * The document release and sync may send to Revit.
 * The lease title is kept. It is never rewritten by dropping `_USER`.
 * When the lease title is not open and exactly one open document is that title plus `_USER`,
 * that open local is used. A release call that omitted the document, or passed the model number
 * without `_USER`, does not choose the name.
 */
export function resolveLeaseDocument(leaseTitle: string, open: Array<{ title?: string; path?: string }> = []): string {
  const stored = leaseTitle.trim();
  if (!stored) return stored;
  const docs = open
    .map((doc) => ({ title: (doc.title ?? "").trim(), path: (doc.path ?? "").trim() }))
    .filter((doc) => doc.title || doc.path);
  const exact = docs.find((doc) => sameDocKey(doc.title, stored) || sameDocKey(doc.path, stored) || sameDocKey(fileTitleOf(doc.path), stored) || sameDocKey(fileTitleOf(doc.title), stored));
  if (exact) return exact.title || stored;
  if (/_user$/i.test(fileTitleOf(stored))) return stored;
  const promoted = docs.filter((doc) => {
    const title = fileTitleOf(doc.title || doc.path);
    return /_user$/i.test(title) && sameDocKey(title.replace(/_user$/i, ""), fileTitleOf(stored));
  });
  if (promoted.length === 1) return promoted[0].title || stored;
  return stored;
}
