/**
 * fmc_reload_link is a write. The add-in reloads one Revit link type with no transaction phase.
 * This check runs first: the document must be named, the id must be an element id, and a family is refused.
 * The live-model lock, the batch lease and RefuseOriginal (a verification copy, a link, a protected original)
 * still apply when the command is sent.
 */
export interface LinkHost { title?: string; path?: string; isFamily?: boolean }

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
