/**
 * The script library under 05_Scripts/library: index.json plus one manifest per script.
 * A manifest that omits kit, standards or rulebook is refused. Nothing here calls Revit.
 */
import fs from "node:fs";
import { screenScript } from "./scriptguard.js";
import { approvedScriptPath, kitRootFrom, pathOf, scriptRoots } from "./dynamo.js";
import { underAny, protectedRoots } from "./opencopy.js";
import type { GuardConfig } from "./policy.js";
import type { ResolvedDocument } from "./docresolve.js";
import { missingKitMessage } from "./kitcrs.js";

export const DIFF_CAP = 50;
export const INPUT_CAP = 50;
export const RUNNERS = ["dynamo", "csharp", "python", "pyrevit", "unavailable"] as const;
export type ScriptRunner = (typeof RUNNERS)[number];

export interface ScriptReferences {
  kit: string;
  standards: string;
  rulebook: string;
}

export interface ScriptManifest {
  id: string;
  entry: string;
  runner: ScriptRunner;
  inputs: unknown;
  outputs: unknown;
  revit_version: string;
  kit_version: string;
  references: ScriptReferences;
  dry_run: boolean;
  writes_model: boolean;
  workshared_safe: boolean;
  target_doc_rules: unknown;
  replaces_plugin_tools: string[];
  est_ai_calls_saved: number;
}

export interface LibraryEntry {
  id: string;
  manifest_path: string;
  manifest: ScriptManifest | null;
  problems: string[];
}

const REQUIRED = [
  "id", "entry", "runner", "inputs", "outputs", "revit_version", "kit_version", "references",
  "dry_run", "writes_model", "workshared_safe", "target_doc_rules", "replaces_plugin_tools", "est_ai_calls_saved",
] as const;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Missing kit, standards or rulebook, or any other required field. */
export function validateManifest(raw: unknown, file = ""): { ok: true; manifest: ScriptManifest } | { ok: false; problems: string[] } {
  const where = file ? `${file}: ` : "";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problems: [`${where}the manifest is not a JSON object`] };
  const row = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of REQUIRED) if (!(key in row) || row[key] === null || row[key] === undefined) problems.push(`${where}${key} is required`);
  const id = text(row.id);
  const entry = text(row.entry);
  if ("id" in row && !id) problems.push(`${where}id is required`);
  if ("entry" in row && !entry) problems.push(`${where}entry is required`);
  const runner = text(row.runner);
  if ("runner" in row && !RUNNERS.includes(runner as ScriptRunner)) problems.push(`${where}runner must be dynamo, csharp, python, pyrevit or unavailable`);
  if ("revit_version" in row && !text(row.revit_version)) problems.push(`${where}revit_version is required`);
  if ("kit_version" in row && !text(row.kit_version)) problems.push(`${where}kit_version is required`);
  for (const key of ["dry_run", "writes_model", "workshared_safe"] as const) {
    if (key in row && typeof row[key] !== "boolean") problems.push(`${where}${key} must be true or false`);
  }
  if ("replaces_plugin_tools" in row && (!Array.isArray(row.replaces_plugin_tools) || row.replaces_plugin_tools.some((item) => typeof item !== "string"))) {
    problems.push(`${where}replaces_plugin_tools must be a list of tool names`);
  }
  if ("est_ai_calls_saved" in row && (typeof row.est_ai_calls_saved !== "number" || !Number.isFinite(row.est_ai_calls_saved) || row.est_ai_calls_saved < 0)) {
    problems.push(`${where}est_ai_calls_saved must be a number of 0 or more`);
  }
  const refs = row.references;
  if (refs !== null && refs !== undefined) {
    if (!refs || typeof refs !== "object" || Array.isArray(refs)) problems.push(`${where}references must be an object with kit, standards and rulebook`);
    else {
      const bag = refs as Record<string, unknown>;
      for (const key of ["kit", "standards", "rulebook"] as const) {
        if (!text(bag[key])) problems.push(`${where}references.${key} is required`);
      }
    }
  }
  if (problems.length) return { ok: false, problems };
  const bag = refs as Record<string, unknown>;
  return {
    ok: true,
    manifest: {
      id, entry, runner: runner as ScriptRunner,
      inputs: row.inputs, outputs: row.outputs,
      revit_version: text(row.revit_version), kit_version: text(row.kit_version),
      references: { kit: text(bag.kit), standards: text(bag.standards), rulebook: text(bag.rulebook) },
      dry_run: row.dry_run === true, writes_model: row.writes_model === true, workshared_safe: row.workshared_safe === true,
      target_doc_rules: row.target_doc_rules,
      replaces_plugin_tools: (row.replaces_plugin_tools as string[]).slice(),
      est_ai_calls_saved: row.est_ai_calls_saved as number,
    },
  };
}

