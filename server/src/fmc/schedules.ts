/**
 * Schedules for every discipline (F60, docs/SCHEDULES.md): a schedule set as data (fmc-schedules/0.1), checked before
 * Revit and made or updated in the open template or WIP model by fmc_schedules_apply. The kit has no schedule set yet
 * (the designs are the chat's Sch_* canvases), so this is the plugin's proposal until the kit publishes one; then the kit
 * wins (rule 7). Every FMC_ field must be a kit parameter bound to the schedule's category; Revit's own fields (Mark,
 * Family and Type, Count…) are checked by name in Revit, where a missing one is reported, never invented. Pure.
 */
import { z } from "zod";
import type { KitParam } from "./brief.js";

const FIELD = z.object({
  name: z.string().min(1),
  heading: z.string().optional(),
  hidden: z.boolean().default(false),
  /** Show the column's total (numbers: sum; Count: count). */
  total: z.boolean().default(false),
});

const FILTER = z.object({
  field: z.string().min(1),
  op: z.enum(["equals", "not_equals", "contains", "not_contains", "begins_with", "greater", "less", "has_value", "has_no_value"]),
  value: z.union([z.string(), z.number()]).optional(),
});

const SORT = z.object({ field: z.string().min(1), descending: z.boolean().default(false), group: z.boolean().default(false), totals: z.boolean().default(false) });

export const SCHEDULE = z.object({
  name: z.string().min(1),
  discipline: z.string().min(1).describe("role code, e.g. A, M, E, P, S, I"),
  /** A BuiltInCategory (OST_Doors) or a category name; "*" for a multi-category schedule. */
  category: z.string().min(1),
  fields: z.array(FIELD).min(1),
  filters: z.array(FILTER).default([]),
  sort: z.array(SORT).default([]),
  itemized: z.boolean().default(true),
  grand_totals: z.boolean().default(false),
  /** The browser folder, by the template's grouping parameter (FMC_Schedule_Folder when the kit has it). */
  folder: z.string().optional(),
});
export type Schedule = z.infer<typeof SCHEDULE>;

export const SCHEDULE_SET = z.object({
  schema: z.string().regex(/^fmc-schedules\/0\.\d+$/, "schema must be fmc-schedules/0.1"),
  name: z.string().min(1),
  revision: z.string().default(""),
  schedules: z.array(SCHEDULE).min(1),
});
export type ScheduleSet = z.infer<typeof SCHEDULE_SET>;

const VALUE_OPS = new Set(["equals", "not_equals", "contains", "not_contains", "begins_with", "greater", "less"]);

/** What is wrong with a schedule set before Revit: problems stop it, warnings don't. */
export function scheduleProblems(set: ScheduleSet, kit: Record<string, KitParam>): { problems: string[]; warnings: string[] } {
  const problems: string[] = [], warnings: string[] = [];
  const names = new Set<string>();
  for (const s of set.schedules) {
    if (names.has(s.name)) problems.push(`The schedule name ${s.name} is used twice`);
    names.add(s.name);
    const fields = new Set(s.fields.map((f) => f.name));
    if (fields.size !== s.fields.length) problems.push(`${s.name}: a field is listed twice`);
    for (const f of s.fields) {
      if (!/^FMC_/.test(f.name)) continue;
      const p = kit[f.name];
      if (!p) { problems.push(`${s.name}: ${f.name} isn't a kit parameter (a kit change request, rule 7)`); continue; }
      if (s.category !== "*" && p.categories.length && !p.categories.includes(s.category))
        warnings.push(`${s.name}: ${f.name} isn't bound to ${s.category} in the kit (bound to ${p.categories.slice(0, 4).join(", ")}${p.categories.length > 4 ? "…" : ""})`);
    }
    for (const x of [...s.filters.map((f) => f.field), ...s.sort.map((o) => o.field)])
      if (!fields.has(x)) problems.push(`${s.name}: ${x} is filtered or sorted on, and isn't one of its fields (add it, hidden if need be)`);
    for (const f of s.filters) if (VALUE_OPS.has(f.op) && f.value === undefined) problems.push(`${s.name}: the filter on ${f.field} (${f.op}) needs a value`);
    if (s.grand_totals && !s.fields.some((f) => f.total)) warnings.push(`${s.name}: grand totals on, and no field has a total`);
    if (!s.itemized && !s.sort.some((o) => o.group)) warnings.push(`${s.name}: not itemized and not grouped: one line for everything`);
  }
  return { problems, warnings };
}
