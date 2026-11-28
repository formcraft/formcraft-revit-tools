/**
 * fmc_exports (GAP-04): IFC4, DWG, NWC and gbXML exports from the kit's setups into the project's 02_Shared or
 * 03_Published, with every output verified. Pure: setups, target folders, the gate and the output checks. The Revit
 * side is commandset/Services/Fmc/FmcExports.cs.
 *
 * 02_Shared and 03_Published are CDE gates with a named approver (Manual 7.5; blocked_segments in fmc_guard.json).
 * So a real export needs dry_run=false, confirm=true and the approver's name, and the files arrive through a
 * hidden folder inside the target that is verified before anything is moved into place.
 */
import path from "node:path";
import { z } from "zod";

const win = path.win32;

export const EXPORT_FORMATS = ["ifc", "dwg", "nwc", "gbxml"] as const;
export type ExportFormat = typeof EXPORT_FORMATS[number];
export const EXT: Record<ExportFormat, string> = { ifc: ".ifc", dwg: ".dwg", nwc: ".nwc", gbxml: ".xml" };

export const SETUP = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("ifc"),
    version: z.enum(["IFC4RV", "IFC4DTV", "IFC4"]).default("IFC4RV"),
    base_quantities: z.boolean().default(true),
    /** a user-defined property set file, relative to the kit folder */
    psets_file: z.string().default("07_IFC_IDS\\FMC_IFC_PropertySets.txt"),
    split_walls_columns: z.boolean().default(false),
    view: z.string().default(""),
  }),
  z.object({
    format: z.literal("dwg"),
    /** a DWG export setup saved in the model or template (Revit's predefined setups) */
    setup: z.string().default("FMC_DWG"),
    merged_views: z.boolean().default(true),
  }),
  z.object({
    format: z.literal("nwc"),
    coordinates: z.enum(["shared", "internal"]).default("shared"),
    links: z.boolean().default(false),
    rooms: z.boolean().default(false),
    view: z.string().default(""),
  }),
  z.object({ format: z.literal("gbxml") }),
]);
export type ExportSetup = z.infer<typeof SETUP>;

export const SETUPS_FILE = z.object({
  schema: z.literal("fmc-exports/0.1"),
  setups: z.record(SETUP),
});

/** The built-in setups, used when the kit has no 03_Master_Data\FMC_Export_Setups.json. */
export const DEFAULT_SETUPS: Record<string, ExportSetup> = {
  ifc: SETUP.parse({ format: "ifc" }),
  dwg: SETUP.parse({ format: "dwg" }),
  nwc: SETUP.parse({ format: "nwc" }),
  gbxml: SETUP.parse({ format: "gbxml" }),
};

