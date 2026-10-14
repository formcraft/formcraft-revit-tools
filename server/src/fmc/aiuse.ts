import path from "node:path";
import { DocInfo, GuardConfig, checkWritePath } from "./policy.js";

const win = path.win32;

/**
 * The AI-assisted modeller (docs/AI_ASSISTED_MODELLER.md v2, Manual Part 18 change request; Phase A of
 * docs/PLAN_EXECUTION.md). The live-model lock still refuses every model-changing command on a project model; this
 * is its one new case. A command may run on a project model only when every gate below passes, and every refusal
 * names the gate that failed.
 *
 * It is Off unless both exist and agree:
 * - the kit rulebook `FMC_Rulebook_AIUse.json` (bands, groups, limits, the cap measure: kit data, rule 7), and
 * - the `ai_modeller` section of fmc_guard.json (the BIM Manager's switch, involvement and levels).
 *
 * A missing or broken rulebook or section means Off, so a broken config never widens access.
 */

export type Level = "Off" | "Suggest" | "Fix with approval" | "Auto in WIP";
export const LEVELS: Level[] = ["Off", "Suggest", "Fix with approval", "Auto in WIP"];

export interface AiGroup { name: string; auto_allowed: boolean }
export interface AiBand { min: number; max: number; name: string; groups: string[] }
export interface AiRulebook {
  schema: string;
  default_involvement: number;
  bands: AiBand[];
  groups: Record<string, AiGroup>;
  /** Per-discipline ceilings, e.g. S: { max_involvement: 5, groups: ["data", "views"] }. */
  discipline_overrides: Record<string, { max_involvement: number; groups?: string[] }>;
  limits: { batch_elements: number; daily_elements: number; failed_batches_per_day: number };
  /** How much of a model AI may author: "none" (bands only) until the owner decides. */
  cap: { measure: string; value?: number };
}

export interface AiModellerConfig {
  /** The firm-wide switch (BIM Manager). */
  on: boolean;
  /** Stop AI: anyone on the project can set it; every AI write is refused while it is true. */
  stop: boolean;
  /** Firm default involvement, 0-100 (the rulebook's default when absent). */
  involvement?: number;
  /** Per project code: its own switch, involvement and levels. A project not listed uses the firm values. */
  projects: Record<string, { on?: boolean; involvement?: number; levels?: Record<string, Level> }>;
  /** Autonomy level per group (firm default); a group not listed is at Suggest. */
  levels: Record<string, Level>;
}

/** Which operation group each model-changing command belongs to. Commands not here are never AI-run on a project. */
export const COMMAND_GROUPS: Record<string, string> = {
  tag_walls: "views", tag_rooms: "views", create_dimensions: "views", color_splash: "views",
  fmc_sheet_create: "views", fmc_sheet_rename: "views", fmc_review_cloud: "views",
  fmc_material_assign: "data",
  create_room: "create_from_brief", fmc_brief_apply: "create_from_brief", create_point_based_element: "create_from_brief",
};

/** Never AI-run on a project model, whatever the band: structure, levels, grids, deleting, arbitrary code, coordination. */
export const NEVER: Record<string, string> = {
  create_level: "levels", create_grid: "grids", create_structural_framing_system: "structure",
  delete_element: "deleting", operate_element: "moving or deleting arbitrary elements", send_code_to_revit: "running arbitrary code",
  fmc_link_add: "links (coordination)", fmc_link_pin: "links (coordination)", fmc_workset_create: "worksets (setup)",
  fmc_material_purge: "purging (deleting)", create_line_based_element: "walls and lines (Phase 6, after a structural check in Revit)",
  create_surface_based_element: "floors, ceilings and roofs (Phase 6, after a structural check in Revit)",
};

