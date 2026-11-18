/**
 * Every applied model change names the file it changed. Dry runs and refusals are left as they are.
 * modify_model already returns FmcTarget.DescribeState; that object is kept when it has a title and a path.
 */
export interface AppliedFile { title: string; path: string }

export function isAppliedResult(params: unknown, result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const p = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
  if (p.dry_run === true || p.transactionMode === "read_only") return false;
  const row = result as Record<string, unknown>;
  if (row.dry_run === true || row.applied === false || row.refused === true) return false;
  if (typeof row.rollback === "string" && row.rollback) return false;
  return true;
}

/** Adds document.title and document.path to an applied result. A result that already has both is unchanged. */
export function stampAppliedDocument<T>(result: T, doc: { title?: string; path?: string } | null | undefined, params: unknown): T {
  if (!isAppliedResult(params, result) || !doc) return result;
  const title = typeof doc.title === "string" ? doc.title : "";
  const path = typeof doc.path === "string" ? doc.path : "";
  if (!title && !path) return result;
  const row = result as Record<string, unknown>;
  const existing = row.document;
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    const prior = existing as Record<string, unknown>;
    const keptTitle = typeof prior.title === "string" && prior.title ? prior.title : title;
    const keptPath = typeof prior.path === "string" && prior.path ? prior.path : path;
    if (prior.title === keptTitle && prior.path === keptPath) return result;
    return { ...row, document: { ...prior, title: keptTitle, path: keptPath } } as T;
  }
  return { ...row, document: { title, path } satisfies AppliedFile } as T;
}
