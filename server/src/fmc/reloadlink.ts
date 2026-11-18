/**
 * fmc_reload_link is a write. The add-in reloads one Revit link type with no transaction phase.
 * This check runs first: the document must be named, the id must be an element id, and a family is refused.
 * The live-model lock, the batch lease and RefuseOriginal (a verification copy, a link, a protected original)
 * still apply when the command is sent.
 *
 * The add-in (ed5e130) returns LoadResult and then GetLinkedFileStatus without comparing them. LoadResult
 * LinkLoaded with status Unloaded is not a loaded link. The server is what says so.
 */
import { samePath } from "./opencopy.js";

export interface LinkHost { title?: string; path?: string; isFamily?: boolean }

/** An open document already listed by fmc_document_info or the instance file. central comes from fmc_workshare_facts. */
export interface SessionDoc {
  title?: string;
  path?: string;
  isLinked?: boolean;
  isFamily?: boolean;
  family?: boolean;
  isWorkshared?: boolean;
  central?: string;
}

export interface ReloadLinkArgs {
  document?: string;
  link_type_id?: number | string;
  path?: string;
}

export type ReloadLinkPlan =
  | { ok: true; params: { document: string; link_type_id: number; path?: string } }
  | { ok: false; message: string; document: { title: string; path: string } };

function hostFile(host: LinkHost | null | undefined, named: string): { title: string; path: string } {
  return {
    title: typeof host?.title === "string" ? host.title : named,
    path: typeof host?.path === "string" ? host.path : "",
  };
}

function linkTypeId(value: number | string | undefined): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value !== 0) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    if (Number.isSafeInteger(n) && n !== 0) return n;
  }
  return null;
}

/** Names the document and the link type. A family, a missing document and a bad id are refused before Revit is asked to reload. */
export function planReloadLink(args: ReloadLinkArgs, host: LinkHost | null | undefined): ReloadLinkPlan {
  const named = (args.document ?? "").trim();
  const file = hostFile(host, named);
  if (!named) {
    return { ok: false, message: "document is required: a title or a full path of the open project. The active document is not used as a guess.", document: file };
  }
  const id = linkTypeId(args.link_type_id);
  if (id == null) {
    return { ok: false, message: "link_type_id must be the Revit link type's element id.", document: file };
  }
  const family = host?.isFamily === true || /\.rfa$/i.test(host?.path ?? "") || /\.rfa$/i.test(named);
  if (family) {
    return {
      ok: false,
      message: `A family document is refused${file.title ? ` (${file.title})` : ""}. fmc_reload_link reloads a Revit link in a project model.`,
      document: file,
    };
  }
  const path = (args.path ?? "").trim();
  return { ok: true, params: path ? { document: named, link_type_id: id, path } : { document: named, link_type_id: id } };
}

export interface ReloadVerdict {
  ok: boolean;
  code?: string;
  message?: string;
  hint?: string;
  /** Set after a LoadFrom. False when the path Revit reports is not the path that was requested. */
  path_matches?: boolean;
}

/**
 * LoadResult is not success. The link is loaded only when status is Loaded.
 * An open non-linked document with the same path, or the same central, is named: Revit will not
 * load a link to a model that is open in this session.
 */
export function judgeReload(result: Record<string, unknown>, requestedPath: string | undefined, open: SessionDoc[] = []): ReloadVerdict {
  const status = String(result.status ?? "");
  const loadResult = String(result.load_result ?? "");
  const reported = String(result.path ?? "");
  const asked = (requestedPath ?? "").trim();
  const lines: string[] = [];
  let ok = true;
  let code: string | undefined;
  if (status !== "Loaded") {
    ok = false;
    code = "FMC-LINK-NOT-LOADED";
    lines.push(`Revit reported LoadResult ${loadResult} but the link is still ${status}.`);
  }
  let pathMatches: boolean | undefined;
  if (asked) {
    pathMatches = reported.length > 0 && samePath(reported, asked);
    if (!pathMatches) lines.push(`The link path is still ${reported || "(none)"}, not ${asked}.`);
  }
  const hint = !ok && asked ? openModelHint(asked, open) : undefined;
  if (hint) lines.push(hint);
  const message = lines.join(" ");
  return {
    ok,
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
    ...(hint ? { hint } : {}),
    ...(pathMatches !== undefined ? { path_matches: pathMatches } : {}),
  };
}

/** Name an open project whose file or central is the path LoadFrom asked for. Linked documents are not the model itself. */
export function openModelHint(requested: string, open: SessionDoc[]): string | undefined {
  const hits = open.filter((doc) => {
    if (doc.isLinked || doc.isFamily || doc.family) return false;
    const file = (doc.path ?? "").trim();
    const central = (doc.central ?? "").trim();
    return (!!file && samePath(file, requested)) || (!!central && samePath(central, requested));
  });
  if (!hits.length) return undefined;
  const names = hits.map((doc) => (doc.title || doc.path || "an open document").trim()).filter(Boolean);
  return `Revit can't load a link to a model open in this session (${names.join(", ")}). Close it, or reload from a session where it isn't open.`;
}
