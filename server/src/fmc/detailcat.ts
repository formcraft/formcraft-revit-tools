/**
 * Kit typical details. The catalogue is the kit Details folder (.rvt / .rfa) plus FMC_Details.json.
 * A missing folder is a kit change request. This module does not invent detail geometry.
 */
import fs from "node:fs";
import path from "node:path";
import { kitPaths } from "./context.js";
import { configPath, loadConfig, type GuardConfig } from "./policy.js";
import { missingKitMessage } from "./kitcrs.js";

export const DETAIL_CAP = 50;

export interface DetailEntry {
  id: string;
  name: string;
  source: string;
  kind: "drafting" | "family";
  view: string;
  sheet: string;
  type_name: string;
  from: "folder" | "catalogue" | "both";
  exists: boolean;
}

export interface DetailRequest {
  detail_id: string;
  view_name?: string;
  sheet?: string;
}

export interface DetailOp {
  detail_id: string;
  name: string;
  source: string;
  kind: "drafting" | "family";
  view: string;
  view_name: string;
  sheet: string;
  type_name: string;
  exists: boolean;
}

export interface Catalogue {
  folder: string;
  catalogue_file: string;
  details: DetailEntry[];
  problems: string[];
}

const BACKUP = /\.\d{4}\.(rvt|rfa)$/i;

export function detailsFolder(env: NodeJS.ProcessEnv = process.env, guard?: GuardConfig): string {
  const override = (env.FMC_DETAILS_DIR ?? "").trim();
  if (override) return override;
  try {
    const loaded = guard ? { config: guard } : loadConfig(configPath(env));
    return path.win32.join(kitPaths(loaded.config).root, "Details");
  } catch {
    return "";
  }
}

function walk(dir: string, out: string[]) {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "_Archive" || entry.name.startsWith(".")) continue;
      walk(full, out);
    } else if (entry.isFile() && /\.(rvt|rfa)$/i.test(entry.name) && !BACKUP.test(entry.name)) {
      out.push(full);
    }
  }
}

function kindOf(file: string, stated?: string): "drafting" | "family" {
  if (stated === "family" || stated === "drafting") return stated;
  return /\.rfa$/i.test(file) ? "family" : "drafting";
}

function idOf(file: string): string {
  return path.basename(file).replace(/\.(rvt|rfa)$/i, "");
}

