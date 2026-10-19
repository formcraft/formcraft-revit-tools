/**
 * Clashes back to Revit (hub step H3): each clash item's Revit element, found through the hub's identity map, then handed
 * over as Mark & Review tickets or review clouds. Plus the plan_hash a person's yes is tied to for clash statuses.
 * Pure: the map, the clash rows and the register in; the resolved rows and plans out.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { IdentityMap, findFmc, link, newFmcId } from "../hub/exchange.js";
import type { Register } from "./review.js";
import type { ClashIn, ClashItemIn } from "./tickets.js";

const win = path.win32;
const UNIQUE_ID = /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}-[0-9a-f]{8}$/i;

/** A model's stem without extension, lower case: "D:\P\F26001-FMC-ZZ-ZZ-M3-S-0001.nwc" → "f26001-fmc-zz-zz-m3-s-0001". */
export const modelStem = (file: string) => win.basename(file || "", win.extname(file || "")).toLowerCase();

/** Same model: the stems agree, or one is a workshared local copy of the other ("<central>_<user>"). */
export function sameModel(a: string, b: string): boolean {
  const x = modelStem(a), y = modelStem(b);
  return !!x && !!y && (x === y || x.startsWith(y + "_") || y.startsWith(x + "_"));
}

export interface NavisClashItem extends ClashItemIn { guid?: string }
export interface NavisClashRow extends ClashIn { item1: NavisClashItem; item2: NavisClashItem }

/** Navisworks gives many items an empty instance GUID: that is no id. */
const guidOf = (it: NavisClashItem) => (it.guid && !/^[0-]+$/.test(it.guid) ? it.guid : "");

function lookup(map: IdentityMap, it: NavisClashItem): string | null {
  const g = guidOf(it);
  if (g) { const f = findFmc(map, "navisworks", g); if (f) return f; }
  if (!it.revit_id) return null;
  for (const e of Object.values(map.entries)) {
    const r = e.apps.revit;
    if (r && r.id === it.revit_id && (!r.file || sameModel(r.file, it.source))) return e.fmc;
  }
  return null;
}

/**
 * Fills each item's Formcraft id and Revit UniqueId from the identity map. With record, an item the map doesn't know
 * yet is linked (its Navisworks item to its Revit element id in that model), so the next exchange finds it.
 */
export function resolveClashItems(map: IdentityMap, rows: NavisClashRow[], opts: { record: boolean; at?: string }) {
  let known = 0, linked = 0, unknown = 0, noRevit = 0;
  const one = (it: NavisClashItem): NavisClashItem => {
    if (!it?.revit_id) { noRevit++; return it; }
    let fmc = lookup(map, it);
    if (fmc) known++;
    else if (opts.record) {
      // A new entry, never link(): element ids repeat between models, and link() matches by id alone.
      fmc = newFmcId();
      map.entries[fmc] = { fmc, ...(it.category ? { kind: it.category } : {}), ...(it.name ? { name: it.name } : {}),
        apps: { revit: { id: it.revit_id, file: win.basename(it.source || ""), at: opts.at ?? new Date().toISOString() } } };
      linked++;
    } else unknown++;
    if (fmc && opts.record && guidOf(it)) link(map, "navisworks", guidOf(it), { fmc, file: win.basename(it.source || ""), at: opts.at });
    const rid = fmc ? map.entries[fmc]?.apps.revit?.id ?? "" : "";
    return { ...it, ...(fmc ? { fmc } : {}), ...(UNIQUE_ID.test(rid) ? { unique_id: rid } : {}) };
  };
  const out = rows.map((r) => ({ ...r, item1: one(r.item1), item2: one(r.item2) }));
  return { rows: out, known, linked, unknown, without_revit_id: noRevit };
}

/** The newest results: the named test, or the test run most recently. */
export function newestTest(tests: Array<{ name: string; last_run?: string }>, named = ""): string {
  if (named.trim()) return named.trim();
  return [...tests].filter((t) => t.last_run).sort((a, b) => String(b.last_run).localeCompare(String(a.last_run)))[0]?.name ?? "";
}

/**
 * Which clash tickets of a test get a review cloud in the Revit model open now: those without a cloud whose clash has an
 * element from that model. Each gets that model's element ids (a cloud is drawn around elements of the open model only).
 */
export function cloudPlan(reg: Register, test: string, revitModel: string, limit = 50) {
  const rows: Array<{ id: string; title: string; element_ids: number[] }> = [];
  let clouded = 0, otherModel = 0;
  for (const i of reg.items) {
    const c = i.links?.clash;
    if (!c || c.test !== test || i.status === "Closed") continue;
    if (i.cloud) { clouded++; continue; }
    const ids = (c.items ?? []).filter((x) => sameModel(x.model, revitModel)).map((x) => Number(x.id)).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) { otherModel++; continue; }
    rows.push({ id: i.id, title: i.title, element_ids: [...new Set(ids)] });
  }
  return { tickets: rows.slice(0, limit), more: Math.max(0, rows.length - limit), already_clouded: clouded, in_other_models: otherModel };
}

/** The plan a person says yes to for a status change: same test, names, status and comment, same hash. */
export function statusHash(test: string, names: string[], status: string, comment: string): string {
  const canon = JSON.stringify([test.trim().toLowerCase(), [...new Set(names.map((n) => n.trim()))].sort(), status.trim().toLowerCase(), comment.trim()]);
  return createHash("sha256").update(canon).digest("hex").slice(0, 12);
}

/** Never the AI: a status change on a clash is a coordination decision a person makes (rule 5). */
export const NOT_A_PERSON = /^(ai|ai modeller|claude.*|assistant|bot|mcp|auto.*|system)$/i;
