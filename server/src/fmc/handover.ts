/**
 * Handover package (L011-F24, build plan item 66, Manual Part 15.5): one zip per milestone with the model (optional),
 * the parameters, the reports and a manifest. COBie and IDS come later. The Revit read changes nothing; the only
 * write is the zip in an output folder the guard allows. The kit file 03_Master_Data/FMC_Handover.json names the
 * categories, parameters and required values; without it the sample is used, which is PROVISIONAL and cannot pass.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { csvLine, expandEnv, isInside, type GuardConfig } from "./policy.js";
import { ZIP_MAX_BYTES } from "./zipwrite.js";

const win = path.win32;

export const HANDOVER_FIX: Record<string, string> = {
  "FMC-DOC-REQUIRED": "fmc_handover needs document, a title or a full path. The active document is not a guess.",
  "FMC-HANDOVER-SPEC": "The handover spec is missing or is not JSON.",
  "FMC-HANDOVER-MILESTONE": "milestone is required: 1 to 24 letters, digits, - or _ (for example S4 or PC).",
  "FMC-HANDOVER-FOLDER": "The output folder is not allowed. Use a folder inside write_roots or reports_dir in fmc_guard.json, never 02_Shared, 03_Published, 04_Archive, 05_Incoming or a protected original.",
  "FMC-HANDOVER-PLAN": "plan_id does not match. The model, the files or the request changed since the dry run. Run the dry run again and apply its plan_id.",
  "FMC-HANDOVER-PLAN-REQUIRED": "A write needs plan_id from the dry run, so the zip is the package the person saw.",
  "FMC-HANDOVER-REPORT": "A report file is missing, is not a file, is too big, or is a model file.",
  "FMC-HANDOVER-MODEL-CLOUD": "The model is a cloud or Revit Server model, or is not saved. It is not copied into the zip.",
  "FMC-HANDOVER-MODEL-WORKSHARED": "A workshared model is not copied. The person detaches and saves a handover copy in Revit, opens it, and runs fmc_handover on that copy.",
  "FMC-HANDOVER-MODEL-GUARD": "HEBERT HOSTELS models are never copied by a tool.",
  "FMC-HANDOVER-MODEL-MISSING": "The model file was not found on disk.",
  "FMC-HANDOVER-MODEL-UNSAVED": "The model has unsaved changes: the zip holds the last saved file, not what is on screen. Save it in Revit first if that matters.",
  "FMC-HANDOVER-TRUNCATED": "More elements than max_elements: the parameters file is cut short and the package cannot pass.",
  "FMC-HANDOVER-CATEGORY": "A category name is not a Revit built-in category (OST_...).",
  "FMC-HANDOVER-NOTHING": "The read found no elements in the named categories. The package would hold no parameters.",
  "FMC-HANDOVER-EXISTS": "A zip with that name already exists. Nothing is overwritten.",
  "FMC-HANDOVER-TOO-BIG": "The package would pass 4 GB. The zip writer has no Zip64, so it is refused before anything is written. Leave the model out (include_model false) or split the report files across two packages.",
};

/** Shown on every PROVISIONAL result while no kit 03_Master_Data/FMC_Handover.json exists. */
export const PROVISIONAL_NOTE =
  "PROVISIONAL: no kit 03_Master_Data/FMC_Handover.json was found (or it is marked PROVISIONAL), so the sample categories, parameters and required values were used. The package cannot pass until the kit spec exists.";

/** Shown whenever include_model is asked for. */
export const MODEL_NOTE =
  "include_model copies the last saved .rvt on disk byte for byte. Changes not yet saved in Revit are not in the zip; the tool never saves the model.";

/** A safe upper estimate of the zip size: every entry's bytes, its two headers, its name twice, the end record and room for manifest.json. */
export function estimateZipBytes(files: Array<{ name: string; bytes: number }>, manifestAllowance = 1024 * 1024): number {
  let total = 22 + manifestAllowance;
  for (const f of files) total += f.bytes + 30 + 46 + 2 * Buffer.byteLength(f.name, "utf8");
  return total;
}

export interface HandoverSpec {
  status?: string;
  categories?: string[];
  parameters?: string[];
  required?: Record<string, string[]>;
  project_info?: string[];
  milestones?: string[];
}