/** Categories AI may place with create_point_based_element (checked in Revit by fmc_type_facts before it runs). */
export const PLACEABLE = ["OST_Doors", "OST_Windows", "OST_PlumbingFixtures", "OST_LightingFixtures", "OST_ElectricalFixtures",
  "OST_LightingDevices", "OST_Furniture", "OST_FurnitureSystems", "OST_Casework", "OST_SpecialityEquipment", "OST_GenericModel"];

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export function parseRulebook(raw: string): { book: AiRulebook | null; problems: string[] } {
  let o: any;
  try { o = JSON.parse(raw.replace(/^﻿/, "")); } catch (e) { return { book: null, problems: [`Not JSON: ${e instanceof Error ? e.message : e}`] }; }
  const problems: string[] = [];
  if (!/^fmc-aiuse\/0\.\d+$/.test(String(o?.schema ?? ""))) problems.push(`schema must be "fmc-aiuse/0.1"`);
  const bands: AiBand[] = Array.isArray(o?.bands) ? o.bands.map((b: any) => ({ min: num(b?.min, -1), max: num(b?.max, -1), name: String(b?.name ?? ""),
    groups: Array.isArray(b?.groups) ? b.groups.map(String) : [] })) : [];
  if (!bands.length) problems.push("bands are missing");
  const groups: Record<string, AiGroup> = {};
  for (const [k, g] of Object.entries((o?.groups ?? {}) as Record<string, any>)) groups[k] = { name: String(g?.name ?? k), auto_allowed: g?.auto_allowed === true };
  for (const b of bands) for (const g of b.groups) if (!groups[g]) problems.push(`band ${b.name} names a group the rulebook doesn't define: ${g}`);
  const lim = o?.limits ?? {};
  const book: AiRulebook = {
    schema: String(o?.schema ?? ""), default_involvement: num(o?.default_involvement, 0), bands, groups,
    discipline_overrides: o?.discipline_overrides && typeof o.discipline_overrides === "object" ? o.discipline_overrides : {},
    limits: { batch_elements: num(lim.batch_elements, 0), daily_elements: num(lim.daily_elements, 0), failed_batches_per_day: num(lim.failed_batches_per_day, 0) },
    cap: { measure: String(o?.cap?.measure ?? "none"), value: o?.cap?.value },
  };
  if (book.limits.batch_elements <= 0 || book.limits.daily_elements <= 0) problems.push("limits.batch_elements and limits.daily_elements must be set");
  return { book: problems.length ? null : book, problems };
}

export function parseConfig(raw: unknown): AiModellerConfig | null {
  const o = raw as any;
  if (!o || typeof o !== "object" || typeof o.on !== "boolean") return null;
  const levels: Record<string, Level> = {};
  for (const [k, v] of Object.entries((o.levels ?? {}) as Record<string, unknown>)) if (LEVELS.includes(v as Level)) levels[k] = v as Level;
  return { on: o.on, stop: o.stop === true, involvement: typeof o.involvement === "number" ? o.involvement : undefined,
    projects: o.projects && typeof o.projects === "object" ? o.projects : {}, levels };
}

/** The model's project code and role from its name (FMC naming: [Project]-[Originator]-[Volume]-[Level]-[Type]-[Role]-[Number]). */
export function modelParts(title: string): { project: string; role: string } {
  const parts = title.replace(/\.rvt$/i, "").split("-");
  return { project: parts[0] ?? "", role: parts.length >= 7 ? parts[5] : "" };
}

/** The project folder above 01_WIP, where the log goes (06_QA). */
export function projectFolderOf(docPath: string): string {
  const segs = win.normalize(docPath).split("\\");
  const i = segs.findIndex((s) => s.toUpperCase() === "01_WIP");
  return i > 0 ? segs.slice(0, i).join("\\") : "";
}

export interface AiState { day: string; models: Record<string, { elements: number; failed: number; off: boolean }> }

export interface AiAsk {
  command: string;
  doc: DocInfo & { isLocal?: boolean };
  elements: number;
  /** An approval a person gave in the pane for exactly this batch. */
  approved: boolean;
}

export interface AiVerdict {
  ok: boolean;
  reasons: string[];
  group?: string;
  level?: Level;
  band?: string;
  /** "Fix with approval" without an approval yet: the batch goes to the queue. */
  needs_approval?: boolean;
}

