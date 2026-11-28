/**
 * Path safety for the fmc_energy gbXML export and check (GAP-23), and the findings drawn from the analytical model
 * report. No Revit dependency. The export goes ONLY into the folder that holds the open .rvt, under a sanitised,
 * timestamped name, never over an existing file and never over the model. The add-in checks the same rules again.
 */
import path from "node:path";

const win = path.win32;

export const CLOUD_PREFIXES = ["bim 360:", "autodesk docs:", "revit server:", "rsn:", "cloud:"];

/** A local drive path (C:\...) or a UNC share (\\server\share\...). Cloud and Revit Server paths are not. */
export function isLocalPath(p: string): boolean {
  const s = (p ?? "").trim();
  if (!s) return false;
  if (CLOUD_PREFIXES.some((c) => s.toLowerCase().startsWith(c))) return false;
  return /^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(s);
}

/** Letters, digits, dot, dash and underscore. Separators, drive colons and other characters become _. No leading dots. */
export function sanitizeName(raw: string): string {
  let s = String(raw ?? "").trim().replace(/\.xml$/i, "");
  s = s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/\.{2,}/g, ".").replace(/_+/g, "_");
  s = s.replace(/^[._-]+/, "").replace(/[._-]+$/, "");
  if (s.length > 120) s = s.slice(0, 120).replace(/[._-]+$/, "");
  return s;
}

export function stampOf(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

function sameFolder(a: string, b: string): boolean {
  const n = (x: string) => win.resolve(x).replace(/[\\/]+$/, "").toLowerCase();
  return n(a) === n(b);
}

export interface ExportPlan {
  ok: boolean;
  code?: "FMC-ENERGY-UNSAVED" | "FMC-ENERGY-CLOUD" | "FMC-ENERGY-NOT-PROJECT" | "FMC-ENERGY-NAME" | "FMC-ENERGY-OUTSIDE" | "FMC-ENERGY-EXISTS";
  reasons: string[];
  folder: string;
  file: string;
  name: string;
  name_changed: boolean;
}

/**
 * Where the gbXML goes: <folder of the .rvt>\<name>.xml. name defaults to <model>_gbXML_<yyyyMMdd-HHmm>; a default name
 * that exists gets -2, -3 ... (up to -20); a name from the call that exists is refused. Nothing is ever overwritten.
 */
export function planGbxmlExport(rvtPath: string, opts: { name?: string; now?: Date; exists?: (p: string) => boolean } = {}): ExportPlan {
  const exists = opts.exists ?? (() => false);
  const fail = (code: ExportPlan["code"], reason: string, extra: Partial<ExportPlan> = {}): ExportPlan =>
    ({ ok: false, code, reasons: [reason], folder: "", file: "", name: "", name_changed: false, ...extra });
  const rvt = (rvtPath ?? "").trim();
  if (!rvt) return fail("FMC-ENERGY-UNSAVED", "The document has never been saved: there is no project folder to export into.");
  if (!isLocalPath(rvt)) return fail("FMC-ENERGY-CLOUD", `${rvt} is a cloud or Revit Server model. gbXML export goes only beside a local .rvt.`);
  if (win.extname(rvt).toLowerCase() !== ".rvt") return fail("FMC-ENERGY-NOT-PROJECT", `${win.basename(rvt)} is not a project (.rvt).`);
  const folder = win.dirname(win.resolve(rvt));
  const model = sanitizeName(win.basename(rvt, win.extname(rvt))) || "model";
  const asked = (opts.name ?? "").trim();
  const name = asked ? sanitizeName(asked) : `${model}_gbXML_${stampOf(opts.now ?? new Date())}`;
  if (!name) return fail("FMC-ENERGY-NAME", `The name ${asked} has no usable characters.`, { folder });
  const candidates = asked ? [name] : [name, ...Array.from({ length: 19 }, (_, i) => `${name}-${i + 2}`)];
  for (const n of candidates) {
    const file = win.join(folder, `${n}.xml`);
    if (!sameFolder(win.dirname(win.resolve(file)), folder)) return fail("FMC-ENERGY-OUTSIDE", `${file} is not directly in ${folder}.`, { folder, name: n });
    if (file.toLowerCase() === win.resolve(rvt).toLowerCase()) return fail("FMC-ENERGY-NAME", "The export would replace the model.", { folder, name: n });
    if (!exists(file)) return { ok: true, reasons: [], folder, file, name: n, name_changed: !!asked && n !== asked.replace(/\.xml$/i, "") };
    if (asked) return fail("FMC-ENERGY-EXISTS", `${file} already exists. Nothing is overwritten: pass another name.`, { folder, name: n, file });
  }
  return fail("FMC-ENERGY-EXISTS", `${name}.xml and -2 to -20 already exist in ${folder}. Nothing is overwritten.`, { folder, name });
}

/** A gbXML to check: a name or path that resolves inside the project folder (subfolders allowed) and ends in .xml. */
export function resolveCheckFile(folder: string, file: string): { ok: boolean; file: string; reason?: string } {
  const f = (file ?? "").trim();
  if (!folder || !isLocalPath(folder)) return { ok: false, file: "", reason: "There is no local project folder." };
  if (!f) return { ok: false, file: "", reason: "check needs file (a gbXML in the project folder)." };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(f) || CLOUD_PREFIXES.some((c) => f.toLowerCase().startsWith(c))) return { ok: false, file: "", reason: `${f} is not a local file.` };
  const root = win.resolve(folder).replace(/[\\/]+$/, "");
  const full = win.resolve(win.isAbsolute(f) ? f : win.join(root, f));
  const inside = full.toLowerCase().startsWith(root.toLowerCase() + "\\");
  if (!inside) return { ok: false, file: full, reason: `${full} is outside the project folder ${root}.` };
  if (win.extname(full).toLowerCase() !== ".xml") return { ok: false, file: full, reason: `${win.basename(full)} is not a .xml file.` };
  return { ok: true, file: full };
}

