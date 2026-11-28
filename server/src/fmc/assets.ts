/**
 * Asset register (gap-analysis proposal 20): a COBie-style register built from one read of the model. Five sheets,
 * Facility, Space, Type, Component and System, with COBie 2.4 column names where they fit. It is a register, not a
 * certified COBie deliverable. Read-only: fmc_assets_read has no transaction, and no file is written. The sheets come
 * back inline, as rows or as CSV text. The kit file 03_Master_Data/FMC_Assets.json would name the categories and the
 * required values; it does not exist yet, so the built-in sample is used and the register is PROVISIONAL.
 */
import fs from "node:fs";
import path from "node:path";
import { csvLine } from "./policy.js";

export const ASSETS_FIX: Record<string, string> = {
  "FMC-DOC-REQUIRED": "fmc_assets needs document, a title or a full path. The active document is not a guess.",
  "FMC-ASSETS-SPEC": "The asset register spec is missing or is not JSON.",
  "FMC-ASSETS-SHEET": "sheets may name only Facility, Space, Type, Component and System.",
  "FMC-ASSETS-TRUNCATED": "More components than max_elements: the Component sheet is cut short and the register cannot be READY.",
  "FMC-ASSETS-CATEGORY": "A category name is not a Revit built-in category (OST_...).",
  "FMC-ASSETS-NO-SPACE": "A component is in no room or space (Revit's last phase). COBie needs a Space for every Component.",
  "FMC-ASSETS-TYPE-VALUE": "A type has no value for a field the spec requires (for example Manufacturer or ModelNumber).",
  "FMC-ASSETS-COMPONENT-VALUE": "A component has no value for a field the spec requires (for example TagNumber).",
  "FMC-ASSETS-DUPLICATE-NAME": "Two components share a Name. COBie names must be unique per sheet.",
  "FMC-ASSETS-SPACE-UNPLACED": "A room or space is not placed (no location, zero area).",
  "FMC-ASSETS-NOTHING": "The read found no components in the named categories.",
  "FMC-ASSETS-FAMILY": "The document is a family. The asset register reads projects only.",
};

export const SHEETS = ["Facility", "Space", "Type", "Component", "System"] as const;
export type SheetName = typeof SHEETS[number];

export interface AssetsSpec {
  status?: string;
  categories?: string[];
  /** Type fields that must not be empty: Manufacturer, ModelNumber, Description, AssemblyCode, OmniClass, TypeMark. */
  required_type_fields?: string[];
  /** Component fields that must not be empty: TagNumber, SerialNumber, InstallationDate, Space. */
  required_component_fields?: string[];
  /** Revit parameter names read for the Component SerialNumber, InstallationDate, WarrantyStartDate and BarCode columns. */
  component_parameters?: Record<string, string>;
  /** Extra Revit type parameter names read for WarrantyDurationParts and ExpectedLife. */
  type_parameters?: Record<string, string>;
}

export const SAMPLE_ASSETS_SPEC: AssetsSpec = {
  status: "PROVISIONAL",
  categories: [
    "OST_MechanicalEquipment", "OST_ElectricalEquipment", "OST_PlumbingFixtures", "OST_LightingFixtures", "OST_ElectricalFixtures",
    "OST_DuctTerminal", "OST_Sprinklers", "OST_FireAlarmDevices", "OST_SpecialityEquipment", "OST_Doors", "OST_Windows", "OST_Furniture",
  ],
  required_type_fields: ["Manufacturer", "ModelNumber"],
  required_component_fields: ["Space"],
  component_parameters: { SerialNumber: "Serial Number", InstallationDate: "Installation Date", WarrantyStartDate: "Warranty Start Date", BarCode: "Bar Code" },
  type_parameters: { WarrantyDurationParts: "Warranty Duration", ExpectedLife: "Expected Life" },
};

export interface LoadedAssetsSpec {
  spec: AssetsSpec;
  path: string;
  source: "kit" | "file" | "sample";
  provisional: boolean;
}

