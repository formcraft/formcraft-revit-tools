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
  /** The General AI switch (owner 26 Oct): the groups it covers and their level. Absent: the switch can't turn AI on. */
  general?: { level: Level; groups: string[] };
}

export interface AiModellerConfig {
  /** The firm-wide switch (BIM Manager). */
  on: boolean;
  /** Stop AI: anyone on the project can set it; every AI write is refused while it is true. */
  stop: boolean;
  /** Firm default involvement, 0-100 (the rulebook's default when absent). */
  involvement?: number;
  /** The General AI switch, firm default (per project below wins). Off unless set. */
  general?: boolean;
  /**
   * "strict" (default, for distribution): FMC-compliant models in a project's 01_WIP only. "testing" (owner 26 Oct, the
   * pilot): any file; the switch is keyed by the FMC project code, else the project folder, else the file name. Never
   * central, approvals, limits, Stop AI and the admin-only list apply in both.
   */
  mode?: "strict" | "testing";
  /**
   * Owner 26 Oct: "full" lets the AI use every model-changing tool like a person, delete and purge included, every batch
   * approved; "general" (default) covers the rulebook's general groups. Sync, publish, issue and sign never reach the gate.
   */
  access?: "general" | "full";
  /** Owner 26 Oct, testing: the AI may run Revit API code (send_code_to_revit), each run approved with the code shown. */
  allow_code?: boolean;
  /** Owner 26 Oct: in testing mode, batches run without waiting; each is still listed in Approvals as auto-approved. */
  auto_approve?: boolean;
  /** Per project code: its own General switch, and (admin, Advanced) its own switch, involvement and levels. */
  projects: Record<string, { general?: boolean; on?: boolean; involvement?: number; levels?: Record<string, Level> }>;
  /** Autonomy level per group (firm default); a group not listed is at Suggest. */
  levels: Record<string, Level>;
}

/** Which operation group each model-changing command belongs to. Commands not here are never AI-run on a project. */
export const COMMAND_GROUPS: Record<string, string> = {
  tag_walls: "views", tag_rooms: "views", create_dimensions: "views", color_splash: "views",
  fmc_sheet_create: "views", fmc_sheet_rename: "views", fmc_review_cloud: "views",
  fmc_material_assign: "data", fmc_fea_write: "data",
  create_room: "create_from_brief", fmc_brief_apply: "create_from_brief", create_point_based_element: "create_from_brief",
  // Owner 26 Oct: walls, floors, ceilings and roofs, levels and grids may be AI-modelled, every batch approved by a person.
  create_line_based_element: "architecture", create_surface_based_element: "architecture",
  create_level: "levels_grids", create_grid: "levels_grids",
};

/** Never AI-run on a project model, whatever the switch or band: admins (people) only. */
export const NEVER: Record<string, string> = {
  create_structural_framing_system: "structure",
  delete_element: "deleting", operate_element: "moving or deleting arbitrary elements", send_code_to_revit: "running arbitrary code",
  fmc_link_add: "links (coordination)", fmc_link_pin: "links (coordination)", fmc_workset_create: "worksets (setup)",
  fmc_material_purge: "purging (deleting)",
};

/** What a person sees when AI isn't allowed: plain lines, never the lock's wording (owner 26 Oct). */
export const USER_LINE = {
  off: "AI is off. Turn it on with the AI switch.",
  stopped: "AI is stopped. Resume it with the AI switch.",
  kit: "AI can't work yet: the kit's AI rulebook is missing. Ask your BIM Manager.",
  admin: (what: string) => `Only an admin can do this (${what}).`,
  cant: "AI can't do this.",
  where: "AI works only in your local WIP copy of a project model.",
  // Owner 26 Oct: a non-compliant project is made compliant or AI stays off.
  notCompliant: "Not activated: this model isn't FMC-compliant (name [Project]-[Originator]-[Volume]-[Level]-[Type]-[Role]-[Number].rvt in a project's 01_WIP). Make it compliant to use AI: Save as with an FMC name (Files › Save as), or Project start for a new project.",
  approve: "Waiting for your approval: approve or reject the batch in the pane.",
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
  if (o?.general && typeof o.general === "object") {
    const gl = (o.general.level ?? "Fix with approval") as Level;
    const gg: string[] = Array.isArray(o.general.groups) ? o.general.groups.map(String) : [];
    for (const g of gg) if (!groups[g]) problems.push(`general names a group the rulebook doesn't define: ${g}`);
    // The General switch never runs without a person's yes: only Fix with approval or Suggest.
    if (gl !== "Fix with approval" && gl !== "Suggest") problems.push(`general.level must be "Fix with approval" or "Suggest", not "${gl}"`);
    book.general = { level: gl, groups: gg };
  }
  if (book.limits.batch_elements <= 0 || book.limits.daily_elements <= 0) problems.push("limits.batch_elements and limits.daily_elements must be set");
  return { book: problems.length ? null : book, problems };
}