export function libraryDir(kit: string): string {
  return pathOf(kit).join(kit.replace(/[\\/]+$/, ""), "05_Scripts", "library");
}

function readJson(file: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) };
  } catch (error) {
    return { ok: false, message: `${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** index.json lists { id, manifest }. A missing manifest file is a problem on that row, not a throw. */
export function loadLibrary(kit: string): { folder: string; index: string; entries: LibraryEntry[]; problems: string[] } {
  const folder = libraryDir(kit);
  const index = pathOf(folder).join(folder, "index.json");
  const problems: string[] = [];
  const parsed = readJson(index);
  if (!parsed.ok) return { folder, index, entries: [], problems: [missingKitMessage("K-04", `Can't read ${parsed.message}`)] };
  const body = parsed.value as { scripts?: unknown };
  const rows = Array.isArray(body?.scripts) ? body.scripts : null;
  if (!rows) return { folder, index, entries: [], problems: [`${index} needs a scripts list`] };
  const entries: LibraryEntry[] = [];
  for (const row of rows) {
    const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
    const id = text(item.id);
    const rel = text(item.manifest) || (id ? pathOf(folder).join(id, "manifest.json") : "");
    if (!id || !rel) {
      problems.push("a scripts row needs an id");
      continue;
    }
    const p = pathOf(folder);
    const manifestPath = p.isAbsolute(rel) ? rel : p.join(folder, rel);
    const file = readJson(manifestPath);
    if (!file.ok) {
      entries.push({ id, manifest_path: manifestPath, manifest: null, problems: [`Can't read ${file.message}`] });
      continue;
    }
    const verdict = validateManifest(file.value, manifestPath);
    if (!verdict.ok) {
      entries.push({ id, manifest_path: manifestPath, manifest: null, problems: verdict.problems });
      continue;
    }
    const own: string[] = [];
    if (verdict.manifest.id !== id) own.push(`manifest id ${verdict.manifest.id} does not match the index id ${id}`);
    entries.push({ id, manifest_path: manifestPath, manifest: verdict.manifest, problems: own });
  }
  return { folder, index, entries, problems };
}

export function findScript(kit: string, id: string): LibraryEntry | null {
  const want = id.trim();
  return loadLibrary(kit).entries.find((entry) => entry.id === want) ?? null;
}

/** An absolute entry must sit in an approved folder. A relative entry is beside the manifest, then under the library. */
export function resolveEntry(kit: string, manifestPath: string, entry: string): { ok: true; file: string } | { ok: false; message: string } {
  const named = entry.trim();
  if (!named) return { ok: false, message: "The manifest has no entry." };
  const p = pathOf(manifestPath || kit);
  const candidates = p.isAbsolute(named)
    ? [named]
    : [p.join(p.dirname(manifestPath), named), p.join(libraryDir(kit), named), p.join(kit, named)];
  const file = candidates.find((item) => {
    try { return fs.existsSync(item) && fs.statSync(item).isFile(); } catch { return false; }
  });
  if (!file) return { ok: false, message: `Entry not found: ${named}` };
  if (!approvedScriptPath(file, kit)) return { ok: false, message: `[FMC-SCRIPT-ROOT] ${file} is outside ${scriptRoots(kit).join(" or ")}.` };
  return { ok: true, file };
}

/**
 * A script marked workshared_safe must not check out elements or handle editing requests.
 * The scan is textual. A match refuses the script.
 */
export function worksharedUnsafe(source: string): string | null {
  if (/\bCheckoutElements\b/.test(source)) return "CheckoutElements";
  if (/\bEditingRequests?\b/.test(source)) return "EditingRequest";
  return null;
}

export function refuseFullScan(flag: unknown): string | null {
  if (flag === true) {
    return "[FMC-SEND-CODE-UNSCOPED] allow_full_scan is refused on fmc_script_run. Scope the collector with OfCategory or OfClass. Nothing was sent to Revit.";
  }
  return null;
}

export function screenLibrarySource(source: string): { code: string; message: string } | null {
  return screenScript(source, undefined, { allowFullScan: false });
}

export interface DocFacts {
  title?: string;
  path?: string;
  workshared?: boolean;
  family?: boolean;
}

function versionMatches(want: string, have: string): boolean {
  const left = want.trim();
  const right = have.trim();
  return left === right || right.startsWith(left + ".");
}

function ruleProblems(rules: unknown, doc: DocFacts | undefined): string[] {
  if (rules === undefined || rules === null) return ["target_doc_rules is required"];
  if (typeof rules === "string") {
    const needle = rules.trim();
    if (!needle) return [];
    if (!doc?.title && !doc?.path) return [`target_doc_rules "${needle}" needs the document title or path before apply`];
    const hay = `${doc.title ?? ""} ${doc.path ?? ""}`.toLowerCase();
    return hay.includes(needle.toLowerCase()) ? [] : [`target_doc_rules "${needle}" does not match this document`];
  }
  if (Array.isArray(rules)) return rules.flatMap((item) => ruleProblems(item, doc));
  if (typeof rules !== "object") return ["target_doc_rules must be an object, a string, or a list"];
  const row = rules as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof row.workshared === "boolean") {
    if (doc?.workshared === undefined) problems.push("target_doc_rules.workshared needs to know whether the document is workshared");
    else if (doc.workshared !== row.workshared) problems.push(`target_doc_rules.workshared is ${row.workshared}; this document is ${doc.workshared ? "workshared" : "not workshared"}`);
  }
  if (typeof row.family === "boolean") {
    if (doc?.family === undefined) problems.push("target_doc_rules.family needs to know whether the document is a family");
    else if (doc.family !== row.family) problems.push(`target_doc_rules.family is ${row.family}`);
  }
  if (typeof row.title === "string" && row.title.trim()) {
    if (!doc?.title) problems.push("target_doc_rules.title needs the document title");
    else if (doc.title.trim().toLowerCase() !== row.title.trim().toLowerCase()) problems.push(`target_doc_rules.title is ${row.title}`);
  }
  if (typeof row.path_includes === "string" && row.path_includes.trim()) {
    if (!doc?.path) problems.push("target_doc_rules.path_includes needs the document path");
    else if (!doc.path.toLowerCase().includes(row.path_includes.trim().toLowerCase())) problems.push(`target_doc_rules.path_includes "${row.path_includes}" is not in the path`);
  }
  return problems;
}

