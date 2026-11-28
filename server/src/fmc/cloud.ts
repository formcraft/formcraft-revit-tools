/**
 * fmc_cloud: Autodesk Docs (ACC / BIM 360) cloud model facts and the one gated write (save as cloud model).
 *
 * Pure functions (Node built-ins only), so they are unit tested without Revit.
 *  - The CollaborationCache guard: Revit's local cloud cache is never read, written, deleted or listed. Any argument
 *    that names it is refused before Revit is asked anything, and any path Revit returns inside it is redacted.
 *  - Cloud path parsing: Revit's user-visible cloud paths ("Autodesk Docs://Project/Model.rvt", the older
 *    "BIM 360://Project/Model.rvt"), Revit Server paths (RSN://), local and UNC paths.
 *  - GUIDs and regions for ModelPathUtils.ConvertCloudGUIDsToCloudPath. The Revit 2025 API names two regions:
 *    ModelPathUtils.CloudRegionUS ("US") and ModelPathUtils.CloudRegionEMEA ("EMEA").
 *  - The write gate: a dry run by default, and a real write needs dry_run=false AND approved_by, a named person.
 *    Synchronising or publishing a workshared cloud model is never done by a tool (CLAUDE.md rule 6).
 */

export const CACHE_FOLDER = "CollaborationCache";
export const CACHE_CODE = "FMC-CLOUD-CACHE";
export const APPROVAL_CODE = "FMC-CLOUD-APPROVAL";
export const REDACTED_CACHE = "(inside CollaborationCache: not read)";

/** The regions ModelPathUtils exposes in Revit 2025 (CloudRegionUS, CloudRegionEMEA). */
export const KNOWN_REGIONS = ["US", "EMEA"] as const;
export type CloudRegion = (typeof KNOWN_REGIONS)[number];

function decodeAll(s: string): string {
  let out = s;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(out);
      if (next === out) break;
      out = next;
    } catch {
      break;
    }
  }
  return out;
}

/**
 * True when the text names Revit's CollaborationCache folder, however it is written: any case, URL-encoded, with
 * spaces, dashes, underscores or dots between the words, or with forward or back slashes.
 */
export function mentionsCollaborationCache(text: unknown): boolean {
  if (typeof text !== "string" || !text) return false;
  const flat = decodeAll(text).toLowerCase().replace(/[\s_\-.%]+/g, "");
  return flat.includes("collaborationcache");
}

export interface CacheHit { field: string; value: string }