export const ASSETS_PROVISIONAL_NOTE =
  "PROVISIONAL: no kit 03_Master_Data/FMC_Assets.json was found (or it is marked PROVISIONAL), so the built-in sample categories and required fields were used. The register cannot be READY until the kit spec exists.";

function joinUnder(root: string, ...parts: string[]): string {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(root) || (root.includes("\\") && !root.includes("/"));
  return (windows ? path.win32 : path).join(root, ...parts);
}

export function loadAssetsSpec(opts: { file?: string; kitRoot?: string; env?: NodeJS.ProcessEnv; read?: (file: string) => string }): LoadedAssetsSpec {
  const read = opts.read ?? ((file) => fs.readFileSync(file, "utf8"));
  const named = (opts.file ?? opts.env?.FMC_ASSETS_FILE ?? "").trim();
  const kit = (opts.kitRoot ?? "").replace(/[\\/]+$/, "");
  const candidates: Array<{ file: string; source: "kit" | "file" }> = [];
  if (named) candidates.push({ file: named, source: "file" });
  if (kit) candidates.push({ file: joinUnder(kit, "03_Master_Data", "FMC_Assets.json"), source: "kit" });
  for (const item of candidates) {
    let raw: string;
    try { raw = read(item.file); } catch {
      if (item.source === "file") throw new Error(`[FMC-ASSETS-SPEC] ${item.file} could not be read.`);
      continue;
    }
    let spec: AssetsSpec;
    try { spec = JSON.parse(raw.replace(/^\uFEFF/, "")) as AssetsSpec; } catch { throw new Error(`[FMC-ASSETS-SPEC] ${item.file} is not JSON.`); }
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error(`[FMC-ASSETS-SPEC] ${item.file} is not a JSON object.`);
    const merged: AssetsSpec = { ...SAMPLE_ASSETS_SPEC, ...spec };
    const provisional = item.source !== "kit" || String(spec.status ?? "").toUpperCase() === "PROVISIONAL";
    return { spec: merged, path: item.file, source: item.source, provisional };
  }
  return { spec: SAMPLE_ASSETS_SPEC, path: "(built-in sample)", source: "sample", provisional: true };
}

export interface AssetsRead {
  title: string;
  path: string;
  is_family?: boolean;
  facility?: Record<string, string>;
  spaces?: Array<{ id: string; unique_id?: string; kind?: string; number?: string; name?: string; level?: string; area_m2?: number; placed?: boolean; department?: string }>;
  types?: Array<{ id: string; unique_id?: string; category?: string; family?: string; type?: string; manufacturer?: string; model?: string; description?: string; type_mark?: string; assembly_code?: string; omniclass?: string; values?: Record<string, string>; count?: number }>;
  components?: Array<{ id: string; unique_id?: string; category?: string; category_name?: string; type_id?: string; family?: string; type?: string; level?: string; mark?: string; space?: string; values?: Record<string, string> }>;
  systems?: Array<{ id: string; unique_id?: string; name?: string; classification?: string; system_type?: string; element_ids?: string[] }>;
  unknown_categories?: string[];
  truncated?: boolean;
}

export type Row = Record<string, string | number>;

export interface Problem { code: string; message: string; sheet?: SheetName; detail?: string }

export interface Register {
  sheets: Record<SheetName, Row[]>;
  columns: Record<SheetName, string[]>;
  counts: Record<SheetName, number>;
  gaps: Problem[];
  gap_counts: Record<string, number>;
  warnings: Problem[];
}

export const COLUMNS: Record<SheetName, string[]> = {
  Facility: ["Name", "ProjectName", "SiteName", "Category", "LinearUnits", "AreaUnits", "Description", "ExtSystem", "ExtObject", "ExtIdentifier"],
  Space: ["Name", "Category", "FloorName", "Description", "GrossArea", "Department", "ExtSystem", "ExtObject", "ExtIdentifier"],
  Type: ["Name", "Category", "Description", "AssetType", "Manufacturer", "ModelNumber", "WarrantyDurationParts", "ExpectedLife", "AssemblyCode", "OmniClass", "TypeMark", "Count", "ExtSystem", "ExtObject", "ExtIdentifier"],
  Component: ["Name", "TypeName", "Space", "Description", "SerialNumber", "InstallationDate", "WarrantyStartDate", "TagNumber", "BarCode", "FloorName", "ExtSystem", "ExtObject", "ExtIdentifier"],
  System: ["Name", "Category", "ComponentNames", "Description", "ExtSystem", "ExtObject", "ExtIdentifier"],
};

