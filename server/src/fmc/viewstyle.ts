/**
 * View templates, parameter filters and room colour fills from a kit spec.
 * The sample under server/data is PROVISIONAL. A kit file replaces it.
 * A provisional colour cannot PASS.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VIEWSTYLE_FIX: Record<string, string> = {
  "FMC-DOC-REQUIRED": "fmc_viewstyle needs document, a title or a full path. The active document is not a guess.",
  "FMC-BATCH-LOCKED": "A write needs batch_lease from fmc_batch request.",
  "FMC-VIEWSTYLE-REFERENCES": "A write needs references.kit, references.standards and references.rulebook.",
  "FMC-VIEWSTYLE-SPEC": "The view style spec is missing or is not JSON.",
  "FMC-VIEWSTYLE-NAME-TAKEN": "A view template or filter with this name already exists. It is not replaced.",
  "FMC-VIEWSTYLE-NO-VIEW": "A template needs from_view, a view to turn into the template.",
  "FMC-VIEWSTYLE-FILTER": "A filter needs categories, one rule and a colour.",
  "FMC-VIEWSTYLE-SCHEME-PARAM": "ColorFillScheme.ParameterDefinition rejected Department or Name (IsValidParameterDefinitionId is false, or the setter threw). Entries were not written.",
  "FMC-VIEWSTYLE-NO-SCHEME": "Revit 2025 has no ColorFillScheme.Create. Duplicate needs an existing Rooms colour scheme in the model. Make one Rooms scheme by hand, then run this again.",
  "FMC-VIEWSTYLE-ACTION": "action is templates, filters or room_fill.",
};

export type ViewStyleAction = "templates" | "filters" | "room_fill";

export interface Rgb {
  color: [number, number, number];
  status: string;
  provisional: boolean;
}

export interface TemplateSpec {
  name: string;
  from_view?: string;
  scale?: number;
  detail_level?: string;
  discipline?: string;
  apply_to?: string[];
  status?: string;
}

export interface FilterRuleSpec {
  parameter: string;
  evaluator: string;
  value: string;
}

export interface FilterSpec {
  name: string;
  categories: string[];
  rules: FilterRuleSpec[];
  color: [number, number, number];
  apply_to?: string[];
  status?: string;
}

export interface RoomEntrySpec {
  value: string;
  color: [number, number, number];
  status?: string;
}

export interface RoomFillSpec {
  by: "Department" | "Name";
  legend?: boolean;
  view?: string;
  entries?: RoomEntrySpec[];
  status?: string;
}

export interface ViewStyleSpec {
  version?: string;
  status?: string;
  note?: string;
  templates?: TemplateSpec[];
  filters?: FilterSpec[];
  room_fill?: RoomFillSpec;
}

export interface LoadedSpec {
  spec: ViewStyleSpec;
  path: string;
  source: "kit" | "sample" | "file";
  provisional: boolean;
}

const here = path.dirname(fileURLToPath(import.meta.url));

function joinUnder(root: string, ...parts: string[]): string {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(root) || (root.includes("\\") && !root.includes("/"));
  return (windows ? path.win32 : path).join(root, ...parts);
}

export function sampleSpecPaths(): string[] {
  return [
    path.resolve(here, "..", "..", "data", "FMC_ViewStyle.json"),
    path.resolve(here, "..", "data", "FMC_ViewStyle.json"),
  ];
}

function provisionalText(value: unknown): boolean {
  return typeof value === "string" && value.toUpperCase() === "PROVISIONAL";
}

export function specIsProvisional(spec: ViewStyleSpec): boolean {
  if (provisionalText(spec.status)) return true;
  for (const row of spec.templates ?? []) if (provisionalText(row.status)) return true;
  for (const row of spec.filters ?? []) if (provisionalText(row.status)) return true;
  if (provisionalText(spec.room_fill?.status)) return true;
  for (const row of spec.room_fill?.entries ?? []) if (provisionalText(row.status)) return true;
  return false;
}

export function parseViewStyle(raw: string): ViewStyleSpec {
  const body = JSON.parse(raw.replace(/^\uFEFF/, "")) as ViewStyleSpec;
  if (!body || typeof body !== "object") throw new Error(VIEWSTYLE_FIX["FMC-VIEWSTYLE-SPEC"]);
  return body;
}

export function loadViewStyleSpec(opts: {
  file?: string;
  kitRoot?: string;
  env?: NodeJS.ProcessEnv;
  read?: (file: string) => string;
}): LoadedSpec {
  const read = opts.read ?? ((file) => fs.readFileSync(file, "utf8"));
  const exists = (file: string) => {
    try { read(file); return true; } catch { return false; }
  };
  const named = (opts.file ?? opts.env?.FMC_VIEWSTYLE_FILE ?? "").trim();
  const kit = (opts.kitRoot ?? "").replace(/[\\/]+$/, "");
  const kitFile = kit ? joinUnder(kit, "03_Master_Data", "FMC_ViewStyle.json") : "";
  const candidates: Array<{ file: string; source: LoadedSpec["source"] }> = [];
  if (named) candidates.push({ file: named, source: "file" });
  if (kitFile) candidates.push({ file: kitFile, source: "kit" });
  for (const file of sampleSpecPaths()) candidates.push({ file, source: "sample" });
  for (const item of candidates) {
    if (!exists(item.file)) continue;
    const spec = parseViewStyle(read(item.file));
    const provisional = item.source !== "kit" || specIsProvisional(spec);
    return { spec, path: item.file, source: item.source, provisional };
  }
  throw new Error(VIEWSTYLE_FIX["FMC-VIEWSTYLE-SPEC"]);
}

function rgb(color: number[] | undefined, status: string | undefined): Rgb {
  const c = color ?? [0, 0, 0];
  const marked = provisionalText(status);
  return {
    color: [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0],
    status: marked ? "PROVISIONAL" : (status ?? ""),
    provisional: marked,
  };
}

export function planTemplates(spec: ViewStyleSpec, existing: string[]): { ops: Array<Record<string, unknown>>; skipped: Array<Record<string, unknown>>; provisional: boolean } {
  const have = new Set(existing.map((name) => name.toLowerCase()));
  const ops: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  let provisional = specIsProvisional(spec);
  for (const row of spec.templates ?? []) {
    if (provisionalText(row.status)) provisional = true;
    if (!row.name?.trim()) {
      skipped.push({ code: "FMC-VIEWSTYLE-NO-VIEW", reason: "A template needs a name." });
      continue;
    }
    if (have.has(row.name.toLowerCase())) {
      skipped.push({ name: row.name, code: "FMC-VIEWSTYLE-NAME-TAKEN", reason: VIEWSTYLE_FIX["FMC-VIEWSTYLE-NAME-TAKEN"] });
      continue;
    }
    if (!row.from_view?.trim()) {
      skipped.push({ name: row.name, code: "FMC-VIEWSTYLE-NO-VIEW", reason: VIEWSTYLE_FIX["FMC-VIEWSTYLE-NO-VIEW"] });
      continue;
    }
    ops.push({
      name: row.name,
      from_view: row.from_view,
      scale: row.scale ?? null,
      detail_level: row.detail_level ?? "",
      discipline: row.discipline ?? "",
      apply_to: row.apply_to ?? [],
      status: row.status ?? spec.status ?? "",
      provisional: provisionalText(row.status) || provisionalText(spec.status),
    });
  }
  return { ops, skipped, provisional };
}

export function planFilters(spec: ViewStyleSpec, existing: string[]): { ops: Array<Record<string, unknown>>; skipped: Array<Record<string, unknown>>; provisional: boolean } {
  const have = new Set(existing.map((name) => name.toLowerCase()));
  const ops: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  let provisional = specIsProvisional(spec);
  for (const row of spec.filters ?? []) {
    if (provisionalText(row.status)) provisional = true;
    if (!row.name?.trim() || !row.categories?.length || !row.rules?.length || !row.color || row.color.length < 3) {
      skipped.push({ name: row.name ?? "", code: "FMC-VIEWSTYLE-FILTER", reason: VIEWSTYLE_FIX["FMC-VIEWSTYLE-FILTER"] });
      continue;
    }
    if (have.has(row.name.toLowerCase())) {
      skipped.push({ name: row.name, code: "FMC-VIEWSTYLE-NAME-TAKEN", reason: VIEWSTYLE_FIX["FMC-VIEWSTYLE-NAME-TAKEN"] });
      continue;
    }
    const colour = rgb(row.color, row.status ?? spec.status);
    ops.push({
      name: row.name,
      categories: row.categories,
      rules: row.rules.map((rule) => ({ parameter: rule.parameter, evaluator: (rule.evaluator || "equals").toLowerCase(), value: String(rule.value ?? "") })),
      color: colour.color,
      apply_to: row.apply_to ?? [],
      status: colour.status,
      provisional: colour.provisional,
    });
  }
  return { ops, skipped, provisional };
}

export function planRoomFill(spec: ViewStyleSpec, rooms: Array<{ department?: string; name?: string }> = []): { op: Record<string, unknown> | null; skipped: Array<Record<string, unknown>>; provisional: boolean } {
  const fill = spec.room_fill;
  if (!fill) return { op: null, skipped: [{ code: "FMC-VIEWSTYLE-FILTER", reason: "The spec has no room_fill." }], provisional: specIsProvisional(spec) };
  const by = fill.by === "Name" ? "Name" : fill.by === "Department" ? "Department" : "";
  if (!by) return { op: null, skipped: [{ code: "FMC-VIEWSTYLE-FILTER", reason: "room_fill.by is Department or Name." }], provisional: true };
  const listed = fill.entries ?? [];
  const fromRooms = rooms.map((room) => (by === "Department" ? room.department : room.name) ?? "").map((value) => value.trim()).filter(Boolean);
  const values = listed.length ? listed.map((row) => row.value) : [...new Set(fromRooms)];
  const entries = values.map((value) => {
    const row = listed.find((item) => item.value === value);
    const colour = rgb(row?.color ?? [200, 200, 200], row?.status ?? fill.status ?? spec.status);
    return { value, color: colour.color, status: colour.status || "PROVISIONAL", provisional: colour.provisional || !row };
  });
  const provisional = specIsProvisional(spec) || provisionalText(fill.status) || entries.some((row) => row.provisional);
  return {
    op: {
      by,
      legend: fill.legend !== false,
      view: fill.view ?? "",
      entries,
      status: provisional ? "PROVISIONAL" : (fill.status ?? ""),
      provisional,
      route: "duplicate",
      scheme_name: `FMC Rooms by ${by}`,
      parameter: by === "Name" ? "ROOM_NAME" : "ROOM_DEPARTMENT",
      parameter_note: "Revit 2025 has no ColorFillScheme.Create. Apply duplicates an existing Rooms scheme (ColorFillScheme.Duplicate), sets ParameterDefinition to ROOM_NAME or ROOM_DEPARTMENT, adds one ColorFillSchemeEntry per value, assigns the scheme with SetColorFillSchemeId, and places ColorFillLegend.Create. A model with no Rooms scheme is FMC-VIEWSTYLE-NO-SCHEME. A parameter the scheme rejects is FMC-VIEWSTYLE-SCHEME-PARAM.",
    },
    skipped: [],
    provisional,
  };
}

export function referenceProblems(refs: { kit?: string[]; standards?: string[]; rulebook?: string[] } | undefined): string | null {
  if (!refs) return VIEWSTYLE_FIX["FMC-VIEWSTYLE-REFERENCES"];
  for (const key of ["kit", "standards", "rulebook"] as const) {
    const list = refs[key];
    if (!Array.isArray(list) || !list.some((item) => String(item).trim())) return VIEWSTYLE_FIX["FMC-VIEWSTYLE-REFERENCES"];
  }
  return null;
}

export function viewStyleDir(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.FMC_VIEWSTYLE_DIR ?? "").trim()) return env.FMC_VIEWSTYLE_DIR!.trim();
  const local = env.LOCALAPPDATA || path.join(os.tmpdir(), "FormcraftLocal");
  return path.join(local, "Formcraft", "viewstyle");
}

export function writeViewStyleReport(env: NodeJS.ProcessEnv, action: string, body: unknown, dir = viewStyleDir(env)): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `viewstyle-${action}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}
