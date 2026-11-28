/**
 * One link plan for every open project and for closed .rvt files.
 *
 * Revit 2025 refuses a link whose file, or whose central identity, is already open in the session
 * (LinkLoadResultType.LinkOpenAsHost, SameModelAsHost, SameCentralModelAsHost). A filesystem copy
 * keeps that identity, so a byte copy of a workshared model is not a successful route. The published
 * copy of a workshared source is a detached Save As (worksets discarded, not a new central). The
 * open document is not saved, synced, closed or activated. If the load result is still one of those
 * three, the reply stays FMC-LINK-OPEN-AS-HOST and names the blocking document.
 *
 * Pinned and workset are not in TransmissionData. A closed-file audit leaves them null.
 * The unit tests do not run Revit. The add-in reports the load result; that is the experiment.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { DOC_AMBIGUOUS, DOC_NOT_FOUND, DOC_REQUIRED, matchesOpenDoc, resolveOpenDocument, type OpenDocRef } from "./docresolve.js";
import { LinkFact, auditLinks, candidates, inShared, linkProblems, roleOf, type LinkAudit } from "./links.js";
import { classifyLinkLine, judgeReload, openModelHint, planReloadLink, type SessionDoc } from "./reloadlink.js";
import { checkWritePath, type GuardConfig } from "./policy.js";
import { protectedRoots, samePath, underAny } from "./opencopy.js";
import { saveBlocked } from "./savepolicy.js";

const win = path.win32;

export const LINK_OPEN_AS_HOST = "FMC-LINK-OPEN-AS-HOST";
export const LINK_PROTECTED = "FMC-LINK-PROTECTED";
export const LINK_CENTRAL = "FMC-LINK-CENTRAL";
export const LINK_OPEN_FILE = "FMC-LINK-OPEN-FILE";
export const LINK_SAME_FILE = "FMC-LINK-SAME-FILE";
export const LINK_ACTIVE_CHANGED = "FMC-LINK-ACTIVE-CHANGED";
export const LINK_NOT_LOADED = "FMC-LINK-NOT-LOADED";

export const IDENTITY_LIMIT =
  "Revit 2025.4 LinkLoadResultType, from RevitAPI.xml: LinkOpenAsHost means the linked model is already opened directly in Revit. SameModelAsHost means the linked model has the same path as the active document. SameCentralModelAsHost means the link and a host are locals of the same central, or one is a local and the other is its central. A filesystem copy keeps that central relationship, so this tool does not link the byte copy of a workshared file. The add-in opens only the copy, uses DetachAndDiscardWorksets and SaveAs a new non-workshared file (not a central). A non-workshared source is a file copy; Save As runs only if Revit still reports the same model. If the load result is still one of those three, the call is FMC-LINK-OPEN-AS-HOST and names the open document. This was not executed inside a Revit session. The open model is not saved, synced, closed or activated. If the active document or view changes, the add-in stops and does not restore it.";

export const CLOSED_LIMITS = [
  "TransmissionData stores the external path and path type. It does not store pinned or workset; those are null without opening the file.",
  "The Revit 2025 TransmissionData API does not return the saved load flag. load is null on a read. An offline edit can set it.",
];

export interface LinkSetItem { path: string; role?: string }
export interface LinkEdit { id?: number; from?: string; to?: string; load?: boolean }

export interface LinkManageArgs {
  action: "audit" | "link" | "pin" | "reload" | "repath" | "unload" | "apply" | "offline";
  document?: string;
  documents?: string[];
  file?: string;
  link_from?: string;
  models?: string[];
  link_set?: LinkSetItem[];
  pin?: boolean;
  dry_run?: boolean;
  on_blocked?: "fail" | "published_copy";
  link_type_id?: number | string;
  path?: string;
  copy_folder?: string;
  edits?: LinkEdit[];
  /** audit: return a ready link_set for apply that fixes the Fix rows (research 56). */
  suggest?: boolean;
}

