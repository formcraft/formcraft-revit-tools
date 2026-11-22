/**
 * Parameters and labels on a family already loaded in the project.
 * Shared definitions come only from the kit shared parameter file. A missing name is a kit change.
 * The family file on disk is never saved.
 */
import fs from "node:fs";
import path from "node:path";
import { parseSharedParameters, type SpParam } from "./specs.js";

export const PARAM_TYPES = ["text", "number", "integer", "yesno", "material", "angle", "area", "volume", "length"] as const;
export type ParamTypeName = typeof PARAM_TYPES[number];

const DATA_TYPE_TO_NAME: Record<string, ParamTypeName> = {
  TEXT: "text",
  MULTILINETEXT: "text",
  NUMBER: "number",
  INTEGER: "integer",
  YESNO: "yesno",
  MATERIAL: "material",
  ANGLE: "angle",
  AREA: "area",
  VOLUME: "volume",
  LENGTH: "length",
};

export interface ParamPlan {
  action: "add" | "label" | "bind";
  family: string;
  name: string;
  type: string;
  group: string;
  shared: boolean;
  binding: "instance" | "type";
  guid: string;
  datatype: string;
  categories: string[];
  origin_mm: number[];
  kit_file: string;
}

export function loadSharedMap(file: string): Map<string, SpParam> | null {
  if (!file || !fs.existsSync(file)) return null;
  try { return parseSharedParameters(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

export function typeNameOf(datatype: string): ParamTypeName | "" {
  return DATA_TYPE_TO_NAME[datatype.trim().toUpperCase()] ?? "";
}

export function normalType(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]/g, "");
}

export function isKitOriginal(filePath: string): boolean {
  const norm = filePath.replace(/\//g, "\\");
  if (/\\_Staging\\/i.test(norm) || /\\_ChainTests\\/i.test(norm)) return false;
  if (/\.rfa$/i.test(norm) && /\\(00_Standards|04_Families)\\/i.test(norm)) return true;
  if (/\\04_Families\\/i.test(norm)) return true;
  return false;
}

export function referenceProblems(refs: { kit?: string[]; standards?: string[]; rulebook?: string[] } | undefined): string | null {
  if (!refs) return "[FMC-PARAM-REFERENCES] A write needs references.kit, references.standards and references.rulebook.";
  for (const key of ["kit", "standards", "rulebook"] as const) {
    const list = refs[key];
    if (!Array.isArray(list) || !list.some((item) => String(item).trim())) {
      return "[FMC-PARAM-REFERENCES] A write needs references.kit, references.standards and references.rulebook.";
    }
  }
  return null;
}

export interface PlanResult {
  ok: boolean;
  code: string;
  message: string;
  plan?: ParamPlan;
}

export function planFamilyParam(input: {
  action: "add" | "label" | "bind";
  family?: string;
  name?: string;
  type?: string;
  group?: string;
  shared?: boolean;
  binding?: "instance" | "type";
  categories?: string[];
  origin_mm?: number[];
  kitFile: string;
  dictionary: Map<string, SpParam> | null;
  existing?: string[];
}): PlanResult {
  const name = (input.name ?? "").trim();
  const family = (input.family ?? "").trim();
  const shared = input.shared !== false;
  const binding = input.binding === "type" ? "type" : "instance";
  const group = (input.group ?? "").trim() || "identity";
  const type = normalType(input.type ?? "");
  if (!name) return { ok: false, code: "FMC-PARAM-NAME", message: "[FMC-PARAM-NAME] The parameter name is required." };
  if ((input.action === "add" || input.action === "label") && !family) {
    return { ok: false, code: "FMC-FAMILY-NAME", message: "[FMC-FAMILY-NAME] Name the loaded family or titleblock. The kit file is not opened." };
  }
  if (input.action === "bind" && !(input.categories ?? []).some((item) => item.trim())) {
    return { ok: false, code: "FMC-PARAM-CATEGORY", message: "[FMC-PARAM-CATEGORY] bind needs categories, for example OST_Sheets." };
  }
  if (input.action === "bind" && !shared) {
    return { ok: false, code: "FMC-PARAM-SHARED", message: "[FMC-PARAM-SHARED] A project parameter is bound from the kit shared parameter file. shared:false is a family parameter, which is the add action." };
  }
  let guid = "";
  let datatype = "";
  if (shared) {
    if (!input.dictionary) {
      return {
        ok: false, code: "FMC-PARAM-FILE",
        message: `[FMC-PARAM-FILE] The kit shared parameter file is not readable at ${input.kitFile || "(not set)"}. Nothing was invented.`,
      };
    }
    const found = input.dictionary.get(name);
    if (!found) {
      return {
        ok: false, code: "FMC-PARAM-NOT-IN-KIT",
        message: `[FMC-PARAM-NOT-IN-KIT] "${name}" is not in the kit shared parameter file. Kit change: add it to FMC_SharedParameters.txt. No definition was created.`,
      };
    }
    guid = found.guid;
    datatype = found.datatype;
    const kitType = typeNameOf(found.datatype);
    if (input.action === "add" && type && kitType && type !== normalType(kitType)) {
      return {
        ok: false, code: "FMC-PARAM-TYPE",
        message: `[FMC-PARAM-TYPE] "${name}" is ${found.datatype} in the kit file. The call asked for ${input.type}. The kit definition was not changed.`,
      };
    }
  } else if (input.action === "add") {
    if (!PARAM_TYPES.includes(type as ParamTypeName)) {
      return { ok: false, code: "FMC-PARAM-TYPE", message: `[FMC-PARAM-TYPE] type is one of ${PARAM_TYPES.join(", ")}.` };
    }
  }
  if (input.action === "label" && input.existing && !input.existing.some((item) => item.toLowerCase() === name.toLowerCase())) {
    return {
      ok: false, code: "FMC-PARAM-MISSING",
      message: `[FMC-PARAM-MISSING] "${name}" is not a parameter of ${family}. add it first. The label was not drawn.`,
    };
  }
  if (input.action === "add" && input.existing && input.existing.some((item) => item.toLowerCase() === name.toLowerCase())) {
    return {
      ok: true, code: "FMC-PARAM-EXISTS",
      message: `[FMC-PARAM-EXISTS] "${name}" is already on ${family}. It will not be added again.`,
      plan: {
        action: "add", family, name, type: type || typeNameOf(datatype) || "text", group, shared, binding, guid, datatype,
        categories: [], origin_mm: input.origin_mm ?? [10, 10], kit_file: input.kitFile,
      },
    };
  }
  return {
    ok: true, code: "", message: "",
    plan: {
      action: input.action,
      family,
      name,
      type: type || typeNameOf(datatype) || (input.action === "add" ? "text" : ""),
      group,
      shared,
      binding,
      guid,
      datatype,
      categories: (input.categories ?? []).map((item) => item.trim()).filter(Boolean),
      origin_mm: input.origin_mm && input.origin_mm.length >= 2 ? input.origin_mm.slice(0, 2) : [10, 10],
      kit_file: input.kitFile,
    },
  };
}

export function familyParamsDir(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.FMC_FAMILY_PARAMS_DIR ?? "").trim()) return env.FMC_FAMILY_PARAMS_DIR!.trim();
  const local = env.LOCALAPPDATA || path.join(path.sep, "tmp", "FormcraftLocal");
  return path.join(local, "Formcraft", "familyparams");
}

export function writeFamilyParamsReport(env: NodeJS.ProcessEnv, action: string, body: unknown, dir = familyParamsDir(env)): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `familyparams-${action}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}
