import path from "node:path";

const win = path.win32;

/**
 * Model › Start from brief (U23, board model/PaneModelBrief). A Concept Information Set (CIS) is the approved concept
 * as data: levels, Project Information, the room programme, materials and the door and window families chosen. The kit
 * has no CIS schema yet, so this is the plugin's v0.1 (docs/CIS.md); every parameter name must be a kit parameter
 * (03_Master_Data\FMC_Master_Data.json, rule 7). Blanks stay blank and nothing here is geometry.
 */
export interface CisLevel { name: string; elevation_mm: number }
export interface CisRoom { number: string; name: string; params: Record<string, string | number>; level?: string }
export interface Cis {
  schema: string;
  project: string;
  revision: string;
  approved: string;
  levels: CisLevel[];
  project_info: Record<string, string | number | null>;
  rooms: CisRoom[];
  materials: string[];
  families: string[];
}

export interface KitParam { binding: string; categories: string[] }

export function kitParams(masterData: unknown): Record<string, KitParam> {
  const params = (masterData as { params?: Record<string, KitParam> })?.params ?? {};
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, { binding: String(v?.binding ?? ""), categories: Array.isArray(v?.categories) ? v.categories : [] }]));
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

/** Reads a CIS file's JSON; problems stop the run (a CIS that can't be read is never guessed at). */
export function parseCis(raw: string): { cis: Cis | null; problems: string[] } {
  let o: any;
  try { o = JSON.parse(raw.replace(/^﻿/, "")); } catch (e) { return { cis: null, problems: [`Not JSON: ${e instanceof Error ? e.message : e}`] }; }
  const problems: string[] = [];
  if (!/^fmc-cis\/0\.\d+$/.test(str(o?.schema))) problems.push(`schema must be "fmc-cis/0.1" (found "${str(o?.schema)}")`);
  if (!str(o?.project)) problems.push("project is missing");
  const levels: CisLevel[] = Array.isArray(o?.levels) ? o.levels.map((l: any) => ({ name: str(l?.name), elevation_mm: Number(l?.elevation_mm) })) : [];
  levels.forEach((l, i) => {
    if (!l.name) problems.push(`levels[${i}]: name is missing`);
    if (!Number.isFinite(l.elevation_mm)) problems.push(`levels[${i}] ${l.name}: elevation_mm is not a number`);
  });
  const dupLevels = levels.map((l) => l.name.toLowerCase()).filter((n, i, a) => n && a.indexOf(n) !== i);
  if (dupLevels.length) problems.push(`Level names repeat: ${[...new Set(dupLevels)].join(", ")}`);
  const rooms: CisRoom[] = Array.isArray(o?.rooms) ? o.rooms.map((r: any) => ({ number: str(r?.number), name: str(r?.name),
    params: r?.params && typeof r.params === "object" ? r.params : {}, ...(str(r?.level) ? { level: str(r.level) } : {}) })) : [];
  rooms.forEach((r, i) => { if (!r.number || !r.name) problems.push(`rooms[${i}]: number and name are needed`); });
  const dupRooms = rooms.map((r) => r.number).filter((n, i, a) => n && a.indexOf(n) !== i);
  if (dupRooms.length) problems.push(`Room numbers repeat: ${[...new Set(dupRooms)].join(", ")}`);
  const list = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
  const cis: Cis = {
    schema: str(o?.schema), project: str(o?.project), revision: str(o?.revision), approved: str(o?.approved),
    levels, project_info: o?.project_info && typeof o.project_info === "object" ? o.project_info : {}, rooms,
    materials: list(o?.materials), families: list(o?.families),
  };
  return { cis, problems };
}

export interface BriefPlan {
  levels: CisLevel[];
  project_info: Array<{ name: string; value: string }>;
  blanks: string[];
  rooms: CisRoom[];
  families: Array<{ name: string; path: string }>;
  /** Problems that stop the run. */
  problems: string[];
  /** Left out and why (not stopping). */
  skipped: string[];
}

/**
 * What a run would create. Parameter names not in the kit stop the run (the kit wins); project info must be bound to
 * Project Information and room parameters to Rooms. Blank values are listed and left blank. Families are found by name
 * in the kit's approved family folders (never _Staging or _ChainTests).
 */
export function planBrief(cis: Cis, params: Record<string, KitParam>, kitFamilies: string[]): BriefPlan {
  const problems: string[] = [];
  const skipped: string[] = [];
  const blanks: string[] = [];
  const project_info: Array<{ name: string; value: string }> = [];
  for (const [name, v] of Object.entries(cis.project_info)) {
    const p = params[name];
    if (!p) { problems.push(`Project Information: ${name} isn't a kit parameter`); continue; }
    if (p.binding !== "Project Information") { problems.push(`Project Information: ${name} is a ${p.binding} parameter in the kit, not Project Information`); continue; }
    const value = str(v);
    if (!value) blanks.push(name); else project_info.push({ name, value });
  }
  for (const r of cis.rooms) {
    for (const [name, v] of Object.entries(r.params)) {
      const p = params[name];
      if (!p) problems.push(`Room ${r.number}: ${name} isn't a kit parameter`);
      else if (!p.categories.includes("OST_Rooms")) problems.push(`Room ${r.number}: ${name} isn't bound to Rooms in the kit`);
      else if (!str(v)) blanks.push(`${r.number} ${name}`);
    }
  }
  const approved = kitFamilies.filter((f) => !/\\_(Staging|ChainTests)\\/i.test(f));
  const families: Array<{ name: string; path: string }> = [];
  for (const name of cis.families) {
    const want = name.toLowerCase().replace(/\.rfa$/, "");
    const hit = approved.find((f) => win.basename(f).toLowerCase().replace(/\.rfa$/, "") === want);
    if (hit) families.push({ name, path: hit });
    else skipped.push(`Family ${name}: not approved in the kit's 04_Families yet`);
  }
  if (cis.materials.length) skipped.push(`${cis.materials.length} materials: the kit has no materials library yet (F-011), so none are loaded`);
  return { levels: cis.levels, project_info, blanks, rooms: cis.rooms, families, problems, skipped };
}

/** What the Revit command gets: only kit-checked, non-blank values. */
export function applyPayload(plan: BriefPlan, dryRun: boolean) {
  return {
    dry_run: dryRun,
    levels: plan.levels,
    project_info: Object.fromEntries(plan.project_info.map((p) => [p.name, p.value])),
    rooms: plan.rooms.map((r) => ({ number: r.number, name: r.name,
      params: Object.fromEntries(Object.entries(r.params).map(([k, v]) => [k, str(v)]).filter(([, v]) => v)) })),
    families: plan.families.map((f) => f.path),
  };
}