export function parseSetups(json: unknown): { setups: Record<string, ExportSetup>; problems: string[] } {
  const r = SETUPS_FILE.safeParse(json);
  if (!r.success) return { setups: {}, problems: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  return { setups: r.data.setups, problems: [] };
}

export type Target = "shared" | "published";
export const TARGET_FOLDER: Record<Target, string> = { shared: "02_Shared", published: "03_Published" };

/** <project>\02_Shared or \03_Published, plus an optional plain subfolder (no .., no drive, no separators beyond one level). */
export function targetFolder(projectRoot: string, target: Target, sub = ""): { folder: string; problem?: string } {
  if (!projectRoot) return { folder: "", problem: "The document isn't saved in a project folder (…\\01_WIP\\…), so it has no 02_Shared or 03_Published" };
  const s = sub.trim();
  if (s && (!/^[A-Za-z0-9 _.-]{1,60}$/.test(s) || s.startsWith(".") || s.includes(".."))) return { folder: "", problem: `subfolder "${s}" must be a plain folder name` };
  return { folder: win.join(projectRoot, TARGET_FOLDER[target], s) };
}

export function isInside(child: string, parent: string): boolean {
  const c = win.normalize(child).toLowerCase().replace(/\\+$/, "");
  const p = win.normalize(parent).toLowerCase().replace(/\\+$/, "");
  return c === p || c.startsWith(p + "\\");
}

export interface GateInput {
  dry_run: boolean;
  confirm: boolean;
  approver: string;
  target: Target;
  folder: string;
  projectRoot: string;
  writeRoots: string[];
}

/** Why a real export may not run (empty when it may). A dry run never writes, so it is never gated. */
export function exportGate(g: GateInput): string[] {
  if (g.dry_run) return [];
  const out: string[] = [];
  if (!g.confirm) out.push(`Writing into ${TARGET_FOLDER[g.target]} is a CDE gate: it needs confirm=true`);
  if (!g.approver.trim()) out.push(`Writing into ${TARGET_FOLDER[g.target]} needs the named approver (approver), Manual 7.5`);
  if (!g.projectRoot) out.push("No project folder");
  else if (!isInside(g.folder, win.join(g.projectRoot, TARGET_FOLDER[g.target]))) out.push(`The folder must be inside the project's ${TARGET_FOLDER[g.target]}`);
  if (g.projectRoot && !g.writeRoots.some((r) => isInside(g.projectRoot, r))) out.push(`The project folder ${g.projectRoot} is not inside a write root in fmc_guard.json`);
  return out;
}

/** Output file names: the model's title, the format's extension, an optional suffix. */
export function outputName(title: string, format: ExportFormat, suffix = ""): string {
  const base = title.replace(/\.rvt$/i, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "model";
  return `${base}${suffix ? "_" + suffix.replace(/[^A-Za-z0-9_-]/g, "_") : ""}${EXT[format]}`;
}

export interface Verified { file: string; format: ExportFormat; ok: boolean; size: number; reason?: string; detail?: string }

/**
 * Is the file what its format says? IFC: STEP header with FILE_SCHEMA IFC4. DWG: AC10xx magic. gbXML: a gbXML root.
 * NWC has no published magic: it must be a non-trivial binary file.
 */
export function verifyOutput(file: string, format: ExportFormat, head: Buffer, size: number, setup?: ExportSetup): Verified {
  const base = { file, format, size };
  if (size <= 0) return { ...base, ok: false, reason: "empty file" };
  const text = head.toString("latin1");
  switch (format) {
    case "ifc": {
      if (!text.startsWith("ISO-10303-21;")) return { ...base, ok: false, reason: "not a STEP (ISO-10303-21) file" };
      const m = text.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i);
      if (!m) return { ...base, ok: false, reason: "no FILE_SCHEMA in the header" };
      if (!/^IFC4/i.test(m[1])) return { ...base, ok: false, reason: `schema is ${m[1]}, not IFC4`, detail: m[1] };
      return { ...base, ok: true, detail: m[1] + (setup && setup.format === "ifc" ? ` (${setup.version})` : "") };
    }
    case "dwg": {
      const m = text.match(/^AC10(\d\d)/);
      return m ? { ...base, ok: true, detail: `AC10${m[1]}` } : { ...base, ok: false, reason: "no AutoCAD AC10xx header" };
    }
    case "gbxml":
      return /<gbXML[\s>]/.test(text) ? { ...base, ok: true, detail: "gbXML" } : { ...base, ok: false, reason: "no <gbXML> root in the first bytes" };
    case "nwc":
      if (size < 1024) return { ...base, ok: false, reason: "smaller than 1 KB" };
      if (/^\s*</.test(text) || text.startsWith("ISO-10303")) return { ...base, ok: false, reason: "a text file, not a Navisworks cache" };
      return { ...base, ok: true, detail: "binary, not sniffed further" };
  }
}

export function formatOf(file: string): ExportFormat | null {
  const ext = win.extname(file).toLowerCase();
  return (Object.keys(EXT) as ExportFormat[]).find((f) => EXT[f] === ext) ?? null;
}

/** A run id for the hidden arrival folder and the record: yyyymmdd-hhmmss */
export function runId(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}