/**
 * F-041 (issue #133): the rulebook files looked for, in order. The kit r5 ships FMC_Rulebook_ClaudeUse.json (the AI
 * rules AI-001…); the AI-modeller section (schema fmc-aiuse/0.1: bands, groups, limits) is read from
 * FMC_Rulebook_AIUse.json, or from ClaudeUse when that file is in the fmc-aiuse schema or carries it as `ai_use`.
 * Nothing is filled in from code (rule 7): a file without the section leaves AI-assisted modelling Off and says so.
 */
export const AIUSE_FILES = ["FMC_Rulebook_AIUse.json", "FMC_Rulebook_ClaudeUse.json"];

export interface PickedRulebook { book: AiRulebook | null; file: string; section: string; problems: string[] }

/** The first present file (AIUSE_FILES order) with a valid AI-modeller section; otherwise why none is usable. */
export function pickAiRulebook(present: Array<{ name: string; raw: string }>): PickedRulebook {
  const problems: string[] = [];
  const ordered = AIUSE_FILES.map((n) => present.find((p) => p.name.toLowerCase() === n.toLowerCase())).filter((p): p is { name: string; raw: string } => !!p);
  if (!ordered.length) {
    return { book: null, file: "", section: "", problems: [`Neither ${AIUSE_FILES.join(" nor ")} is in the kit's rulebooks`] };
  }
  for (const f of ordered) {
    let o: any;
    try { o = JSON.parse(f.raw.replace(/^﻿/, "")); } catch (e) { problems.push(`${f.name}: not JSON (${e instanceof Error ? e.message : e})`); continue; }
    const isAiUse = (x: any) => !!x && typeof x === "object" && /^fmc-aiuse\//.test(String(x.schema ?? ""));
    const [section, raw] = isAiUse(o) ? ["whole file", f.raw] : isAiUse(o?.ai_use) ? ["ai_use", JSON.stringify(o.ai_use)] : ["", ""];
    if (!section) {
      problems.push(`${f.name} has no AI-modeller section (schema "fmc-aiuse/0.1" with bands, groups and limits, as the whole file or as "ai_use")`);
      continue;
    }
    const r = parseRulebook(raw);
    if (r.book) return { book: r.book, file: f.name, section, problems: [] };
    problems.push(...r.problems.map((p) => `${f.name}: ${p}`));
  }
  return { book: null, file: ordered[0].name, section: "", problems };
}