export interface AnalyticalFinding { code: string; count: number; message: string; sample?: string[] }

/** Findings from the add-in's analytical model report. Counts only; the report keeps the samples. */
export function analyticalFindings(report: Record<string, unknown> | null | undefined): { status: "OK" | "WARN" | "NO_MODEL"; findings: AnalyticalFinding[] } {
  const r = (report ?? {}) as Record<string, any>;
  const out: AnalyticalFinding[] = [];
  const add = (code: string, count: unknown, message: string, sample?: unknown) => {
    const n = Number(count ?? 0);
    if (n > 0) out.push({ code, count: n, message, ...(Array.isArray(sample) && sample.length ? { sample: sample.slice(0, 20).map(String) } : {}) });
  };
  const rooms = r.rooms ?? {}, spaces = r.spaces ?? {}, model = r.model ?? {}, settings = r.settings ?? {};
  add("ROOM_NOT_PLACED", rooms.not_placed, "Rooms that are not placed.", rooms.not_placed_ids);
  add("ROOM_UNBOUNDED", rooms.unbounded, "Rooms that are placed but not enclosed (area 0).", rooms.unbounded_ids);
  add("ROOM_NO_LEVEL", rooms.missing_level, "Rooms with no level.", rooms.missing_level_ids);
  add("SPACE_NOT_PLACED", spaces.not_placed, "Spaces that are not placed.", spaces.not_placed_ids);
  add("SPACE_UNBOUNDED", spaces.unbounded, "Spaces that are placed but not enclosed (area 0).", spaces.unbounded_ids);
  add("SPACE_NO_LEVEL", spaces.missing_level, "Spaces with no level.", spaces.missing_level_ids);
  if (settings.ground_plane_missing === true) add("GROUND_PLANE_MISSING", 1, "The energy settings have no ground plane level.");
  if (Number(r.levels ?? 1) === 0) add("NO_LEVELS", 1, "The model has no levels.");
  const usesSpaces = /space|room/i.test(String(settings.analysis_type ?? "")) && !/element/i.test(String(settings.analysis_type ?? ""));
  if (usesSpaces && Number(rooms.placed ?? 0) + Number(spaces.placed ?? 0) === 0) add("NO_SPATIAL_ELEMENTS", 1, "The analysis uses rooms or spaces but none are placed.");
  if (model.exists === true) {
    add("SURFACE_NO_SPACE", model.surfaces_no_space, "Analytical surfaces with no analytical space.", model.surfaces_no_space_ids);
    add("SURFACE_NO_ADJACENT_SPACE", model.interior_no_adjacent, "Interior analytical surfaces with no space on the other side.", model.interior_no_adjacent_ids);
    if (Number(model.spaces ?? 0) === 0) add("MODEL_NO_SPACES", 1, "The energy analytical model has no spaces.");
  }
  add("REVIT_WARNINGS", r.warnings?.count, "Revit warnings about rooms, spaces, boundaries or the energy model.");
  if (model.exists !== true) return { status: "NO_MODEL", findings: out };
  return { status: out.length ? "WARN" : "OK", findings: out };
}