const EXT = "Formcraft fmc_assets";
const s = (v: unknown) => (v == null ? "" : String(v)).trim();

/** The Type sheet name: "Family: Type", as Revit schedules show it. */
export function typeName(family: string, type: string): string {
  const f = s(family);
  const t = s(type);
  return f && t ? `${f}: ${t}` : f || t || "(no type)";
}

/** The Component sheet name: the Mark when there is one, else "Type Name-element id", so names stay unique. */
export function componentName(c: { id: string; mark?: string; family?: string; type?: string }): string {
  return s(c.mark) || `${typeName(s(c.family), s(c.type))}-${s(c.id)}`;
}

export function buildRegister(read: AssetsRead, spec: AssetsSpec): Register {
  const gaps: Problem[] = [];
  const warnings: Problem[] = [];
  const gap = (code: string, sheet: SheetName, detail: string) => gaps.push({ code, message: ASSETS_FIX[code], sheet, detail });
  for (const c of read.unknown_categories ?? []) warnings.push({ code: "FMC-ASSETS-CATEGORY", message: ASSETS_FIX["FMC-ASSETS-CATEGORY"], detail: c });
  if (read.truncated) warnings.push({ code: "FMC-ASSETS-TRUNCATED", message: ASSETS_FIX["FMC-ASSETS-TRUNCATED"] });
  const fac = read.facility ?? {};
  const facilityName = s(fac.building_name) || s(fac.project_name) || s(read.title);
  const facility: Row[] = [{
    Name: facilityName, ProjectName: s(fac.project_name), SiteName: s(fac.site_name), Category: s(fac.status), LinearUnits: "millimeters", AreaUnits: "squaremeters",
    Description: [s(fac.project_number), s(fac.client_name), s(fac.address)].filter(Boolean).join(" | "), ExtSystem: EXT, ExtObject: "ProjectInformation", ExtIdentifier: s(fac.unique_id),
  }];
  const spaces: Row[] = [];
  for (const sp of read.spaces ?? []) {
    if (sp.placed === false || !(Number(sp.area_m2) > 0)) { warnings.push({ code: "FMC-ASSETS-SPACE-UNPLACED", message: ASSETS_FIX["FMC-ASSETS-SPACE-UNPLACED"], sheet: "Space", detail: `${s(sp.number)} ${s(sp.name)}`.trim() }); continue; }
    spaces.push({
      Name: s(sp.number) || s(sp.name), Category: sp.kind === "space" ? "MEP Space" : "Room", FloorName: s(sp.level), Description: s(sp.name),
      GrossArea: Math.round(Number(sp.area_m2) * 100) / 100, Department: s(sp.department), ExtSystem: EXT, ExtObject: sp.kind === "space" ? "OST_MEPSpaces" : "OST_Rooms", ExtIdentifier: s(sp.unique_id),
    });
  }
  const tp = spec.type_parameters ?? {};
  const typeById = new Map<string, string>();
  const types: Row[] = [];
  const reqType = spec.required_type_fields ?? [];
  for (const t of read.types ?? []) {
    const name = typeName(s(t.family), s(t.type));
    typeById.set(s(t.id), name);
    const row: Row = {
      Name: name, Category: s(t.omniclass) || s(t.category), Description: s(t.description), AssetType: "Fixed", Manufacturer: s(t.manufacturer), ModelNumber: s(t.model),
      WarrantyDurationParts: s(t.values?.[tp.WarrantyDurationParts ?? ""]), ExpectedLife: s(t.values?.[tp.ExpectedLife ?? ""]), AssemblyCode: s(t.assembly_code), OmniClass: s(t.omniclass),
      TypeMark: s(t.type_mark), Count: Number(t.count ?? 0), ExtSystem: EXT, ExtObject: s(t.category), ExtIdentifier: s(t.unique_id),
    };
    for (const f of reqType) if (!s(row[f])) gap("FMC-ASSETS-TYPE-VALUE", "Type", `${name}: ${f}`);
    types.push(row);
  }
  const cp = spec.component_parameters ?? {};
  const components: Row[] = [];
  const nameById = new Map<string, string>();
  const seen = new Map<string, number>();
  const reqComp = spec.required_component_fields ?? [];
  const comps = read.components ?? [];
  if (!comps.length) warnings.push({ code: "FMC-ASSETS-NOTHING", message: ASSETS_FIX["FMC-ASSETS-NOTHING"] });
  for (const c of comps) {
    const name = componentName(c);
    nameById.set(s(c.id), name);
    seen.set(name.toLowerCase(), (seen.get(name.toLowerCase()) ?? 0) + 1);
    const v = c.values ?? {};
    const row: Row = {
      Name: name, TypeName: typeById.get(s(c.type_id)) ?? typeName(s(c.family), s(c.type)), Space: s(c.space), Description: s(c.category_name),
      SerialNumber: s(v[cp.SerialNumber ?? ""]), InstallationDate: s(v[cp.InstallationDate ?? ""]), WarrantyStartDate: s(v[cp.WarrantyStartDate ?? ""]),
      TagNumber: s(c.mark), BarCode: s(v[cp.BarCode ?? ""]), FloorName: s(c.level), ExtSystem: EXT, ExtObject: s(c.category), ExtIdentifier: s(c.unique_id),
    };
    if (!s(row.Space)) gap("FMC-ASSETS-NO-SPACE", "Component", name);
    for (const f of reqComp) if (f !== "Space" && !s(row[f])) gap("FMC-ASSETS-COMPONENT-VALUE", "Component", `${name}: ${f}`);
    components.push(row);
  }
  for (const [name, n] of seen) if (n > 1) gap("FMC-ASSETS-DUPLICATE-NAME", "Component", `${components.find((r) => String(r.Name).toLowerCase() === name)?.Name} x${n}`);
  const systems: Row[] = [];
  for (const sy of read.systems ?? []) {
    const members = (sy.element_ids ?? []).map((id) => nameById.get(s(id))).filter((n): n is string => !!n);
    systems.push({
      Name: s(sy.name), Category: s(sy.classification), ComponentNames: [...new Set(members)].join(","), Description: s(sy.system_type),
      ExtSystem: EXT, ExtObject: "MEPSystem", ExtIdentifier: s(sy.unique_id),
    });
  }
  const sheets = { Facility: facility, Space: spaces, Type: types, Component: components, System: systems };
  const counts = Object.fromEntries(SHEETS.map((k) => [k, sheets[k].length])) as Record<SheetName, number>;
  const gap_counts: Record<string, number> = {};
  for (const g of gaps) gap_counts[g.code] = (gap_counts[g.code] ?? 0) + 1;
  return { sheets, columns: COLUMNS, counts, gaps, gap_counts, warnings };
}

export type AssetsStatus = "PROVISIONAL" | "GAPS" | "READY";

/** READY only on a kit spec with no gaps and a full read. Nothing here is ever PASS: a person accepts the register. */
export function assetsStatus(reg: Register, provisional: boolean): AssetsStatus {
  if (provisional) return "PROVISIONAL";
  if (reg.gaps.length || reg.warnings.some((w) => w.code === "FMC-ASSETS-TRUNCATED" || w.code === "FMC-ASSETS-NOTHING")) return "GAPS";
  return "READY";
}

export function sheetCsv(reg: Register, sheet: SheetName, rows: Row[] = reg.sheets[sheet]): string {
  const cols = reg.columns[sheet];
  let out = csvLine(cols);
  for (const r of rows) out += csvLine(cols.map((c) => r[c] ?? ""));
  return out;
}