/** Checks that run only before apply. A preview does not call this. */
export function applyProblems(manifest: ScriptManifest, ctx: { revitVersion?: string; document?: DocFacts }): string[] {
  const problems: string[] = [];
  if (ctx.revitVersion && !versionMatches(manifest.revit_version, ctx.revitVersion)) {
    problems.push(`revit_version ${manifest.revit_version} does not match this Revit (${ctx.revitVersion}).`);
  }
  if (ctx.document?.workshared === true && manifest.workshared_safe !== true) {
    problems.push("This document is workshared and the script is not marked workshared_safe.");
  }
  problems.push(...ruleProblems(manifest.target_doc_rules, ctx.document));
  return problems;
}

export interface ParameterValue { name: string; value: string }
export interface ParameterRow { id: number; parameters: ParameterValue[] }

export interface ModelDiff {
  created: number[];
  modified: number[];
  deleted: number[];
  created_count: number;
  modified_count: number;
  deleted_count: number;
  parameters: Array<{ id: number; before: ParameterValue[] | null; after: ParameterValue[] | null }>;
  parameter_count: number;
  capped: boolean;
}

function nums(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
}

function rows(value: unknown): ParameterRow[] {
  if (!Array.isArray(value)) return [];
  const out: ParameterRow[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = Number(row.id);
    if (!Number.isFinite(id)) continue;
    const parameters = Array.isArray(row.parameters) ? row.parameters.flatMap((param) => {
      if (!param || typeof param !== "object") return [];
      const bag = param as Record<string, unknown>;
      return [{ name: text(bag.name), value: text(bag.value) }];
    }) : [];
    out.push({ id, parameters });
  }
  return out;
}