/** Every string in the arguments (nested objects and arrays too) that names CollaborationCache. */
export function cacheHits(value: unknown, field = "args"): CacheHit[] {
  if (typeof value === "string") return mentionsCollaborationCache(value) ? [{ field, value }] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => cacheHits(v, `${field}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
      ...(mentionsCollaborationCache(k) ? [{ field: `${field}.${k}`, value: k }] : []),
      ...cacheHits(v, `${field}.${k}`),
    ]);
  }
  return [];
}

/** The refusal for a CollaborationCache argument. Nothing is sent to Revit. */
export function cacheRefusal(hits: CacheHit[]) {
  return {
    refused: true,
    code: CACHE_CODE,
    message: `[${CACHE_CODE}] Refused: ${hits.map((h) => h.field).join(", ")} names the CollaborationCache folder. ` +
      "Revit's local cloud cache is never read, written, deleted or listed by a tool. Name the cloud model (Autodesk Docs:// path or its GUIDs) instead.",
    fields: hits.map((h) => h.field),
  };
}

/** Replaces any string inside CollaborationCache (in a Revit reply) with a fixed marker, so no cache path leaves the server. */
export function redactCache<T>(value: T): T {
  if (typeof value === "string") return (mentionsCollaborationCache(value) ? REDACTED_CACHE : value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactCache(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactCache(v);
    return out as T;
  }
  return value;
}

export type PathKind = "autodesk_docs" | "bim360" | "revit_server" | "local" | "unc" | "empty" | "unknown";

export interface ParsedPath {
  input: string;
  kind: PathKind;
  cloud: boolean;
  /** Project name for a cloud path; server for Revit Server. */
  project: string;
  /** Folders between the project and the model (Autodesk Docs folders, if Revit shows them). */
  folders: string[];
  model: string;
  /** Problems with the path itself. Empty when it parsed cleanly. */
  problems: string[];
}

const CLOUD_PREFIXES: Array<{ re: RegExp; kind: PathKind }> = [
  { re: /^autodesk\s*docs:\/\//i, kind: "autodesk_docs" },
  { re: /^bim\s*360:\/\//i, kind: "bim360" },
];

/** Parses a user-visible model path (ModelPathUtils.ConvertModelPathToUserVisiblePath output, or what a person types). */
export function parseModelPath(raw: unknown): ParsedPath {
  const input = typeof raw === "string" ? raw.trim() : "";
  const base: ParsedPath = { input, kind: "empty", cloud: false, project: "", folders: [], model: "", problems: [] };
  if (!input) return { ...base, problems: ["No path given"] };
  if (mentionsCollaborationCache(input)) return { ...base, kind: "unknown", input: REDACTED_CACHE, problems: [`[${CACHE_CODE}] Path is inside CollaborationCache: not parsed`] };
  for (const p of CLOUD_PREFIXES) {
    const m = input.match(p.re);
    if (!m) continue;
    const rest = input.slice(m[0].length);
    const parts = rest.split(/[\\/]+/).map((s) => s.trim()).filter(Boolean);
    const problems: string[] = [];
    if (parts.length < 2) problems.push("A cloud path needs a project and a model: <prefix>://<Project>/<Model>.rvt");
    const model = parts.length >= 2 ? parts[parts.length - 1] : "";
    if (model && !/\.rvt$/i.test(model)) problems.push(`Model "${model}" does not end in .rvt`);
    return { input, kind: p.kind, cloud: true, project: parts[0] ?? "", folders: parts.slice(1, -1), model, problems };
  }
  if (/^rsn:\/\//i.test(input)) {
    const parts = input.slice(6).split(/[\\/]+/).filter(Boolean);
    const model = parts.length >= 2 ? parts[parts.length - 1] : "";
    return { input, kind: "revit_server", cloud: false, project: parts[0] ?? "", folders: parts.slice(1, -1), model,
      problems: parts.length < 2 ? ["A Revit Server path needs a server and a model: RSN://<server>/<folders>/<Model>.rvt"] : [] };
  }
  if (/^\\\\[^\\]/.test(input)) {
    const parts = input.slice(2).split(/[\\/]+/).filter(Boolean);
    return { input, kind: "unc", cloud: false, project: "", folders: parts.slice(0, -1), model: parts[parts.length - 1] ?? "", problems: [] };
  }
  if (/^[a-z]:[\\/]/i.test(input)) {
    const parts = input.split(/[\\/]+/).filter(Boolean);
    return { input, kind: "local", cloud: false, project: "", folders: parts.slice(0, -1), model: parts[parts.length - 1] ?? "", problems: [] };
  }
  return { ...base, kind: "unknown", problems: ["Not a cloud (Autodesk Docs:// or BIM 360://), Revit Server, local or UNC path"] };
}

const GUID_RE = /^\{?([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})\}?$/i;

/** A GUID in the canonical lower-case 8-4-4-4-12 form, or null. The all-zero GUID is not a model or project. */
export function normalizeGuid(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(GUID_RE);
  if (!m) return null;
  const g = `${m[1]}-${m[2]}-${m[3]}-${m[4]}-${m[5]}`.toLowerCase();
  return /^[0-]+$/.test(g) ? null : g;
}

/**
 * ACC / BIM 360 account and project ids sometimes come with a "b." prefix (Data Management API). Revit's
 * SaveAsCloudModel takes the bare GUID.
 */
export function normalizeAccGuid(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return normalizeGuid(raw.trim().replace(/^b\./i, ""));
}

export function normalizeRegion(raw: unknown): CloudRegion | null {
  if (typeof raw !== "string") return null;
  const r = raw.trim().toUpperCase();
  return (KNOWN_REGIONS as readonly string[]).includes(r) ? (r as CloudRegion) : null;
}

export interface GuidTriple { region: string; project_guid: string; model_guid: string }

/** Checks one region + project GUID + model GUID item before ConvertCloudGUIDsToCloudPath. */
export function checkGuidTriple(item: Partial<Record<keyof GuidTriple, unknown>>): { ok: true; value: GuidTriple } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const region = normalizeRegion(item.region);
  const project = normalizeGuid(item.project_guid);
  const model = normalizeGuid(item.model_guid);
  if (!region) problems.push(`Region "${String(item.region ?? "")}" is not one Revit 2025 knows (${KNOWN_REGIONS.join(", ")})`);
  if (!project) problems.push(`project_guid "${String(item.project_guid ?? "")}" is not a GUID`);
  if (!model) problems.push(`model_guid "${String(item.model_guid ?? "")}" is not a GUID`);
  if (problems.length || !region || !project || !model) return { ok: false, problems };
  return { ok: true, value: { region, project_guid: project, model_guid: model } };
}

/** Words that are not a person. approved_by must name the person who approved the write. */
const NOT_A_PERSON = new Set([
  "yes", "y", "ok", "okay", "true", "approve", "approved", "confirm", "confirmed", "go", "me", "self", "user", "person",
  "ai", "bot", "agent", "assistant", "claude", "grok", "gpt", "cursor", "auto", "automatic", "system", "admin", "test", "none", "n/a", "na",
]);

export interface GateInput { dry_run?: boolean; approved_by?: string }
export type GateVerdict =
  | { mode: "dry_run" }
  | { mode: "write"; approved_by: string }
  | { mode: "refused"; code: string; message: string };

/**
 * The write gate. dry_run defaults to true. A real write needs dry_run=false AND approved_by naming a person
 * (at least two letters, not "yes", "ok", "AI", a bot name or similar). Anything else is refused.
 */
export function gateWrite(input: GateInput): GateVerdict {
  if (input.dry_run !== false) return { mode: "dry_run" };
  const who = String(input.approved_by ?? "").trim();
  if (!who) return { mode: "refused", code: APPROVAL_CODE, message: `[${APPROVAL_CODE}] A real cloud write needs approved_by: the name of the person who approved it, as well as dry_run=false. Nothing was changed.` };
  const letters = who.replace(/[^\p{L}]/gu, "");
  if (letters.length < 2 || NOT_A_PERSON.has(who.toLowerCase()) || /\b(bot|agent|ai)\b/i.test(who))
    return { mode: "refused", code: APPROVAL_CODE, message: `[${APPROVAL_CODE}] approved_by "${who}" does not name a person. Give the approving person's name. Nothing was changed.` };
  return { mode: "write", approved_by: who };
}

export interface CloudDocFacts {
  title?: string;
  is_family?: boolean;
  is_cloud?: boolean;
  is_workshared?: boolean;
  is_modified?: boolean;
  is_read_only?: boolean;
  path_name?: string;
}

export interface SaveAsCloudInput {
  account_id?: string;
  project_id?: string;
  folder_id?: string;
  model_name?: string;
}

export interface SaveAsCloudPlan {
  ok: boolean;
  problems: string[];
  account_guid: string;
  project_guid: string;
  folder_id: string;
  model_name: string;
  would: string[];
}

/**
 * Plans Document.SaveAsCloudModel(accountId, projectId, folderId, modelName) for one open document.
 * Refused for a workshared model (rule 6: a person saves and syncs workshared models), a model already in the cloud,
 * a family, a read-only document, or bad ids. folder_id is the Docs folder URN (urn:adsk.wipprod:fs.folder:co.…).
 */
export function planSaveAsCloud(doc: CloudDocFacts | null | undefined, input: SaveAsCloudInput): SaveAsCloudPlan {
  const problems: string[] = [];
  const account = normalizeAccGuid(input.account_id);
  const project = normalizeAccGuid(input.project_id);
  const folder = String(input.folder_id ?? "").trim();
  let name = String(input.model_name ?? "").trim();
  if (!doc) problems.push("The document's facts could not be read");
  if (doc?.is_family) problems.push("A family is not saved to Autodesk Docs by this tool");
  if (doc?.is_cloud) problems.push("This model is already a cloud model");
  if (doc?.is_workshared) problems.push("This model is workshared: a person saves and syncs workshared models in Revit (CLAUDE.md rule 6)");
  if (doc?.is_read_only) problems.push("This document is read-only");
  if (!account) problems.push(`account_id "${String(input.account_id ?? "")}" is not a GUID (the ACC / BIM 360 account, with or without "b.")`);
  if (!project) problems.push(`project_id "${String(input.project_id ?? "")}" is not a GUID (the ACC / BIM 360 project, with or without "b.")`);
  if (!folder) problems.push("folder_id is required: the Autodesk Docs folder URN (urn:adsk.wipprod:fs.folder:co.…)");
  else if (!/^urn:adsk\.[a-z0-9]+:fs\.folder:[A-Za-z0-9._:-]+$/i.test(folder)) problems.push(`folder_id "${folder}" is not a Docs folder URN (urn:adsk.wipprod:fs.folder:co.…)`);
  if (!name) problems.push("model_name is required");
  if (name && /[\\/:*?"<>|]/.test(name)) problems.push(`model_name "${name}" holds a character a file name cannot`);
  if (name && !/\.rvt$/i.test(name)) name = `${name}.rvt`;
  for (const v of [folder, name]) if (mentionsCollaborationCache(v)) problems.push(`[${CACHE_CODE}] ${v} names CollaborationCache`);
  const would = problems.length ? [] : [
    `Call Document.SaveAsCloudModel on "${doc?.title ?? ""}"`,
    `Account ${account}, project ${project}, folder ${folder}`,
    `Create the cloud model "${name}" in Autodesk Docs (a new non-workshared cloud model; nothing is synced or published)`,
    "The open document then points at the cloud model; the local file on disk is left as it is",
  ];
  return { ok: problems.length === 0, problems, account_guid: account ?? "", project_guid: project ?? "", folder_id: folder, model_name: name, would };
}

/** Sync and publish are never run by a tool (rule 6). The dry run says what a person would do in Revit. */
export function syncPlan(doc: CloudDocFacts | null | undefined, action: "sync" | "publish") {
  const what = action === "sync"
    ? ["Synchronize with Central on the cloud model (Collaborate › Synchronize with Central)", "Relinquish borrowed elements and worksets as the person chooses"]
    : ["Publish the latest cloud model version to Autodesk Docs (Collaborate › Manage Cloud Models › Publish, or the Docs web page)"];
  return {
    action,
    document: doc?.title ?? "",
    is_cloud: !!doc?.is_cloud,
    is_workshared: !!doc?.is_workshared,
    a_person_would: what,
    tool_will: "Nothing: fmc_cloud never synchronises, saves a workshared model or publishes (CLAUDE.md rule 6). A person does it in Revit.",
  };
}