export function parseConfig(raw: unknown): AiModellerConfig | null {
  const o = raw as any;
  if (!o || typeof o !== "object") return null;
  if (typeof o.on !== "boolean" && typeof o.general !== "boolean" && !(o.projects && typeof o.projects === "object")) return null;
  o.on = o.on === true;
  const levels: Record<string, Level> = {};
  for (const [k, v] of Object.entries((o.levels ?? {}) as Record<string, unknown>)) if (LEVELS.includes(v as Level)) levels[k] = v as Level;
  return { on: o.on, stop: o.stop === true, general: o.general === true ? true : undefined, mode: o.mode === "testing" ? "testing" : "strict", access: o.access === "full" ? "full" : "general", allow_code: o.allow_code === true, auto_approve: o.auto_approve === true,
    involvement: typeof o.involvement === "number" ? o.involvement : undefined,
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
  /** The plain line a person sees (USER_LINE); `reasons` keep the detail for admins and fmc_selftest. */
  user?: string;
  /** "general" when the General AI switch decided, "advanced" for the admin's bands and levels. */
  via?: "general" | "advanced";
}

/** The model's FMC project code (Manual 4.1: 2-6 letters or digits, in a name with all seven parts), or "" when it has none. */
export function projectCode(title: string): string {
  const parts = title.replace(/\.rvt$/i, "").split("-");
  return parts.length >= 7 && /^[A-Z0-9]{2,6}$/.test(parts[0]) ? parts[0] : "";
}

/** What the switch is remembered by: the FMC project code; in testing mode also the project folder, else the file name. */
export function projectKey(title: string, docPath: string, mode: "strict" | "testing" = "strict"): string {
  const code = projectCode(title);
  if (code || mode !== "testing") return code;
  const folder = projectFolderOf(docPath);
  return folder ? win.basename(folder) : title.replace(/\.(rvt|rfa|rte)$/i, "");
}

/** The General AI switch for a model: On, Off or Stopped (Stop AI wins). No key (strict mode, not compliant): Off. */
export function generalState(ai: AiModellerConfig | null, title: string, docPath = ""): "On" | "Off" | "Stopped" {
  if (!ai) return "Off";
  if (ai.stop) return "Stopped";
  const project = projectKey(title, docPath, ai.mode);
  if (!project) return "Off";
  return (ai.projects[project]?.general ?? ai.general) === true ? "On" : "Off";
}

/** Every gate, in order; the first that fails is the reason. Pure: the caller loads the files. */
export function aiVerdict(ask: AiAsk, cfg: GuardConfig, book: AiRulebook | null, ai: AiModellerConfig | null, state: AiState): AiVerdict {
  const no = (r: string, extra: Partial<AiVerdict> = {}): AiVerdict => ({ ok: false, reasons: [r], user: USER_LINE.off, ...extra });
  if (!ai) return no("AI-assisted modelling is off: fmc_guard.json has no valid ai_modeller section (the AI switch creates it)");
  if (!book) return no("AI-assisted modelling is off: the kit has no valid FMC_Rulebook_AIUse, and FMC_Rulebook_ClaudeUse has no AI-modeller section (a kit change request; fmc_selftest says which file it read)", { user: USER_LINE.kit });
  if (ai.stop) return no("Stop AI is on: every AI change is refused until it is switched off", { user: USER_LINE.stopped });
  // Full access (owner 26 Oct): every tool like a person, each batch approved; code only with the admin's code switch.
  const full = ai.access === "full" && generalState(ai, ask.doc.title, ask.doc.path) === "On";
  if (full && ask.command === "send_code_to_revit" && ai.allow_code !== true)
    return no("Running code needs the admin's 'AI may run code' switch", { user: USER_LINE.admin("running code: the admin's 'AI may run code' switch is off") });
  if (!full && NEVER[ask.command]) return no(`AI never runs ${ask.command} on a project model: ${NEVER[ask.command]}`, { user: USER_LINE.admin(NEVER[ask.command]) });
  const group = COMMAND_GROUPS[ask.command] ?? (full ? "full" : undefined);
  if (!group) return no(`${ask.command} isn't in any AI operation group`, { user: USER_LINE.cant });
  if (!full && !book.groups[group]) return no(`The kit rulebook doesn't define the group ${group}`, { group, user: USER_LINE.kit });

  const d = ask.doc;
  if (d.isFamily || !d.path) return no("Not a project model: the normal lock already decides families and new documents", { group, user: USER_LINE.where });
  if (d.isWorkshared && d.isLocal !== true) return no(`${d.title} is a central model (or its local status is unknown): AI works only in a person's local WIP copy`, { group, user: USER_LINE.where });
  const where = ai.mode === "testing" ? { ok: true, reasons: [] as string[] } : checkWritePath(d.path, cfg, { checkName: false });
  if (ai.mode !== "testing" && (!where.ok || !/\\01_WIP\\/i.test(win.normalize(d.path)))) return no(`${d.title} isn't in a WIP folder: AI works only in WIP (${where.reasons[0] ?? "outside 01_WIP"})`, { group, user: USER_LINE.where });

  const { project, role } = modelParts(d.title);
  const p = ai.projects[project] ?? {};

  // The General AI switch: one On/Off per project. On covers the rulebook's general groups at its level (approval),
  // and skips bands and per-group levels (the admin's Advanced panel). Limits and Stop AI still apply.
  if (full) return limitsAndApproval(ask, book, state, group, "Fix with approval", "", "general", ai.mode !== "testing");
  if (generalState(ai, d.title, d.path) === "On") {
    if (!book.general) return no("The General AI switch is on, but the kit rulebook has no general section (a kit change request)", { group, user: USER_LINE.kit, via: "general" });
    if (!book.general.groups.includes(group)) return no(`${book.groups[group].name} isn't covered by the General AI switch: an admin decides it in Advanced`, { group, user: USER_LINE.admin(book.groups[group].name.toLowerCase()), via: "general" });
    const glevel = book.general.level;
    if (glevel === "Suggest") return no(`${book.groups[group].name} is at Suggest under the General AI switch`, { group, level: glevel, user: USER_LINE.cant, via: "general" });
    return limitsAndApproval(ask, book, state, group, glevel, "", "general", ai.mode !== "testing");
  }
  if (!(p.on ?? ai.on)) return no(`AI-assisted modelling is off for ${project || "this project"} (the General AI switch is off, and so is the admin's Advanced switch)`, { group });
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

  return limitsAndApproval(ask, book, state, group, level, band, "advanced", ai.mode !== "testing");
}

/** The gates both paths share: today's failures, the batch and daily limits, then the approval. */
/**
 * The rulebook's limits (batch size, the day's total, three failed batches) and the approval step. Owner 26 Oct: no
 * limits while testing; they come back for distribution (strict mode). Approval stays in both.
 */
function limitsAndApproval(ask: AiAsk, book: AiRulebook, state: AiState, group: string, level: Level, band: string, via: "general" | "advanced", limits = true): AiVerdict {
  const d = ask.doc;
  if (!limits) {
    if (level === "Fix with approval" && !ask.approved)
      return { ok: false, reasons: [`${book.groups[group]?.name ?? "This change"} is at Fix with approval: the batch waits for the model's author to approve it in the Formcraft pane`], group, level, band, via, user: USER_LINE.approve, needs_approval: true };
    return { ok: true, reasons: [], group, level, band, via };
  }
  const no = (r: string, user: string, extra: Partial<AiVerdict> = {}): AiVerdict => ({ ok: false, reasons: [r], group, level, band, via, user, ...extra });
  const key = d.path.toLowerCase();
  const m = state.day === today() ? state.models[key] : undefined;
  if (m?.off) return no(`AI was switched off for ${d.title} today after ${book.limits.failed_batches_per_day} failed batches: the author switches it on again`,
    `AI paused for this model today after ${book.limits.failed_batches_per_day} failed batches.`);
  if (ask.elements > book.limits.batch_elements) return no(`This batch has ${ask.elements} elements; the limit is ${book.limits.batch_elements}: split it`,
    `Too many changes at once (${ask.elements}; the limit is ${book.limits.batch_elements}): AI has to split it.`);
  if ((m?.elements ?? 0) + ask.elements > book.limits.daily_elements) return no(`${d.title} would pass today's limit of ${book.limits.daily_elements} AI-changed elements`,
    `Today's limit of ${book.limits.daily_elements} AI changes for this model is reached.`);
  if (level === "Fix with approval" && !ask.approved)
    return no(`${book.groups[group]?.name ?? "This change"} is at Fix with approval: the batch waits for the model's author to approve it in the Formcraft pane`, USER_LINE.approve, { needs_approval: true });
  return { ok: true, reasons: [], group, level, band, via };
}

export const today = (now: Date = new Date()) => now.toISOString().slice(0, 10);

/** How many elements a batch touches: the longest list in its parameters (at least 1). */
export function batchSize(params: unknown): number {
  // modify_model: every element an op names counts (98 rooms to delete are 98, not one op)
  const ops = (params as { ops?: Array<{ ids?: unknown[] }> })?.ops;
  if (Array.isArray(ops)) return Math.max(1, ops.reduce((n, o) => n + (Array.isArray(o?.ids) ? o.ids.length : 1), 0));
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