export interface LoadedHandoverSpec {
  spec: HandoverSpec;
  path: string;
  source: "kit" | "sample" | "file";
  provisional: boolean;
}

export interface HandoverElement {
  id: string;
  unique_id?: string;
  category: string;
  category_name?: string;
  family?: string;
  type?: string;
  level?: string;
  values?: Record<string, string>;
  sources?: Record<string, string>;
}

export interface HandoverRead {
  title: string;
  path: string;
  is_family?: boolean;
  is_workshared?: boolean;
  is_central?: boolean;
  is_modified?: boolean;
  is_cloud?: boolean;
  revit_version?: string;
  project_info?: Array<{ name: string; value: string }>;
  counts?: Record<string, number>;
  unknown_categories?: string[];
  elements?: HandoverElement[];
  truncated?: boolean;
}

export interface Problem { code: string; message: string; detail?: string }

export interface CompletenessRow {
  category: string;
  parameter: string;
  required: boolean;
  elements: number;
  filled: number;
  missing: number;
  percent: number;
}

export interface PlannedFile {
  name: string;
  kind: "parameters" | "report" | "model" | "manifest";
  bytes: number;
  source?: string;
  data?: Buffer;
  sha256?: string;
}

export interface HandoverPlan {
  milestone: string;
  zip_name: string;
  files: PlannedFile[];
  completeness: CompletenessRow[];
  missing_required: number;
  elements: number;
  counts: Record<string, number>;
  warnings: Problem[];
  blockers: Problem[];
  model: { included: boolean; state: string; code?: string };
  estimated_zip_bytes: number;
  plan_id: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

function joinUnder(root: string, ...parts: string[]): string {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(root) || (root.includes("\\") && !root.includes("/"));
  return (windows ? path.win32 : path).join(root, ...parts);
}

export function sampleHandoverPaths(): string[] {
  return [path.resolve(here, "..", "..", "data", "FMC_Handover.json"), path.resolve(here, "..", "data", "FMC_Handover.json")];
}

export function loadHandoverSpec(opts: { file?: string; kitRoot?: string; env?: NodeJS.ProcessEnv; read?: (file: string) => string }): LoadedHandoverSpec {
  const read = opts.read ?? ((file) => fs.readFileSync(file, "utf8"));
  const named = (opts.file ?? opts.env?.FMC_HANDOVER_FILE ?? "").trim();
  const kit = (opts.kitRoot ?? "").replace(/[\\/]+$/, "");
  const candidates: Array<{ file: string; source: LoadedHandoverSpec["source"] }> = [];
  if (named) candidates.push({ file: named, source: "file" });
  if (kit) candidates.push({ file: joinUnder(kit, "03_Master_Data", "FMC_Handover.json"), source: "kit" });
  for (const file of sampleHandoverPaths()) candidates.push({ file, source: "sample" });
  for (const item of candidates) {
    let raw: string;
    try { raw = read(item.file); } catch { continue; }
    let spec: HandoverSpec;
    try { spec = JSON.parse(raw.replace(/^\uFEFF/, "")) as HandoverSpec; } catch { throw new Error(`[FMC-HANDOVER-SPEC] ${item.file} is not JSON.`); }
    if (!spec || typeof spec !== "object") throw new Error(`[FMC-HANDOVER-SPEC] ${item.file} is not a JSON object.`);
    const provisional = item.source !== "kit" || String(spec.status ?? "").toUpperCase() === "PROVISIONAL";
    return { spec, path: item.file, source: item.source, provisional };
  }
  throw new Error(`[FMC-HANDOVER-SPEC] ${HANDOVER_FIX["FMC-HANDOVER-SPEC"]}`);
}

export function cleanMilestone(raw: string): string | null {
  const m = raw.trim();
  return /^[A-Za-z0-9_-]{1,24}$/.test(m) ? m : null;
}

/** A file-name-safe short form of a document title. */
export function safeName(title: string): string {
  const base = title.replace(/\.(rvt|rfa)$/i, "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return (base || "model").slice(0, 80);
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function zipNameFor(title: string, milestone: string, now: Date): string {
  return `${safeName(title)}_${milestone}_Handover_${stamp(now)}.zip`;
}

function norm(p: string, env: NodeJS.ProcessEnv): string {
  return win.normalize(expandEnv(p, env)).replace(/[\\/]+$/, "");
}

/**
 * May the zip be written in this folder? Absolute; not in a CDE gate folder; not under a protected original; and inside
 * write_roots or reports_dir. The folder is not created here.
 */
export function checkOutputFolder(folder: string, cfg: GuardConfig, protectedList: string[], env: NodeJS.ProcessEnv = process.env): { ok: boolean; folder: string; reasons: string[] } {
  const reasons: string[] = [];
  const target = norm(folder, env);
  if (!folder.trim() || !win.isAbsolute(target) || /%[^%]+%/.test(target)) reasons.push(`Output folder must be an absolute path: ${folder || "(empty)"}`);
  const segs = target.toLowerCase().split("\\").filter(Boolean);
  const blocked = (cfg.blocked_segments ?? []).map((s) => s.toLowerCase()).filter((s) => segs.includes(s));
  if (blocked.length) reasons.push(`Writing into ${blocked.join(", ")} is a CDE gate with a named approver, not a tool action (Manual 7.5)`);
  if (segs.includes("04_families")) reasons.push("The kit family library is not an output folder");
  const prot = protectedList.filter((r) => r && isInside(target, norm(r, env)));
  if (prot.length) reasons.push(`Under a protected original: ${prot.join("; ")}`);
  const roots = [...(cfg.write_roots ?? []), ...(cfg.reports_dir ? [cfg.reports_dir] : [])].map((r) => norm(r, env)).filter(Boolean);
  if (!roots.some((r) => isInside(target, r))) reasons.push(`Not inside write_roots or reports_dir (${roots.join("; ") || "none configured"})`);
  return { ok: reasons.length === 0, folder: target, reasons };
}

export function defaultOutputFolder(cfg: GuardConfig, env: NodeJS.ProcessEnv): string {
  return win.join(norm(cfg.reports_dir || "%USERPROFILE%\\FMC_Reports", env), "Handover");
}

function requiredFor(spec: HandoverSpec, category: string): string[] {
  const req = spec.required ?? {};
  return [...new Set([...(req["*"] ?? []), ...(req[category] ?? [])])];
}

/** Per category and parameter: how many elements carry it and how many are filled. Required params count as missing when absent. */
export function completeness(elements: HandoverElement[], spec: HandoverSpec, parameters: string[]): CompletenessRow[] {
  const byCat = new Map<string, HandoverElement[]>();
  for (const e of elements) {
    const list = byCat.get(e.category) ?? [];
    list.push(e);
    byCat.set(e.category, list);
  }
  const rows: CompletenessRow[] = [];
  for (const [category, list] of [...byCat.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const required = requiredFor(spec, category);
    const names = [...new Set([...required, ...parameters])];
    for (const parameter of names) {
      const isRequired = required.includes(parameter);
      const carrying = list.filter((e) => e.values && Object.prototype.hasOwnProperty.call(e.values, parameter));
      const filled = carrying.filter((e) => String(e.values?.[parameter] ?? "").trim() !== "").length;
      const base = isRequired ? list.length : carrying.length;
      if (!isRequired && base === 0) continue;
      rows.push({
        category, parameter, required: isRequired, elements: base, filled, missing: base - filled,
        percent: base ? Math.round((filled / base) * 1000) / 10 : 100,
      });
    }
  }
  return rows;
}

export function elementsCsv(elements: HandoverElement[], parameters: string[]): Buffer {
  let out = "\uFEFF" + csvLine(["id", "unique_id", "category", "category_name", "family", "type", "level", ...parameters]);
  for (const e of elements) {
    out += csvLine([e.id, e.unique_id ?? "", e.category, e.category_name ?? "", e.family ?? "", e.type ?? "", e.level ?? "",
      ...parameters.map((p) => e.values?.[p] ?? "")]);
  }
  return Buffer.from(out, "utf8");
}

export function projectInfoCsv(info: Array<{ name: string; value: string }>): Buffer {
  let out = "\uFEFF" + csvLine(["parameter", "value"]);
  for (const row of info) out += csvLine([row.name, row.value]);
  return Buffer.from(out, "utf8");
}

export function completenessCsv(rows: CompletenessRow[]): Buffer {
  let out = "\uFEFF" + csvLine(["category", "parameter", "required", "elements", "filled", "missing", "percent"]);
  for (const r of rows) out += csvLine([r.category, r.parameter, r.required ? "yes" : "no", r.elements, r.filled, r.missing, r.percent]);
  return Buffer.from(out, "utf8");
}

const REPORT_MAX_BYTES = 200 * 1024 * 1024;
const MODEL_EXT = /\.(rvt|rfa|rte|rft|nwc|nwd)$/i;

function fileFacts(file: string): { bytes: number; mtime: number } | null {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? { bytes: st.size, mtime: st.mtimeMs } : null;
  } catch { return null; }
}

/** The package: what goes in the zip, the gaps, and a plan_id that changes when any of it changes. */
export function planHandover(read: HandoverRead, loaded: LoadedHandoverSpec, request: {
  milestone: string;
  categories?: string[];
  parameters?: string[];
  report_files?: string[];
  include_model: boolean;
  now: Date;
  /** Tests only: a smaller limit than 4 GB. */
  max_zip_bytes?: number;
}): HandoverPlan {
  const spec = loaded.spec;
  const warnings: Problem[] = [];
  const blockers: Problem[] = [];
  const parameters = request.parameters?.length ? request.parameters : (spec.parameters ?? []);
  const elements = Array.isArray(read.elements) ? read.elements : [];
  const counts = read.counts ?? {};
  for (const c of read.unknown_categories ?? []) warnings.push({ code: "FMC-HANDOVER-CATEGORY", message: HANDOVER_FIX["FMC-HANDOVER-CATEGORY"], detail: c });
  if (read.truncated) warnings.push({ code: "FMC-HANDOVER-TRUNCATED", message: HANDOVER_FIX["FMC-HANDOVER-TRUNCATED"] });
  if (!elements.length) warnings.push({ code: "FMC-HANDOVER-NOTHING", message: HANDOVER_FIX["FMC-HANDOVER-NOTHING"] });
  const rows = completeness(elements, spec, parameters);
  const missingRequired = rows.filter((r) => r.required).reduce((n, r) => n + r.missing, 0);
  const info = Array.isArray(read.project_info) ? read.project_info : [];
  for (const name of spec.project_info ?? []) {
    const hit = info.find((row) => row.name.toLowerCase() === name.toLowerCase());
    if (!hit || !String(hit.value ?? "").trim()) warnings.push({ code: "FMC-HANDOVER-PROJECT-INFO", message: "A project information value the kit asks for is empty.", detail: name });
  }
  const files: PlannedFile[] = [];
  const addData = (name: string, kind: PlannedFile["kind"], data: Buffer) => files.push({ name, kind, bytes: data.length, data, sha256: crypto.createHash("sha256").update(data).digest("hex") });
  addData("parameters/elements.csv", "parameters", elementsCsv(elements, parameters));
  addData("parameters/project_info.csv", "parameters", projectInfoCsv(info));
  addData("reports/parameter_completeness.csv", "report", completenessCsv(rows));
  const fingerprints: string[] = [];
  const used = new Set(files.map((f) => f.name.toLowerCase()));
  for (const raw of request.report_files ?? []) {
    const file = raw.trim();
    const facts = win.isAbsolute(file) ? fileFacts(file) : null;
    if (!facts || MODEL_EXT.test(file) || facts.bytes > REPORT_MAX_BYTES) {
      blockers.push({ code: "FMC-HANDOVER-REPORT", message: HANDOVER_FIX["FMC-HANDOVER-REPORT"], detail: file });
      continue;
    }
    let name = `reports/${win.basename(file)}`;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `reports/${win.parse(file).name}_${i}${win.extname(file)}`;
    used.add(name.toLowerCase());
    files.push({ name, kind: "report", bytes: facts.bytes, source: file });
    fingerprints.push(`${file}|${facts.bytes}|${facts.mtime}`);
  }
  const model: HandoverPlan["model"] = { included: false, state: "not requested" };
  if (request.include_model) {
    const blob = `${read.title} ${read.path}`;
    const facts = read.path ? fileFacts(read.path) : null;
    let code = "";
    if (/hebert hostels/i.test(blob)) code = "FMC-HANDOVER-MODEL-GUARD";
    else if (read.is_cloud || !read.path || !win.isAbsolute(read.path)) code = "FMC-HANDOVER-MODEL-CLOUD";
    else if (read.is_workshared || read.is_central) code = "FMC-HANDOVER-MODEL-WORKSHARED";
    else if (!facts) code = "FMC-HANDOVER-MODEL-MISSING";
    if (code) {
      blockers.push({ code, message: HANDOVER_FIX[code] });
      model.state = "refused";
      model.code = code;
    } else if (facts) {
      files.push({ name: `model/${win.basename(read.path)}`, kind: "model", bytes: facts.bytes, source: read.path });
      fingerprints.push(`${read.path}|${facts.bytes}|${facts.mtime}`);
      model.included = true;
      model.state = read.is_modified ? "last saved (unsaved changes are not in the zip)" : "saved";
      if (read.is_modified) warnings.push({ code: "FMC-HANDOVER-MODEL-UNSAVED", message: HANDOVER_FIX["FMC-HANDOVER-MODEL-UNSAVED"] });
    }
  }
  const estimate = estimateZipBytes(files);
  const limit = request.max_zip_bytes ?? ZIP_MAX_BYTES;
  if (estimate > limit) {
    const gb = (n: number) => (n / 1024 ** 3).toFixed(2);
    blockers.push({ code: "FMC-HANDOVER-TOO-BIG", message: HANDOVER_FIX["FMC-HANDOVER-TOO-BIG"], detail: `about ${gb(estimate)} GB planned, limit ${gb(limit)} GB` });
  }
  const zipName = zipNameFor(read.title, request.milestone, request.now);
  const planId = crypto.createHash("sha256").update(JSON.stringify({
    document: [read.title, read.path],
    milestone: request.milestone,
    spec: loaded.path,
    data: files.filter((f) => f.sha256).map((f) => [f.name, f.sha256]),
    files: fingerprints,
    include_model: request.include_model,
  })).digest("hex").slice(0, 16);
  return {
    milestone: request.milestone, zip_name: zipName, files, completeness: rows, missing_required: missingRequired,
    elements: elements.length, counts, warnings, blockers, model, estimated_zip_bytes: estimate, plan_id: planId,
  };
}

export type HandoverStatus = "PROVISIONAL" | "GAPS" | "READY";

export function handoverStatus(plan: HandoverPlan, provisional: boolean): HandoverStatus {
  if (provisional) return "PROVISIONAL";
  if (plan.missing_required > 0 || plan.warnings.some((w) => w.code === "FMC-HANDOVER-TRUNCATED" || w.code === "FMC-HANDOVER-NOTHING")) return "GAPS";
  return "READY";
}

export function manifestFor(args: {
  plan: HandoverPlan;
  read: HandoverRead;
  loaded: LoadedHandoverSpec;
  status: HandoverStatus;
  build: string;
  now: Date;
  entries: Array<{ name: string; bytes: number; sha256: string; kind: string }>;
}): Buffer {
  const { plan, read, loaded } = args;
  const body = {
    schema: "fmc.handover/1",
    tool: "fmc_handover",
    build: args.build,
    created_at: args.now.toISOString(),
    milestone: plan.milestone,
    status: args.status,
    can_pass: args.status === "READY",
    note: "Nothing here is marked passed: only a person does that. Aligned with ISO 19650 information delivery; not a certification.",
    document: {
      title: read.title, path: read.path, revit_version: read.revit_version ?? "", is_workshared: read.is_workshared === true,
      is_modified: read.is_modified === true, model_included: plan.model.included, model_state: plan.model.state,
      ...(plan.model.included ? { model_note: MODEL_NOTE } : {}),
    },
    spec: { path: loaded.path, source: loaded.source, provisional: loaded.provisional, ...(loaded.provisional ? { note: PROVISIONAL_NOTE } : {}) },
    counts: plan.counts,
    elements: plan.elements,
    missing_required: plan.missing_required,
    warnings: plan.warnings,
    files: args.entries,
    later: {
      cobie: "Not included. COBie 2.4 comes later (L011-F24).",
      ids: "Not included. The IDS check (FMC_Handover_Base.ids, a kit checker) comes later.",
    },
    plan_id: plan.plan_id,
  };
  return Buffer.from(JSON.stringify(body, null, 2), "utf8");
}
