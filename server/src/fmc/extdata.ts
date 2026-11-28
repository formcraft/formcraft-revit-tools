import path from "node:path";
import { GuardConfig, expandEnv, isInside } from "./policy.js";

const win = path.win32;

/**
 * fmc_external_data: what the open model pulls in from outside (Revit's Manage Links), read-only. The add-in
 * (fmc_external_data, R25: ExternalFileUtils, ExternalResourceUtils, the registered external resource servers) supplies the
 * facts; this module redacts anything credential-shaped again (defence in depth), says where each path sits (the kit, a CDE
 * gate folder, a protected root), and states what Revit 2025 cannot show. It changes nothing.
 */

export interface ExtFile {
  element_id?: number; name?: string; type?: string; path_type?: string; status?: string;
  path?: string; stored_path?: string; cloud?: boolean; server_path?: boolean; attachment?: string; error?: string;
}
export interface ExtResource {
  element_id?: number; element?: string; element_class?: string; resource_type?: string; server_id?: string; server?: string;
  version?: string; in_session_path?: string; display_name?: string; version_status?: string;
  reference_info?: Record<string, string>; error?: string;
}

const SECRET_KEY = /token|secret|passw|pwd|credential|signature|bearer|cookie|api[_-]?key|access[_-]?key|private[_-]?key|authoriz|^auth|[_-]auth|^sig$|^sas$/i;
const SECRET_VALUE = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$|^[A-Za-z0-9+/=_-]{40,}$/;

/** A URL loses user:password@, its query and its fragment. Anything else is returned as it is. */
export function stripUrl(value: string): string {
  if (!value.includes("://")) return value;
  let v = value;
  const q = v.search(/[?#]/);
  if (q >= 0) v = v.slice(0, q) + "?[redacted]";
  const scheme = v.indexOf("://");
  const at = v.indexOf("@", scheme + 3);
  const slash = v.indexOf("/", scheme + 3);
  if (at > 0 && (slash < 0 || at < slash)) v = v.slice(0, scheme + 3) + v.slice(at + 1);
  return v;
}

/** One reported value: a credential-looking key or value becomes "[redacted]". */
export function redact(key: string, value: unknown): string {
  const v = value == null ? "" : String(value);
  if (SECRET_KEY.test(key) || SECRET_VALUE.test(v)) return "[redacted]";
  return stripUrl(v);
}

/** Where a path sits. Case-insensitive, like Windows. Empty path (a cloud or server link) says so rather than guessing. */
export interface Placement { in_kit: boolean; cde_gate_folder: string; in_protected_root: boolean; where: string }

export interface Roots { kit: string; blocked_segments: string[]; protected_roots: string[] }

export function rootsOf(cfg: GuardConfig, kitRoot: string): Roots {
  return { kit: kitRoot, blocked_segments: cfg.blocked_segments ?? [], protected_roots: cfg.protected_roots ?? [] };
}

export function placeOf(p: string, roots: Roots): Placement {
  if (!p) return { in_kit: false, cde_gate_folder: "", in_protected_root: false, where: "no local path (cloud, server or content library)" };
  const segs = win.normalize(expandEnv(p)).toLowerCase().split("\\").filter(Boolean);
  const gate = roots.blocked_segments.find((s) => segs.includes(s.toLowerCase())) ?? "";
  const inKit = !!roots.kit && isInside(p, roots.kit);
  const prot = roots.protected_roots.some((r) => isInside(p, r));
  const where = inKit ? "the Formcraft kit (read-only)" : gate ? `CDE folder ${gate} (a gate, not a tool action)` : prot ? "a protected root" : "elsewhere";
  return { in_kit: inKit, cde_gate_folder: gate, in_protected_root: prot, where };
}

export const R25_NOTES = [
  "Read with Revit 2025 API: ExternalFileUtils (Revit links, CAD links, keynote table, assembly code table, decals, systems analysis report), ExternalResourceUtils (elements fed by an external resource server), and the registered external resource servers.",
  "Not in R25: the External Data Manager (IExternalDataManagerServer, rows in Manage Links) and Extended Properties (ExtendedPropertiesLink, AEC Data Model datasets) are Revit 2027 API. Nothing here lists them.",
  "Cloud links report their path as the visible path only; no project or model ids are read.",
  "version_status needs check_versions true: it asks each resource's own server, which may reach the network, so it is off by default.",
];

/** The tool's reply from the add-in's facts. Pure: no file or network access. */
export function summarise(facts: Record<string, unknown>, roots: Roots): Record<string, unknown> {
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const files = arr<ExtFile>(facts.external_files).map((f) => {
    const p = String(f.path ?? "");
    return { ...f, path: stripUrl(p), stored_path: stripUrl(String(f.stored_path ?? "")), ...placeOf(p, roots) };
  });
  const resources = arr<ExtResource>(facts.external_resources).map((r) => {
    const info: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.reference_info ?? {})) info[k] = redact(k, v);
    return { ...r, in_session_path: stripUrl(String(r.in_session_path ?? "")), reference_info: info };
  });
  const servers = arr<Record<string, unknown>>(facts.servers);
  const byType: Record<string, number> = {};
  for (const f of files) byType[String(f.type ?? "?")] = (byType[String(f.type ?? "?")] ?? 0) + 1;
  const notLoaded = files.filter((f) => f.status && f.status !== "Loaded" && f.status !== "Imported").length;
  const inGate = files.filter((f) => f.cde_gate_folder).length;
  return {
    model: facts.model ?? "", revit: facts.revit ?? "", resolved_document: facts.resolved_document,
    read_only: true,
    roots: { kit: roots.kit, cde_gate_folders: roots.blocked_segments, protected_roots: roots.protected_roots, note: "reported, never changed" },
    counts: { files: files.length, by_type: byType, not_loaded: notLoaded, in_cde_gate_folders: inGate, resources: resources.length, servers: servers.length },
    external_files: files, external_resources: resources, servers,
    warnings: arr<string>(facts.warnings),
    r25: R25_NOTES,
  };
}