/** Created, modified and deleted ids, plus parameter before and after, each list capped. Counts keep the real size. */
export function shapeDiff(raw: Record<string, unknown> | null | undefined): ModelDiff {
  const createdAll = nums(raw?.createdIds ?? raw?.created_ids ?? raw?.created);
  const deletedAll = nums(raw?.deletedIds ?? raw?.deleted_ids ?? raw?.deleted);
  const modifiedAll = nums(raw?.modifiedIds ?? raw?.modified_ids ?? raw?.modified);
  const createdCount = Number(raw?.createdCount ?? raw?.created_count ?? createdAll.length);
  const deletedCount = Number(raw?.deletedCount ?? raw?.deleted_count ?? deletedAll.length);
  const modifiedCount = Number(raw?.modifiedCount ?? raw?.modified_count ?? modifiedAll.length);
  const before = new Map(rows(raw?.parameter_before ?? raw?.parameterBefore).map((row) => [row.id, row.parameters]));
  const after = new Map(rows(raw?.parameter_after ?? raw?.parameterAfter).map((row) => [row.id, row.parameters]));
  const ids = [...new Set([...before.keys(), ...after.keys()])];
  const capped = createdAll.length > DIFF_CAP || modifiedAll.length > DIFF_CAP || deletedAll.length > DIFF_CAP || ids.length > DIFF_CAP
    || createdCount > DIFF_CAP || modifiedCount > DIFF_CAP || deletedCount > DIFF_CAP;
  return {
    created: createdAll.slice(0, DIFF_CAP),
    modified: modifiedAll.slice(0, DIFF_CAP),
    deleted: deletedAll.slice(0, DIFF_CAP),
    created_count: Number.isFinite(createdCount) ? createdCount : createdAll.length,
    modified_count: Number.isFinite(modifiedCount) ? modifiedCount : modifiedAll.length,
    deleted_count: Number.isFinite(deletedCount) ? deletedCount : deletedAll.length,
    parameters: ids.slice(0, DIFF_CAP).map((id) => ({ id, before: before.get(id) ?? null, after: after.get(id) ?? null })),
    parameter_count: ids.length,
    capped,
  };
}

export function inputTooLarge(inputs: unknown): string | null {
  if (!inputs || typeof inputs !== "object") return null;
  const size = Array.isArray(inputs) ? inputs.length : Object.keys(inputs).length;
  if (size > INPUT_CAP) return `[FMC-SCRIPT-LIMIT] This call has ${size} inputs. The limit is ${INPUT_CAP}. Split it.`;
  return null;
}

function documentKey(name: string): string {
  const norm = name.trim().toLowerCase().replace(/\\/g, "/");
  const base = norm.split("/").pop() ?? norm;
  return base.replace(/\.(rvt|rfa|rte)$/i, "");
}

function looksLikePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/");
}

/**
 * These tools never save. If a path would be saved, HEBERT HOSTELS_USER is always refused,
 * and so is any path under protected_paths or protected_roots.
 */
export function refuseProtectedWrite(target: { title?: string; path?: string }, cfg: Pick<GuardConfig, "protected_paths" | "protected_roots">): string | null {
  const names = [target.title?.trim() ?? "", target.path?.trim() ?? ""].filter(Boolean);
  if (names.some((name) => documentKey(name) === "hebert hostels_user")) return "Refusing to save HEBERT HOSTELS_USER.";
  const prefixes = [...(cfg.protected_paths ?? []), ...protectedRoots(cfg as GuardConfig)];
  if (names.filter(looksLikePath).some((item) => underAny(item, prefixes))) return "Refusing to write under a protected path.";
  return null;
}

export function withResolved<T extends object>(body: T, doc: ResolvedDocument | null): T & { resolved_document: ResolvedDocument | null } {
  return { ...body, resolved_document: doc };
}

export function kitFor(cfg: GuardConfig, env: NodeJS.ProcessEnv, given = ""): string {
  return kitRootFrom(cfg, env, given);
}

/** Plain Python with no Revit API can run outside Revit. Revit API Python is not hosted here. */
export function pythonSupported(source: string): { ok: true } | { ok: false; code: "FMC-PYTHON-UNAVAILABLE"; message: string } {
  if (/\bAutodesk\.Revit\b|\bclr\.AddReference\b|\bRevitServices\b|\bDocumentManager\b/.test(source)) {
    return {
      ok: false,
      code: "FMC-PYTHON-UNAVAILABLE",
      message: "[FMC-PYTHON-UNAVAILABLE] This Python entry uses the Revit API. In-process Python is not hosted. Use runner csharp or dynamo.",
    };
  }
  return { ok: true };
}