interface RawDetail {
  id?: unknown;
  name?: unknown;
  source?: unknown;
  file?: unknown;
  kind?: unknown;
  view?: unknown;
  sheet?: unknown;
  type_name?: unknown;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readJsonCatalogue(file: string): RawDetail[] {
  const raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as { details?: unknown };
  if (!raw || !Array.isArray(raw.details)) return [];
  return raw.details.filter((row) => row && typeof row === "object") as RawDetail[];
}

function resolveSource(folder: string, stated: string): string {
  if (!stated) return "";
  if (path.win32.isAbsolute(stated) || path.posix.isAbsolute(stated)) return stated;
  return path.join(folder, stated);
}

/** Folder files plus FMC_Details.json (or catalogue.json). The JSON wins on the same id. */
export function loadCatalogue(folder: string): Catalogue {
  const problems: string[] = [];
  if (!folder) {
    return {
      folder: "", catalogue_file: "", details: [],
      problems: [missingKitMessage("K-03", "FMC-DETAILS-CATALOGUE: the kit Details folder is not set")],
    };
  }
  if (!fs.existsSync(folder)) {
    return {
      folder, catalogue_file: "", details: [],
      problems: [missingKitMessage("K-03", `FMC-DETAILS-CATALOGUE: ${folder} is not in the kit`)],
    };
  }
  const files: string[] = [];
  walk(folder, files);
  const byId = new Map<string, DetailEntry>();
  for (const file of files) {
    const id = idOf(file);
    byId.set(id.toLowerCase(), {
      id, name: id, source: file, kind: kindOf(file), view: "", sheet: "", type_name: "", from: "folder", exists: true,
    });
  }
  const jsonName = ["FMC_Details.json", "catalogue.json"].find((name) => fs.existsSync(path.join(folder, name))) ?? "";
  const catalogueFile = jsonName ? path.join(folder, jsonName) : "";
  if (catalogueFile) {
    let rows: RawDetail[] = [];
    try { rows = readJsonCatalogue(catalogueFile); }
    catch (error) {
      problems.push(`FMC-DETAILS-CATALOGUE: ${catalogueFile} did not parse (${error instanceof Error ? error.message : String(error)}).`);
    }
    for (const row of rows) {
      const id = asText(row.id);
      if (!id) { problems.push("FMC-DETAILS-CATALOGUE: a catalogue row has no id."); continue; }
      const source = resolveSource(folder, asText(row.source) || asText(row.file));
      const prior = byId.get(id.toLowerCase());
      const file = source || prior?.source || "";
      const exists = file ? fs.existsSync(file) : false;
      if (file && !exists) problems.push(`FMC-DETAIL-SOURCE: ${id} names ${file}, and that file is not there.`);
      byId.set(id.toLowerCase(), {
        id,
        name: asText(row.name) || prior?.name || id,
        source: file,
        kind: kindOf(file, asText(row.kind) || prior?.kind),
        view: asText(row.view) || prior?.view || "",
        sheet: asText(row.sheet) || prior?.sheet || "",
        type_name: asText(row.type_name) || prior?.type_name || "",
        from: prior ? "both" : "catalogue",
        exists,
      });
    }
  } else {
    problems.push(missingKitMessage("K-03", `FMC-DETAILS-CATALOGUE: ${folder} has no FMC_Details.json. Folder files are listed`));
  }
  const details = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { folder, catalogue_file: catalogueFile, details, problems };
}

export function findDetail(catalogue: Catalogue, id: string): DetailEntry | undefined {
  const key = id.trim().toLowerCase();
  return catalogue.details.find((row) => row.id.toLowerCase() === key);
}

export function viewNameFor(entry: DetailEntry, requested: string): string {
  const asked = requested.trim();
  if (asked) return asked;
  const label = entry.name && entry.name !== entry.id ? `${entry.id} ${entry.name}` : entry.id;
  return `DET ${label}`.replace(/\s+/g, " ").trim();
}

export function planDetails(catalogue: Catalogue, requests: DetailRequest[]): { ops: DetailOp[]; missing: string[] } {
  const ops: DetailOp[] = [];
  const missing: string[] = [];
  for (const request of requests) {
    const id = request.detail_id.trim();
    if (!id) continue;
    const entry = findDetail(catalogue, id);
    if (!entry) { missing.push(id); continue; }
    ops.push({
      detail_id: entry.id,
      name: entry.name,
      source: entry.source,
      kind: entry.kind,
      view: entry.view,
      view_name: viewNameFor(entry, request.view_name ?? ""),
      sheet: (request.sheet ?? "").trim() || entry.sheet,
      type_name: entry.type_name,
      exists: entry.exists,
    });
  }
  return { ops, missing };
}

/** A batch file is { detail_ids: string[] } or { details: [{ detail_id, view_name?, sheet? }] }. */
export function readBatchFile(file: string): DetailRequest[] {
  const raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  const out: DetailRequest[] = [];
  if (Array.isArray(raw.detail_ids)) {
    for (const id of raw.detail_ids) if (typeof id === "string" && id.trim()) out.push({ detail_id: id.trim() });
  }
  if (Array.isArray(raw.details)) {
    for (const row of raw.details) {
      if (!row || typeof row !== "object") continue;
      const item = row as Record<string, unknown>;
      const id = asText(item.detail_id) || asText(item.id);
      if (!id) continue;
      out.push({ detail_id: id, view_name: asText(item.view_name), sheet: asText(item.sheet) });
    }
  }
  return out;
}

export function isKitOriginal(filePath: string): boolean {
  const norm = filePath.replace(/\//g, "\\");
  if (/\\_Staging\\/i.test(norm) || /\\_ChainTests\\/i.test(norm)) return false;
  if (/\\04_Families\\/i.test(norm)) return true;
  if (/\\00_Standards\\/i.test(norm) && /\.(rfa|rvt)$/i.test(norm)) return true;
  return false;
}

export function referenceProblems(refs: { kit?: string[]; standards?: string[]; rulebook?: string[] } | undefined): string | null {
  if (!refs) return "[FMC-DETAIL-REFERENCES] A write needs references.kit, references.standards and references.rulebook.";
  for (const key of ["kit", "standards", "rulebook"] as const) {
    const list = refs[key];
    if (!Array.isArray(list) || !list.some((item) => String(item).trim())) {
      return "[FMC-DETAIL-REFERENCES] A write needs references.kit, references.standards and references.rulebook.";
    }
  }
  return null;
}

export function detailsDir(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.FMC_DETAILS_REPORT ?? "").trim()) return env.FMC_DETAILS_REPORT!.trim();
  const local = env.LOCALAPPDATA || path.join(path.sep, "tmp", "FormcraftLocal");
  return path.join(local, "Formcraft", "details");
}

export function writeDetailsReport(env: NodeJS.ProcessEnv, action: string, body: unknown, dir = detailsDir(env)): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `details-${action}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}