/** Every gate, in order; the first that fails is the reason. Pure: the caller loads the files. */
export function aiVerdict(ask: AiAsk, cfg: GuardConfig, book: AiRulebook | null, ai: AiModellerConfig | null, state: AiState): AiVerdict {
  const no = (r: string, extra: Partial<AiVerdict> = {}): AiVerdict => ({ ok: false, reasons: [r], ...extra });
  if (!ai) return no("AI-assisted modelling is off: fmc_guard.json has no valid ai_modeller section");
  if (!book) return no("AI-assisted modelling is off: the kit has no valid FMC_Rulebook_AIUse (a kit change request)");
  if (ai.stop) return no("Stop AI is on: every AI change is refused until it is switched off");
  if (NEVER[ask.command]) return no(`AI never runs ${ask.command} on a project model: ${NEVER[ask.command]}`);
  const group = COMMAND_GROUPS[ask.command];
  if (!group) return no(`${ask.command} isn't in any AI operation group`);
  if (!book.groups[group]) return no(`The kit rulebook doesn't define the group ${group}`, { group });

  const d = ask.doc;
  if (d.isFamily || !d.path) return no("Not a project model: the normal lock already decides families and new documents", { group });
  if (d.isWorkshared && d.isLocal !== true) return no(`${d.title} is a central model (or its local status is unknown): AI works only in a person's local WIP copy`, { group });
  const where = checkWritePath(d.path, cfg, { checkName: false });
  if (!where.ok || !/\\01_WIP\\/i.test(win.normalize(d.path))) return no(`${d.title} isn't in a WIP folder: AI works only in WIP (${where.reasons[0] ?? "outside 01_WIP"})`, { group });

  const { project, role } = modelParts(d.title);
  const p = ai.projects[project] ?? {};
  if (!(p.on ?? ai.on)) return no(`AI-assisted modelling is off for ${project || "this project"} (the BIM Manager's switch)`, { group });
  // A discipline's ceiling (S: 5%) applies before the bands, so it can only narrow what the project allows.
  const over = role ? book.discipline_overrides[role] : undefined;
  let involvement = Math.max(0, Math.min(100, p.involvement ?? ai.involvement ?? book.default_involvement));
  if (over) involvement = Math.min(involvement, over.max_involvement);
  let allowed = new Set<string>();
  for (const b of book.bands) if (involvement >= b.min) for (const g of b.groups) allowed.add(g);
  if (over?.groups) allowed = new Set([...allowed].filter((g) => over.groups!.includes(g)));
  const band = book.bands.find((b) => involvement >= b.min && involvement <= b.max)?.name ?? "";
  if (involvement <= 0) return no(`AI involvement is 0% for ${project || "this project"}${over ? ` (${role} models)` : ""}`, { group, band });
  if (!allowed.has(group)) return no(`${book.groups[group].name} isn't unlocked at ${involvement}%${over ? ` for ${role} models` : ""} (band ${band || "none"})`, { group, band });

  const level: Level = p.levels?.[group] ?? ai.levels[group] ?? "Suggest";
  if (level === "Off") return no(`${book.groups[group].name} is Off for this project`, { group, level, band });
  if (level === "Suggest") return no(`${book.groups[group].name} is at Suggest: AI shows the change and a person does it`, { group, level, band });
  if (level === "Auto in WIP" && !book.groups[group].auto_allowed) return no(`${book.groups[group].name} may not run as Auto in WIP (the rulebook)`, { group, level, band });

  const key = d.path.toLowerCase();
  const m = state.day === today() ? state.models[key] : undefined;
  if (m?.off) return no(`AI was switched off for ${d.title} today after ${book.limits.failed_batches_per_day} failed batches: the author switches it on again`, { group, level, band });
  if (ask.elements > book.limits.batch_elements) return no(`This batch has ${ask.elements} elements; the limit is ${book.limits.batch_elements}: split it`, { group, level, band });
  if ((m?.elements ?? 0) + ask.elements > book.limits.daily_elements) return no(`${d.title} would pass today's limit of ${book.limits.daily_elements} AI-changed elements`, { group, level, band });

  if (level === "Fix with approval" && !ask.approved)
    return no(`${book.groups[group].name} is at Fix with approval: the batch waits for the model's author to approve it in the Formcraft pane`, { group, level, band, needs_approval: true });
  return { ok: true, reasons: [], group, level, band };
}

export const today = (now: Date = new Date()) => now.toISOString().slice(0, 10);

/** How many elements a batch touches: the longest list in its parameters (at least 1). */
export function batchSize(params: unknown): number {
  let n = 0;
  const walk = (v: unknown, depth: number) => {
    if (Array.isArray(v)) { n = Math.max(n, v.length); if (depth < 2) v.forEach((x) => walk(x, depth + 1)); }
    else if (v && typeof v === "object" && depth < 2) Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(params, 0);
  return Math.max(1, n);
}

/** Records a batch's result; three failures in a day switch AI off for that model. */
export function recordBatch(state: AiState, docPath: string, elements: number, failed: boolean, book: AiRulebook, now = new Date()): AiState {
  const day = today(now);
  const s: AiState = state.day === day ? { day, models: { ...state.models } } : { day, models: {} };
  const key = docPath.toLowerCase();
  const m = { ...(s.models[key] ?? { elements: 0, failed: 0, off: false }) };
  if (failed) m.failed += 1; else m.elements += elements;
  if (m.failed >= book.limits.failed_batches_per_day) m.off = true;
  s.models[key] = m;
  return s;
}

/** The approval key: the same command with the same parameters, nothing else. */
export function batchKey(command: string, params: unknown, docPath: string): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as object).filter(([k]) => k !== "document").sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)]))
    : v;
  const text = command + "|" + docPath.toLowerCase() + "|" + JSON.stringify(stable(params));
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