export interface LinkIo {
  session(): Promise<{ documents: SessionDoc[] }>;
  facts(document: string): Promise<Record<string, unknown>>;
  centralOf(document: string): Promise<string>;
  transmissionRead(file: string): Promise<Record<string, unknown>>;
  transmissionWrite(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  publish(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  linkAdd(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  linkPin(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  reload(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  unload(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  copyFile(from: string, to: string): Promise<void>;
  setReadOnly?(file: string, on: boolean): Promise<void>;
  removeFile?(file: string): Promise<void>;
  exists(file: string): boolean;
  listModels?(folder: string): string[];
}

export interface PlanResult { body: Record<string, unknown>; isError: boolean }

export function centralFolder(file: string): boolean {
  return win.normalize(file).split("\\").some((seg) => /^(?:_|\d{2}_)?centrals?$/i.test(seg));
}

export function linkRole(file: string, explicit?: string): string {
  const given = (explicit ?? "").trim();
  if (given) return given.toUpperCase();
  const named = roleOf(file);
  if (named) return named;
  const base = win.basename(file).replace(/\.rvt$/i, "");
  const match = /^([A-Za-z]{1,2})[-_]/.exec(base);
  return match ? match[1].toUpperCase() : "";
}

export function worksetFor(role: string): string {
  return `Z_Links_${role || "<Role>"}`;
}

function hashOf(file: string): string {
  return createHash("sha1").update(win.normalize(file).toLowerCase()).digest("hex").slice(0, 8);
}

export function publishedFileName(source: string, role: string): string {
  const token = (role || "Z").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "Z";
  return `FMC_LinkCopy_${token}_${hashOf(source)}.rvt`;
}

export function stagingFileName(source: string): string {
  return `FMC_LinkStaging_${hashOf(source)}.rvt`;
}

export function sameSession(a: SessionDoc, b: SessionDoc): boolean {
  if (a.path && b.path && samePath(a.path, b.path)) return true;
  if (a.title && b.title && a.title.trim().toLowerCase() === b.title.trim().toLowerCase() && (!a.path || !b.path || samePath(a.path, b.path))) return true;
  return false;
}

export function isSelfLink(host: SessionDoc, modelPath: string): boolean {
  if (host.path && samePath(host.path, modelPath)) return true;
  if (host.central && samePath(host.central, modelPath)) return true;
  return false;
}

/** Another open project whose file or central is this path. The host itself is not a blocker. */
export function blockingHost(modelPath: string, open: SessionDoc[], self?: SessionDoc): SessionDoc | undefined {
  return open.find((doc) => {
    if (doc.isLinked || doc.isFamily || doc.family) return false;
    if (self && sameSession(doc, self)) return false;
    const pathHit = !!doc.path && samePath(doc.path, modelPath);
    const centralHit = !!doc.central && samePath(doc.central, modelPath);
    return pathHit || centralHit;
  });
}

export type PublishMethod = "detach-save" | "file-copy" | "save-as";

export function publishMethod(blocker: SessionDoc): PublishMethod {
  if (blocker.isWorkshared) return "detach-save";
  if (blocker.central && blocker.path && !samePath(blocker.central, blocker.path)) return "detach-save";
  return "file-copy";
}

function onBlockedMode(args: LinkManageArgs): "fail" | "published_copy" {
  if (args.on_blocked === "fail" || args.on_blocked === "published_copy") return args.on_blocked;
  if (args.action === "link" || args.action === "reload" || args.action === "repath" || args.action === "apply") return "published_copy";
  return "fail";
}

export function codeIn(message: string): string | undefined {
  const match = /\[(FMC-[A-Z0-9-]+)\]/.exec(message);
  return match?.[1];
}

/** Why this path must not be written. Null when the published copy or the offline file may be written. */
export function linkWriteRefusal(target: string, cfg: GuardConfig, open: SessionDoc[] = []): { code: string; message: string } | null {
  const file = target.trim();
  if (!file) return { code: LINK_PROTECTED, message: "A destination path is required." };
  if (!win.isAbsolute(file)) return { code: LINK_PROTECTED, message: `Path must be absolute: ${file}` };
  if (win.extname(file).toLowerCase() !== ".rvt") return { code: LINK_PROTECTED, message: `${file} is not a .rvt file.` };
  if (centralFolder(file)) return { code: LINK_CENTRAL, message: `${file} is under a centrals folder. Workshared centrals are never written.` };
  const blocked = saveBlocked({ path: file, title: win.basename(file) }, cfg);
  if (blocked) return { code: LINK_PROTECTED, message: `${file}: ${blocked}` };
  if (underAny(file, protectedRoots(cfg))) return { code: LINK_PROTECTED, message: `Protected original: ${file}.` };
  const segments = win.normalize(file).toLowerCase().split("\\");
  const gates = (cfg.blocked_segments ?? []).filter((seg) => segments.includes(seg.toLowerCase()));
  if (gates.length) return { code: LINK_PROTECTED, message: `Writing into ${gates.join(", ")} is refused.` };
  const where = checkWritePath(file, cfg, { checkName: false });
  if (!where.ok) return { code: LINK_PROTECTED, message: where.reasons.join(" ") };
  const hit = open.find((doc) => !doc.isLinked && !doc.isFamily && !doc.family && (
    (!!doc.path && samePath(doc.path, file)) || (!!doc.central && samePath(doc.central, file))
  ));
  if (hit?.path && samePath(hit.path, file)) return { code: LINK_SAME_FILE, message: `${file} is open as ${hit.title || hit.path}. A published link copy is never that file.` };
  if (hit?.central && samePath(hit.central, file)) return { code: LINK_CENTRAL, message: `${file} is the central of ${hit.title || hit.path}. Workshared centrals are never written.` };
  return null;
}

export function linkCopyDir(hostPath: string, sourcePath: string, cfg: GuardConfig, override?: string): { ok: true; dir: string } | { ok: false; code: string; message: string } {
  const probeName = "FMC_LinkCopy_Z_00000000.rvt";
  if (override?.trim()) {
    const dir = override.trim();
    const refused = linkWriteRefusal(win.join(dir, probeName), cfg, []);
    if (refused) return { ok: false, code: refused.code, message: refused.message };
    return { ok: true, dir };
  }
  for (const file of [hostPath, sourcePath]) {
    if (!file) continue;
    const segs = win.normalize(file).split("\\");
    const at = segs.findIndex((seg) => seg.toLowerCase() === "01_wip");
    if (at <= 0) continue;
    const dir = [...segs.slice(0, at + 1), "_LinkCopies"].join("\\");
    const refused = linkWriteRefusal(win.join(dir, probeName), cfg, []);
    if (!refused) return { ok: true, dir };
  }
  return {
    ok: false,
    code: LINK_PROTECTED,
    message: "No writable 01_WIP\\_LinkCopies folder for the published link copy. Pass copy_folder inside a write root, outside protected paths, save_exclude and centrals. Tools do not write 02_Shared or 03_Published.",
  };
}

function projectsOf(open: SessionDoc[]): SessionDoc[] {
  const projects = open.filter((doc) => !doc.isFamily && !doc.family && !doc.isLinked);
  return projects.length ? projects : open;
}

function asOpen(open: SessionDoc[]): OpenDocRef[] {
  return open.map((doc) => ({ title: doc.title ?? "", path: doc.path ?? "", family: doc.isFamily === true || doc.family === true }));
}

function findSession(open: SessionDoc[], title: string, file: string): SessionDoc | undefined {
  return open.find((doc) => matchesOpenDoc({ title: doc.title ?? "", path: doc.path ?? "", family: false }, title || file));
}

export function resolveHost(name: string, open: SessionDoc[], allowOmit = false):
  { ok: true; doc: SessionDoc | null } | { ok: false; code: string; message: string } {
  const result = resolveOpenDocument({ named: name.trim(), open: asOpen(projectsOf(open)), allowOmit });
  if (!result.ok) return { ok: false, code: result.code, message: result.message };
  if (!result.document) return { ok: true, doc: null };
  const doc = findSession(open, result.document.title, result.document.path) ?? {
    title: result.document.title,
    path: result.document.path,
  };
  if (doc.isFamily || doc.family) {
    return { ok: false, code: DOC_NOT_FOUND, message: `[${DOC_NOT_FOUND}] ${doc.title || name} is a family. Links live in a project model.` };
  }
  return { ok: true, doc };
}

function asLinks(raw: unknown): LinkFact[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const row = item as Record<string, unknown>;
    const typeId = typeof row.type_id === "number" ? row.type_id : Number(row.type_id);
    return {
      id: Number(row.id ?? 0),
      name: String(row.name ?? ""),
      path: String(row.path ?? ""),
      path_type: String(row.path_type ?? ""),
      attachment: String(row.attachment ?? ""),
      loaded: row.loaded === true,
      pinned: row.pinned === true,
      workset: String(row.workset ?? ""),
      ...(Number.isFinite(typeId) && typeId !== 0 ? { type_id: typeId } : {}),
      ...(typeof row.status === "string" ? { status: row.status } : {}),
    };
  });
}

function annotateBlocked(rows: LinkAudit[], links: LinkFact[], open: SessionDoc[], host: SessionDoc): LinkAudit[] {
  return rows.map((row, index) => {
    const link = links[index];
    if (!link?.path) return row;
    const blocker = blockingHost(link.path, open, host);
    if (!blocker) return row;
    const problems = [...row.problems, `open as host (${blocker.title || blocker.path})`];
    return { ...row, problems, state: "Fix" };
  });
}

function normPath(p: string): string {
  return p.trim().replace(/\//g, "\\").toLowerCase();
}

function stem(p: string): string {
  return win.basename(p.trim()).replace(/\.rvt$/i, "").toLowerCase();
}

/** Research 56: the open model that a link's file name points at, when the link is a different file (a copy elsewhere). */
export function notTheOpenModel(link: LinkFact, open: SessionDoc[], host?: SessionDoc): SessionDoc | undefined {
  if (!link.path) return undefined;
  const want = stem(link.path);
  const at = normPath(link.path);
  for (const doc of open) {
    if (doc.isLinked || doc.isFamily || doc.family) continue;
    if (host && sameSession(doc, host)) continue;
    const title = (doc.title ?? "").replace(/\.rvt$/i, "").toLowerCase();
    const names = new Set([title, doc.path ? stem(doc.path) : "", doc.central ? stem(doc.central) : "", doc.central ? title.replace(/_[^_]+$/, "") : ""].filter(Boolean));
    if (!names.has(want)) continue;
    if ((doc.path && normPath(doc.path) === at) || (doc.central && normPath(doc.central) === at)) continue;
    return doc;
  }
  return undefined;
}

export interface CoordRow { model: string; coordinates: Record<string, unknown> }

/**
 * Research 56: do these models agree on shared coordinates? The angle to true north and the CRS must match. Where each
 * internal origin sits in shared coordinates is reported, not judged: an origin offset (8.4 m in the live architectural
 * model) is normal when the survey points agree.
 */
export function coordinatesAgree(rows: CoordRow[]): { agree: boolean; line: string; angles: Array<{ model: string; angle_deg: number | null; crs: string }>; origins: Array<{ model: string; easting_mm: number | null; northing_mm: number | null }>; next?: string } {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const angles = rows.map((r) => ({ model: r.model, angle_deg: num(r.coordinates.angle_deg), crs: String(r.coordinates.crs ?? "").trim() }));
  const origins = rows.map((r) => ({ model: r.model, easting_mm: num(r.coordinates.easting_mm), northing_mm: num(r.coordinates.northing_mm) }));
  const known = angles.filter((a) => a.angle_deg != null);
  const spread = known.length ? Math.max(...known.map((a) => a.angle_deg as number)) - Math.min(...known.map((a) => a.angle_deg as number)) : 0;
  const crs = new Set(angles.map((a) => a.crs).filter(Boolean));
  const agree = known.length === rows.length && spread <= 0.01 && crs.size <= 1;
  const far = origins.filter((o) => o.easting_mm != null && o.northing_mm != null).map((o) => Math.hypot(o.easting_mm as number, o.northing_mm as number));
  const offset = far.length ? Math.max(...far) : 0;
  const note = offset > 1 ? `; internal origins differ by up to ${(offset / 1000).toFixed(1)} m, which is normal and not flagged` : "";
  const line = agree
    ? `Coordinates agree across ${rows.length} models: angle ${known[0]?.angle_deg ?? 0} deg${crs.size ? ", CRS " + [...crs][0] : ""}${note}.`
    : known.length < rows.length
      ? `Coordinates not checked for ${rows.length - known.length} of ${rows.length} models (no angle in the read).`
      : `Coordinates do not agree: angles spread ${spread.toFixed(2)} deg${crs.size > 1 ? ", CRS " + [...crs].join(" / ") : ""}.`;
  return { agree, line, angles, origins, ...(agree ? {} : { next: "fmc_coord: publish a record from the survey model and align to it. fmc_links never moves coordinates." }) };
}

/** Research 56: the link_set that apply needs to fix the audit's Fix rows: the 02_Shared copy of the same model when one is listed. */
export function suggestLinkSet(host: SessionDoc, links: LinkFact[], audit: LinkAudit[], shared: string[]): { action: "apply"; documents: string[]; link_set: LinkSetItem[]; notes: string[]; dry_run: true } {
  const link_set: LinkSetItem[] = [];
  const notes: string[] = [];
  audit.forEach((row, index) => {
    const link = links[index];
    if (row.state !== "Fix" || !link) return;
    const want = stem(link.path || link.name);
    const copy = shared.find((f) => stem(f) === want || stem(f).replace(/_[^_]+$/, "") === want);
    const source = copy ?? link.path;
    if (!source) { notes.push(`${row.model}: no file path; link it again by hand`); return; }
    if (!copy && !inShared(source)) notes.push(`${row.model}: no copy of it in link_from (02_Shared); the set keeps the current file`);
    if (!link_set.some((item) => normPath(item.path) === normPath(source))) link_set.push({ path: source, role: linkRole(source) || undefined });
  });
  return { action: "apply", documents: [hostKey(host)], link_set, notes, dry_run: true };
}

function guardParams(cfg: GuardConfig): Record<string, unknown> {
  return {
    _protected_paths: cfg.protected_paths ?? [],
    _save_exclude: [...(cfg.save_exclude ?? []), ...(cfg.sync_exclude ?? [])],
    _protected_roots: protectedRoots(cfg),
  };
}

async function fillCentrals(open: SessionDoc[], io: LinkIo): Promise<SessionDoc[]> {
  const out: SessionDoc[] = [];
  for (const doc of open) {
    if (doc.isLinked || doc.isFamily || doc.family || doc.central || doc.isWorkshared === false) { out.push(doc); continue; }
    const key = (doc.path || doc.title || "").trim();
    if (!key) { out.push(doc); continue; }
    try { out.push({ ...doc, central: await io.centralOf(key) }); }
    catch { out.push(doc); }
  }
  return out;
}

function hostKey(doc: SessionDoc): string {
  return (doc.path || doc.title || "").trim();
}

function docStamp(doc: SessionDoc | null): { title: string; path: string } | null {
  if (!doc) return null;
  return { title: doc.title ?? "", path: doc.path ?? "" };
}

interface PlacePlan {
  source: string;
  role: string;
  workset: string;
  route: "skip" | "direct" | "published_copy" | "blocked";
  method?: PublishMethod;
  copyTo?: string;
  staging?: string;
  blocker?: SessionDoc;
  existing?: LinkFact;
  code?: string;
  message?: string;
  warnings: string[];
}

function findExisting(links: LinkFact[], source: string, copyTo?: string): LinkFact | undefined {
  const base = win.basename(source).toLowerCase();
  const copyBase = copyTo ? win.basename(copyTo).toLowerCase() : "";
  return links.find((link) => {
    if (link.path && samePath(link.path, source)) return true;
    if (copyTo && link.path && samePath(link.path, copyTo)) return true;
    const name = win.basename(link.path || link.name).toLowerCase();
    return name === base || (!!copyBase && name === copyBase);
  });
}

function planPlace(source: string, role: string, host: SessionDoc, links: LinkFact[], open: SessionDoc[], cfg: GuardConfig, mode: "fail" | "published_copy", copyFolder: string | undefined, exists: (file: string) => boolean, sharedOnly: boolean): PlacePlan {
  const workset = worksetFor(role);
  const warnings: string[] = [];
  if (!win.isAbsolute(source)) return { source, role, workset, route: "blocked", code: LINK_PROTECTED, message: `${source}: path must be absolute`, warnings };
  if (!exists(source)) return { source, role, workset, route: "blocked", code: LINK_NOT_LOADED, message: `${source}: not found`, warnings };
  if (isSelfLink(host, source)) return { source, role, workset, route: "skip", message: "A model is not linked into itself.", warnings };
  const blocker = blockingHost(source, open, host);
  if (!blocker && sharedOnly) {
    const problems = linkProblems(source, `${host.title ?? "model"}.rvt`);
    if (problems.length) return { source, role, workset, route: "blocked", code: LINK_PROTECTED, message: problems.join(" "), warnings };
  }
  if (blocker && mode === "fail") {
    return {
      source, role, workset, route: "blocked", blocker, code: LINK_OPEN_AS_HOST,
      message: openModelHint(source, open) ?? `Revit can't load a link to a model open in this session (${blocker.title || blocker.path}).`,
      warnings,
    };
  }
  if (blocker && mode === "published_copy") {
    const method = publishMethod(blocker);
    const dir = linkCopyDir(host.path ?? "", source, cfg, copyFolder);
    if (!dir.ok) return { source, role, workset, route: "blocked", blocker, code: dir.code, message: dir.message, warnings };
    const copyTo = win.join(dir.dir, publishedFileName(source, role));
    const staging = win.join(dir.dir, stagingFileName(source));
    const refused = linkWriteRefusal(copyTo, cfg, open) ?? linkWriteRefusal(staging, cfg, open);
    if (refused) return { source, role, workset, route: "blocked", blocker, code: refused.code, message: refused.message, warnings };
    if (!source.split(/[\\/]+/).some((seg) => seg.toLowerCase() === "02_shared")) warnings.push("not from 02_Shared (MAN 7.4); the published copy is in 01_WIP\\_LinkCopies because tools do not write 02_Shared");
    return { source, role, workset, route: "published_copy", method, copyTo, staging, blocker, existing: findExisting(links, source, copyTo), warnings };
  }
  if (!source.split(/[\\/]+/).some((seg) => seg.toLowerCase() === "02_shared") && !sharedOnly) warnings.push("not from 02_Shared (MAN 7.4)");
  return { source, role, workset, route: "direct", existing: findExisting(links, source), warnings };
}

function wouldLine(plan: PlacePlan, pin: boolean): Record<string, unknown> {
  const name = win.basename(plan.source);
  const pinText = pin ? " and pin" : "";
  let result = "would link by shared coordinates" + pinText;
  if (plan.route === "skip") result = plan.message ?? "skipped";
  else if (plan.route === "blocked") result = plan.message ?? "refused";
  else if (plan.route === "published_copy") result = `would publish a ${plan.method === "detach-save" ? "detached" : "file"} copy and link that by shared coordinates` + pinText;
  else if (plan.existing && plan.existing.path && plan.copyTo && samePath(plan.existing.path, plan.copyTo)) result = "already linked at the published copy";
  else if (plan.existing && plan.existing.loaded && plan.route === "direct") result = "already linked";
  return {
    name,
    path: plan.source,
    workset: plan.workset,
    pin,
    route: plan.route,
    result,
    ...(plan.method ? { method: plan.method } : {}),
    ...(plan.copyTo ? { copy_to: plan.copyTo } : {}),
    ...(plan.blocker ? { blocked_by: plan.blocker.title || plan.blocker.path } : {}),
    ...(plan.code ? { code: plan.code } : {}),
    ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
    ...(plan.route === "published_copy" ? { api_limit: IDENTITY_LIMIT } : {}),
  };
}

function judgePlace(raw: Record<string, unknown>, requested: string, open: SessionDoc[]): { ok: boolean; code?: string; message?: string; hint?: string; resultText: string } {
  const models = raw.models;
  if (Array.isArray(models) && models.length) {
    const row = models[0] as Record<string, unknown>;
    const text = String(row.result ?? "");
    const line = classifyLinkLine(text);
    return { ok: line.ok, code: line.code, message: line.ok ? undefined : text, hint: line.hint, resultText: text };
  }
  const verdict = judgeReload(raw, requested, open);
  const text = verdict.ok ? "linked" : (verdict.message ?? verdict.code ?? "not linked");
  return { ok: verdict.ok, code: verdict.code, message: verdict.message, hint: verdict.hint, resultText: text.startsWith("linked") || verdict.ok ? `linked by shared coordinates (${requested})` : `not linked: ${text}` };
}

async function pointAt(io: LinkIo, host: SessionDoc, existing: LinkFact | undefined, target: string, workset: string, pin: boolean, open: SessionDoc[]): Promise<{ ok: boolean; code?: string; message?: string; hint?: string; resultText: string; raw: Record<string, unknown> }> {
  const document = hostKey(host);
  if (!existing) {
    const raw = await io.linkAdd({ document, models: [{ path: target, workset }], pin }) ?? {};
    return { ...judgePlace(raw, target, open), raw };
  }
  const typeId = existing.type_id;
  if (!typeId) {
    return { ok: false, code: LINK_NOT_LOADED, message: `Link ${existing.name || existing.id} has no type id. The add-in that reports type_id is required to repath. Reload Revit after the add-in install.`, resultText: "not linked: no type id", raw: {} };
  }
  if (existing.path && samePath(existing.path, target) && existing.loaded) {
    if (pin && !existing.pinned) await io.linkPin({ document, element_ids: [existing.id] });
    return { ok: true, resultText: "linked by shared coordinates (already)", raw: {} };
  }
  const raw = await io.reload({ document, link_type_id: typeId, path: target }) ?? {};
  const judged = judgePlace(raw, target, open);
  if (judged.ok && pin && !existing.pinned) await io.linkPin({ document, element_ids: [existing.id] });
  return { ...judged, raw };
}

async function publishCopy(io: LinkIo, host: SessionDoc, plan: PlacePlan, cfg: GuardConfig): Promise<{ ok: true; path: string; raw: Record<string, unknown> } | { ok: false; code?: string; message: string }> {
  if (!plan.copyTo || !plan.staging || !plan.method) return { ok: false, code: LINK_PROTECTED, message: "The published copy has no destination." };
  await io.copyFile(plan.source, plan.staging);
  if (plan.method === "file-copy") {
    await io.copyFile(plan.staging, plan.copyTo);
    if (io.setReadOnly) await io.setReadOnly(plan.copyTo, true);
    return { ok: true, path: plan.copyTo, raw: { method: "file-copy", opened_source: false, opened_staging: false } };
  }
  let raw: Record<string, unknown>;
  try {
    raw = await io.publish({
      document: hostKey(host),
      source: plan.source,
      staging: plan.staging,
      dest: plan.copyTo,
      method: "detach-save",
      ...guardParams(cfg),
    }) ?? {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: codeIn(message) ?? LINK_NOT_LOADED, message };
  }
  if (io.removeFile) { try { await io.removeFile(plan.staging); } catch { /* the add-in may already have deleted it */ } }
  if (raw.active_unchanged === false || raw.code === LINK_ACTIVE_CHANGED) {
    return { ok: false, code: LINK_ACTIVE_CHANGED, message: String(raw.message ?? "The active document or view changed. It was not restored. The source was not saved.") };
  }
  if (raw.ok === false) return { ok: false, code: String(raw.code ?? LINK_NOT_LOADED), message: String(raw.message ?? "The published copy was not saved.") };
  return { ok: true, path: plan.copyTo, raw };
}

async function place(io: LinkIo, host: SessionDoc, plan: PlacePlan, links: LinkFact[], open: SessionDoc[], cfg: GuardConfig, pin: boolean, mode: "fail" | "published_copy"): Promise<Record<string, unknown>> {
  const name = win.basename(plan.source);
  if (plan.route === "skip") return { name, ok: true, skipped: true, result: plan.message, route: "skip" };
  if (plan.route === "blocked") return { name, ok: false, code: plan.code, message: plan.message, hint: plan.blocker ? openModelHint(plan.source, open) : undefined, blocked_by: plan.blocker?.title || plan.blocker?.path, route: "blocked", result: `not linked: ${plan.message}` };
  let target = plan.source;
  let method = plan.method;
  let published: Record<string, unknown> | undefined;
  if (plan.route === "published_copy") {
    const made = await publishCopy(io, host, plan, cfg);
    if (!made.ok) return { name, ok: false, code: made.code, message: made.message, route: "published_copy", blocked_by: plan.blocker?.title || plan.blocker?.path, result: `not linked: ${made.message}` };
    target = made.path;
    published = made.raw;
    method = plan.method;
  }
  const existing = findExisting(links, plan.source, target);
  let pointed = await pointAt(io, host, existing ?? plan.existing, target, plan.workset, pin, open);
  // A byte copy of a non-workshared file can still be SameModelAsHost. Save As the staging copy once.
  if (!pointed.ok && pointed.code === LINK_OPEN_AS_HOST && plan.method === "file-copy" && plan.staging && plan.copyTo && mode === "published_copy") {
    if (io.setReadOnly) await io.setReadOnly(plan.copyTo, false);
    try {
      const saved = await io.publish({ document: hostKey(host), source: plan.source, staging: plan.staging, dest: plan.copyTo, method: "save-as", ...guardParams(cfg) }) ?? {};
      if (saved.active_unchanged === false || saved.code === LINK_ACTIVE_CHANGED) {
        return { name, ok: false, code: LINK_ACTIVE_CHANGED, message: "The active document or view changed while saving the link copy. It was not restored.", published_copy: plan.copyTo, blocked_by: plan.blocker?.title || plan.blocker?.path, result: "not linked: active document changed" };
      }
      published = saved;
      method = "save-as";
      pointed = await pointAt(io, host, findExisting(links, plan.source, target), target, plan.workset, pin, open);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { name, ok: false, code: codeIn(message) ?? LINK_OPEN_AS_HOST, message, still_blocked: true, published_copy: plan.copyTo, blocked_by: plan.blocker?.title || plan.blocker?.path, result: `not linked: ${message}` };
    }
  }
  if (!pointed.ok && pointed.code === LINK_OPEN_AS_HOST && mode === "published_copy" && plan.route !== "published_copy") {
    const fallback = planPlace(plan.source, plan.role, host, links, open, cfg, "published_copy", undefined, () => true, false);
    const blocker = blockingHost(plan.source, open, host) ?? open.find((doc) => !doc.isLinked && !doc.isFamily);
    const forced: PlacePlan = fallback.route === "published_copy" ? fallback : {
      ...plan,
      route: "published_copy",
      method: blocker?.isWorkshared ? "detach-save" : "file-copy",
      blocker,
    };
    if (!forced.copyTo) {
      const dir = linkCopyDir(host.path ?? "", plan.source, cfg);
      if (!dir.ok) return { name, ok: false, code: dir.code, message: dir.message, route: "published_copy", result: `not linked: ${dir.message}` };
      forced.copyTo = win.join(dir.dir, publishedFileName(plan.source, plan.role));
      forced.staging = win.join(dir.dir, stagingFileName(plan.source));
      forced.method = forced.method ?? "file-copy";
    }
    const made = await publishCopy(io, host, forced, cfg);
    if (!made.ok) return { name, ok: false, code: made.code ?? LINK_OPEN_AS_HOST, message: made.message, route: "published_copy", result: `not linked: ${made.message}` };
    target = made.path;
    method = forced.method;
    published = made.raw;
    if (made.raw.method === "file-copy") {
      pointed = await pointAt(io, host, findExisting(links, plan.source, target), target, plan.workset, pin, open);
      if (!pointed.ok && pointed.code === LINK_OPEN_AS_HOST && forced.staging && forced.copyTo) {
        if (io.setReadOnly) await io.setReadOnly(forced.copyTo, false);
        try {
          published = await io.publish({ document: hostKey(host), source: plan.source, staging: forced.staging, dest: forced.copyTo, method: "save-as", ...guardParams(cfg) }) ?? {};
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { name, ok: false, code: codeIn(message) ?? LINK_OPEN_AS_HOST, message, still_blocked: true, published_copy: forced.copyTo, result: `not linked: ${message}` };
        }
        if (published.active_unchanged === false || published.code === LINK_ACTIVE_CHANGED) {
          return { name, ok: false, code: LINK_ACTIVE_CHANGED, message: "The active document or view changed while saving the link copy. It was not restored.", published_copy: forced.copyTo, result: "not linked: active document changed" };
        }
        method = "save-as";
        pointed = await pointAt(io, host, findExisting(links, plan.source, target), target, plan.workset, pin, open);
      }
    } else {
      pointed = await pointAt(io, host, findExisting(links, plan.source, target), target, plan.workset, pin, open);
    }
  }
  const still = !pointed.ok && pointed.code === LINK_OPEN_AS_HOST;
  const resultText = pointed.ok
    ? (pointed.resultText.startsWith("linked") ? pointed.resultText.replace("linked", "linked") : `linked by shared coordinates${pin ? ", pinned" : ""}${plan.route === "published_copy" || published ? " (published copy)" : ""}`)
    : pointed.resultText.startsWith("not linked") ? pointed.resultText : `not linked: ${pointed.message ?? pointed.code}`;
  return {
    name,
    ok: pointed.ok,
    result: pointed.ok && published ? `linked by shared coordinates${pin ? ", pinned" : ""} (published copy)` : resultText,
    route: published ? "published_copy" : plan.route,
    path: target,
    workset: plan.workset,
    ...(method ? { method } : {}),
    ...(published ? { published_copy: target, identity: published.method ?? method } : {}),
    ...(plan.blocker ? { blocked_by: plan.blocker.title || plan.blocker.path } : {}),
    ...(pointed.code && !pointed.ok ? { code: pointed.code } : {}),
    ...(pointed.message && !pointed.ok ? { message: pointed.message } : {}),
    ...(pointed.hint && !pointed.ok ? { hint: pointed.hint } : {}),
    ...(still ? { still_blocked: true, api_limit: IDENTITY_LIMIT } : {}),
    ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
  };
}

export function planOffline(file: string, edits: LinkEdit[], cfg: GuardConfig, open: SessionDoc[], exists: (p: string) => boolean): { ok: true } | { ok: false; code: string; message: string } {
  const target = file.trim();
  if (!target) return { ok: false, code: LINK_PROTECTED, message: "file is the closed .rvt whose link table is edited. The active document is not used." };
  if (!win.isAbsolute(target) || win.extname(target).toLowerCase() !== ".rvt") return { ok: false, code: LINK_PROTECTED, message: `${target || "file"} must be an absolute .rvt path.` };
  if (!exists(target)) return { ok: false, code: LINK_NOT_LOADED, message: `${target}: not found` };
  const openHit = open.find((doc) => !doc.isLinked && !doc.isFamily && !doc.family && doc.path && samePath(doc.path, target));
  if (openHit) return { ok: false, code: LINK_OPEN_FILE, message: `${target} is open as ${openHit.title || openHit.path}. Transmission data is not written to an open file, and the file is not closed.` };
  const centralHit = open.find((doc) => !doc.isLinked && !doc.isFamily && doc.central && samePath(doc.central, target));
  if (centralHit) return { ok: false, code: LINK_CENTRAL, message: `${target} is the central of ${centralHit.title || centralHit.path}. Workshared centrals are never written.` };
  const refused = linkWriteRefusal(target, cfg, []);
  if (refused) return { ok: false, code: refused.code, message: refused.message };
  if (!edits.length) return { ok: false, code: LINK_PROTECTED, message: "edits needs at least one row: id or from, and to and/or load." };
  for (const edit of edits) {
    if (edit.id == null && !(edit.from ?? "").trim()) return { ok: false, code: LINK_PROTECTED, message: "each edit needs id or from." };
    if (!(edit.to ?? "").trim() && edit.load == null) return { ok: false, code: LINK_PROTECTED, message: "each edit needs to or load." };
    if ((edit.to ?? "").trim() && samePath(edit.to!.trim(), target)) return { ok: false, code: LINK_SAME_FILE, message: "an offline repath cannot point a model at itself." };
  }
  return { ok: true };
}

function modelsOf(args: LinkManageArgs): LinkSetItem[] {
  if (args.link_set && args.link_set.length) return args.link_set.map((item) => ({ path: item.path.trim(), role: item.role }));
  return (args.models ?? []).map((item) => ({ path: item.trim(), role: undefined })).filter((item) => item.path);
}

export async function runLinkPlan(args: LinkManageArgs, io: LinkIo, cfg: GuardConfig): Promise<PlanResult> {
  const dry = args.dry_run !== false;
  const mode = onBlockedMode(args);
  const pin = args.pin !== false;
  let open: SessionDoc[] = [];
  try {
    open = await fillCentrals((await io.session()).documents ?? [], io);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { body: { ok: false, error: message, message }, isError: true };
  }
  const fail = (code: string, message: string, extra: Record<string, unknown> = {}): PlanResult =>
    ({ body: { ok: false, code, message, reasons: [message], ...extra }, isError: true });

  if (args.action === "offline") {
    const file = (args.file || args.path || "").trim();
    const planned = planOffline(file, args.edits ?? [], cfg, open, (p) => io.exists(p));
    if (!planned.ok) return fail(planned.code, planned.message);
    const would = (args.edits ?? []).map((edit) => ({ ...edit, file, load: edit.load ?? null }));
    if (dry) return { body: { ok: true, dry_run: true, action: "offline", file, would, opened: false, saved: false, synced: false, next: "Run again with dry_run=false" }, isError: false };
    try {
      const raw = await io.transmissionWrite({ file, edits: args.edits ?? [], ...guardParams(cfg) }) ?? {};
      const bad = raw.ok === false || typeof raw.code === "string";
      return { body: { ok: !bad, dry_run: false, action: "offline", file, opened: false, ...raw }, isError: bad };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(codeIn(message) ?? LINK_PROTECTED, message, { file });
    }
  }

  if (args.action === "audit" && (args.file ?? "").trim() && !(args.document ?? "").trim()) {
    const file = args.file!.trim();
    const openHit = open.find((doc) => !doc.isLinked && doc.path && samePath(doc.path, file));
    if (openHit) {
      args = { ...args, document: openHit.path || openHit.title, file: "" };
    } else {
      if (!io.exists(file)) return fail(LINK_NOT_LOADED, `${file}: not found`);
      try {
        const raw = await io.transmissionRead(file) ?? {};
        return { body: { ok: raw.ok !== false, source: "transmission", opened: false, file, model: win.basename(file), limits: CLOSED_LIMITS, ...raw }, isError: raw.ok === false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(codeIn(message) ?? LINK_NOT_LOADED, message, { file });
      }
    }
  }

  const names = args.action === "apply" ? (args.documents ?? []).map((item) => item.trim()).filter(Boolean) : [(args.document ?? "").trim()];
  if (args.action === "apply" && !names.length) return fail(DOC_REQUIRED, `[${DOC_REQUIRED}] apply needs documents: exact titles or full paths, one per host. Refusing to use the active document.`);

  const hosts: Array<{ ok: true; doc: SessionDoc } | { ok: false; code: string; message: string; name: string }> = [];
  if (args.action === "apply") {
    for (const name of names) {
      const resolved = resolveHost(name, open, false);
      if (!resolved.ok) hosts.push({ ok: false, code: resolved.code, message: resolved.message, name });
      else if (!resolved.doc) hosts.push({ ok: false, code: DOC_NOT_FOUND, message: `[${DOC_NOT_FOUND}] No open document has title or path "${name}".`, name });
      else hosts.push({ ok: true, doc: resolved.doc });
    }
  } else {
    const resolved = resolveHost(names[0] ?? "", open, false);
    if (!resolved.ok) return fail(resolved.code, resolved.message);
    if (!resolved.doc) return fail(DOC_REQUIRED, "No document is open in Revit. Open one, or pass document with a title or a full path.");
    hosts.push({ ok: true, doc: resolved.doc });
  }

  if (args.action === "audit") {
    const host = hosts[0];
    if (!host.ok) return fail(host.code, host.message);
    const facts = await io.facts(hostKey(host.doc));
    const links = asLinks(facts.links);
    const worksets = Array.isArray(facts.worksets) ? facts.worksets.map(String) : [];
    const audit = annotateBlocked(auditLinks(links, !!facts.workshared, worksets), links, open, host.doc).map((row, index) => {
      const other = links[index] ? notTheOpenModel(links[index], open, host.doc) : undefined;
      return other ? { ...row, problems: [...row.problems, `linked copy is not the open model ${other.title || other.path} (${links[index].path})`], state: "Fix" as const } : row;
    });
    const folder = (args.link_from ?? "").trim();
    const model = String(facts.model ?? `${host.doc.title ?? ""}.rvt`);
    const found = folder && io.listModels ? candidates(io.listModels(folder), links, model) : [];
    const extra = (args.documents ?? []).map((item) => item.trim()).filter(Boolean);
    let coordinates_check: ReturnType<typeof coordinatesAgree> | undefined;
    if (extra.length) {
      const rows: CoordRow[] = [{ model, coordinates: (facts.coordinates ?? {}) as Record<string, unknown> }];
      for (const name of extra) {
        const other = resolveHost(name, open, false);
        if (!other.ok || !other.doc || sameSession(other.doc, host.doc)) continue;
        const more = await io.facts(hostKey(other.doc));
        rows.push({ model: String(more.model ?? other.doc.title ?? name), coordinates: (more.coordinates ?? {}) as Record<string, unknown> });
      }
      coordinates_check = coordinatesAgree(rows);
    }
    const suggested = args.suggest ? suggestLinkSet(host.doc, links, audit, found.map((row) => row.path)) : undefined;
    return {
      body: {
        ok: true,
        model,
        workshared: !!facts.workshared,
        coordinates: facts.coordinates ?? {},
        links,
        audit,
        to_fix: audit.filter((row) => row.state === "Fix").length,
        link_from: folder,
        candidates: found,
        ...(coordinates_check ? { coordinates_check } : {}),
        ...(suggested ? { suggested } : {}),
        link_from_problem: folder && !io.exists(folder) ? `Folder not found: ${folder}` : "",
        resolved_document: docStamp(host.doc),
        source: "open",
        opened: false,
      },
      isError: false,
    };
  }

  if (args.action === "pin") {
    const host = hosts[0];
    if (!host.ok) return fail(host.code, host.message);
    const facts = await io.facts(hostKey(host.doc));
    const links = asLinks(facts.links);
    const loose = links.filter((link) => !link.pinned);
    if (!loose.length) return { body: { ok: true, dry_run: dry, nothing: true, message: "Every link is pinned", resolved_document: docStamp(host.doc) }, isError: false };
    if (dry) return { body: { ok: true, dry_run: true, would: loose.map((link) => ({ id: link.id, name: link.name })), next: "Run again with dry_run=false", resolved_document: docStamp(host.doc) }, isError: false };
    const raw = await io.linkPin({ document: hostKey(host.doc), element_ids: loose.map((link) => link.id) }) ?? {};
    return { body: { ok: true, done: true, pinned: raw.pinned ?? loose.length, resolved_document: docStamp(host.doc) }, isError: false };
  }

  if (args.action === "unload") {
    const host = hosts[0];
    if (!host.ok) return fail(host.code, host.message);
    const id = args.link_type_id;
    if (id == null || id === "" || Number(id) === 0) return fail(LINK_NOT_LOADED, "link_type_id is the Revit link type id. Audit the host and pass type_id, not the instance id.");
    if (dry) return { body: { ok: true, dry_run: true, document: docStamp(host.doc), would: { link_type_id: Number(id), result: "would unload" }, next: "Run again with dry_run=false" }, isError: false };
    try {
      const raw = await io.unload({ document: hostKey(host.doc), link_type_id: Number(id) }) ?? {};
      const bad = raw.ok === false || typeof raw.code === "string";
      return { body: { ok: !bad, dry_run: false, document: docStamp(host.doc), resolved_document: docStamp(host.doc), ...raw }, isError: bad };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(codeIn(message) ?? LINK_NOT_LOADED, message, { document: docStamp(host.doc) });
    }
  }

  if (args.action === "reload" || args.action === "repath") {
    const host = hosts[0];
    if (!host.ok) return fail(host.code, host.message);
    const planned = planReloadLink({ document: hostKey(host.doc), link_type_id: args.link_type_id, path: args.action === "repath" ? (args.path ?? "") : args.path }, { title: host.doc.title, path: host.doc.path, isFamily: host.doc.isFamily });
    if (!planned.ok) return fail(LINK_NOT_LOADED, planned.message, { document: planned.document });
    const asked = planned.params.path ?? "";
    if (args.action === "repath" && !asked) return fail(LINK_NOT_LOADED, "repath needs path: the .rvt the link should load.");
    const blocker = asked ? blockingHost(asked, open, host.doc) : undefined;
    if (blocker && mode === "fail") return fail(LINK_OPEN_AS_HOST, openModelHint(asked, open) ?? `Blocked by ${blocker.title}.`, { document: docStamp(host.doc), blocked_by: blocker.title || blocker.path });
    if (dry) {
      const placePlan = asked && blocker && mode === "published_copy"
        ? planPlace(asked, linkRole(asked), host.doc, [], open, cfg, mode, args.copy_folder, (p) => io.exists(p), false)
        : undefined;
      return {
        body: {
          ok: placePlan?.route !== "blocked",
          dry_run: true,
          action: args.action,
          document: docStamp(host.doc),
          would: placePlan ? wouldLine(placePlan, false) : { link_type_id: planned.params.link_type_id, path: asked || "(current)", result: asked ? "would load that path" : "would reload the current path" },
          ...(placePlan?.route === "blocked" ? { code: placePlan.code, message: placePlan.message } : {}),
        },
        isError: placePlan?.route === "blocked",
      };
    }
    if (asked && blocker && mode === "published_copy") {
      const placePlan = planPlace(asked, linkRole(asked), host.doc, [], open, cfg, mode, args.copy_folder, (p) => io.exists(p), false);
      if (placePlan.route === "blocked") return fail(placePlan.code ?? LINK_PROTECTED, placePlan.message ?? "refused", { document: docStamp(host.doc) });
      const row = await place(io, host.doc, { ...placePlan, existing: { id: 0, name: "", path: "", path_type: "", attachment: "", loaded: false, pinned: false, workset: "", type_id: planned.params.link_type_id } }, [], open, cfg, false, mode);
      return { body: { ...row, document: docStamp(host.doc), resolved_document: docStamp(host.doc), dry_run: false }, isError: row.ok !== true };
    }
    try {
      const raw = await io.reload(planned.params) ?? {};
      const verdict = judgeReload(raw, planned.params.path, open);
      let followed = verdict;
      let extra: Record<string, unknown> = {};
      if (!verdict.ok && verdict.code === LINK_OPEN_AS_HOST && asked && mode === "published_copy") {
        const placePlan = planPlace(asked, linkRole(asked), host.doc, [], open, cfg, "published_copy", args.copy_folder, () => true, false);
        const row = await place(io, host.doc, { ...placePlan, existing: { id: 0, name: "", path: asked, path_type: "", attachment: "", loaded: false, pinned: false, workset: "", type_id: planned.params.link_type_id }, route: placePlan.route === "blocked" ? "blocked" : "published_copy" }, [], open, cfg, false, "published_copy");
        return { body: { ...raw, ...row, document: docStamp(host.doc) }, isError: row.ok !== true };
      }
      return { body: { ...raw, ...followed, ...extra, document: docStamp(host.doc), resolved_document: docStamp(host.doc) }, isError: !followed.ok };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(codeIn(message) ?? LINK_NOT_LOADED, message, { document: docStamp(host.doc) });
    }
  }

  const items = modelsOf(args);
  if (!items.length) return fail(LINK_PROTECTED, args.action === "apply" ? "link_set is the models to link (path and role)." : "Choose the models to link", { reasons: [args.action === "apply" ? "link_set is empty" : "Choose the models to link"] });

  const rows: Record<string, unknown>[] = [];
  for (const host of hosts) {
    if (!host.ok) { rows.push({ ok: false, document: { title: host.name, path: "" }, code: host.code, message: host.message }); continue; }
    let links: LinkFact[] = [];
    let modelName = host.doc.title ?? "";
    try {
      const facts = await io.facts(hostKey(host.doc));
      links = asLinks(facts.links);
      modelName = String(facts.model ?? modelName);
      if (!host.doc.central && typeof facts.central === "string" && facts.central) host.doc.central = facts.central;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rows.push({ ok: false, document: docStamp(host.doc), code: codeIn(message) ?? DOC_NOT_FOUND, message });
      continue;
    }
    const plans = items.map((item) => planPlace(item.path, linkRole(item.path, item.role), host.doc, links, open, cfg, mode, args.copy_folder, (p) => io.exists(p), args.action === "link"));
    if (dry) {
      const would = plans.map((plan) => wouldLine(plan, pin));
      const blocked = plans.filter((plan) => plan.route === "blocked");
      rows.push({
        ok: blocked.length === 0,
        document: docStamp(host.doc),
        model: modelName,
        would,
        ...(blocked.length ? { code: blocked[0].code, message: blocked[0].message } : {}),
      });
      continue;
    }
    const results: Record<string, unknown>[] = [];
    for (const plan of plans) {
      try { results.push(await place(io, host.doc, plan, links, open, cfg, pin, mode)); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ name: win.basename(plan.source), ok: false, code: codeIn(message) ?? LINK_NOT_LOADED, message, result: `not linked: ${message}` });
      }
    }
    const failed = results.filter((row) => row.ok === false);
    rows.push({ ok: failed.length === 0, document: docStamp(host.doc), model: modelName, models: results, results });
  }

  const failedRows = rows.filter((row) => row.ok === false);
  const body: Record<string, unknown> = {
    ok: failedRows.length === 0,
    dry_run: dry,
    action: args.action,
    on_blocked: mode,
    pin,
    documents: rows,
    positioning: "Auto – By Shared Coordinates",
  };
  if (rows.length === 1) {
    const only = rows[0];
    body.resolved_document = only.document;
    if (args.action === "link") {
      body.would = only.would;
      body.models = only.models ?? only.results;
      if (typeof only.message === "string") body.message = only.message;
      if (Array.isArray(only.would) && dry) body.next = "Run again with dry_run=false";
    }
  }
  if (failedRows.length) {
    const nested = (row: Record<string, unknown>) => (Array.isArray(row.results) ? row.results as Array<Record<string, unknown>> : []).find((item) => item.ok === false);
    body.reasons = failedRows.map((row) => {
      const item = nested(row);
      return String(row.message ?? item?.message ?? item?.result ?? row.code ?? "failed");
    });
    const first = nested(failedRows[0]);
    body.code = failedRows[0].code ?? first?.code;
    if (!body.message && first?.message) body.message = first.message;
    if (first?.still_blocked === true) body.still_blocked = true;
    if (first?.blocked_by) body.blocked_by = first.blocked_by;
    if (first?.published_copy) body.published_copy = first.published_copy;
  }
  if (JSON.stringify(body).includes("published_copy") || JSON.stringify(body).includes("published copy")) body.api_limit = IDENTITY_LIMIT;
  return { body, isError: failedRows.length > 0 };
}

export { DOC_AMBIGUOUS, DOC_NOT_FOUND, DOC_REQUIRED };
