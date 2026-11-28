/**
 * One selection across the apps (docs/PLAN_ENGINEERING_HUB.md, X1): select a column in Revit and it is shown in
 * Navisworks, Rhino and Robot, and the other way round. Each app names an element its own way; a "pick" carries every
 * name we know for one element, and the identity map (exchange.ts) fills in the rest:
 *   Revit       UniqueId, or element id + model (what a Navisworks item knows)
 *   Navisworks  the Revit Element ID and source model it came from, or its instance GUID
 *   Rhino       the object's id, or its user text fmc.id (the Formcraft id)
 *   Robot       <run>#<bar>, the run being the .rtd's name
 * Pure: the tool asks the apps and hands their answers to these functions.
 */
import path from "node:path";
import { byOrder, candidates, type IdentityMap } from "./exchange.js";

export const SELECT_APPS = ["revit", "navisworks", "rhino", "robot"] as const;
export type SelectApp = (typeof SELECT_APPS)[number];

export interface Pick {
  fmc?: string;
  name?: string;
  category?: string;
  revit?: { unique_id?: string; element_id?: string; model?: string };
  navisworks?: { guid?: string };
  rhino?: { id?: string };
  robot?: { run: string; bar: number };
}

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const isNum = (s: string) => /^\d+$/.test(s);
/** A model's name without folders and extension, the way both Revit titles and Navisworks source files can be compared. */
export const modelName = (s: string) => path.win32.basename(s || "").replace(/\.(rvt|nwc|nwd|nwf|ifc)$/i, "");
const sameModel = (a: string, b: string) => {
  const x = modelName(a).toLowerCase(), y = modelName(b).toLowerCase();
  return !x || !y || x.startsWith(y) || y.startsWith(x);
};

/** One line naming a pick for a person: its Formcraft name or id, else the first app id we have. */
export function label(p: Pick): string {
  return p.name || p.fmc || p.revit?.unique_id || (p.revit?.element_id ? `${modelName(p.revit.model ?? "")}#${p.revit.element_id}` : "") ||
    p.navisworks?.guid || p.rhino?.id || (p.robot ? `${p.robot.run}#${p.robot.bar}` : "") || "?";
}

// ---- an app's selection → picks ------------------------------------------------------------------------------------

export function picksFromRevit(reply: any): Pick[] {
  const one = (e: any, model: string): Pick => ({ name: str(e.mark) || undefined, category: str(e.category) || undefined,
    revit: { unique_id: str(e.unique_id) || undefined, element_id: str(e.element_id) || undefined, model: str(e.model) || model } });
  return [...(reply?.elements ?? []).map((e: any) => one(e, str(reply?.model))), ...(reply?.linked ?? []).map((e: any) => one(e, str(e.link)))];
}

export function picksFromNavis(reply: any): Pick[] {
  return (reply?.items ?? reply?.found ?? []).map((i: any) => ({
    category: str(i.category) || undefined,
    revit: str(i.revit_id) ? { element_id: str(i.revit_id), model: str(i.source) } : undefined,
    navisworks: str(i.guid) ? { guid: str(i.guid) } : undefined,
  }));
}

export function picksFromRhino(reply: any): Pick[] {
  return (reply?.objects ?? reply?.found ?? []).map((o: any) => ({
    fmc: str(o.user_text?.["fmc.id"]) || undefined, name: str(o.name) || undefined, rhino: { id: str(o.id) },
  }));
}

export function picksFromRobot(reply: any): Pick[] {
  const run = str(reply?.run);
  return (reply?.bars ?? []).map((b: unknown) => ({ robot: { run, bar: Number(b) } }));
}

/**
 * Ids a person typed for the `from` app: Revit UniqueIds or element ids, Navisworks "<model>#<element id>" or GUIDs,
 * Rhino object ids, Robot "<run>#<bar>"; a Formcraft id (FMC-…) works for every app.
 */
export function picksFromIds(from: SelectApp, ids: string[]): Pick[] {
  return ids.map((raw) => raw.trim()).filter(Boolean).map((id): Pick => {
    if (/^FMC-/i.test(id)) return { fmc: id };
    const hash = id.lastIndexOf("#");
    switch (from) {
      case "revit": return { revit: isNum(id) ? { element_id: id } : { unique_id: id } };
      case "navisworks":
        if (hash > 0 && isNum(id.slice(hash + 1))) return { revit: { element_id: id.slice(hash + 1), model: id.slice(0, hash) } };
        return isNum(id) ? { revit: { element_id: id } } : { navisworks: { guid: id } };
      case "rhino": return { rhino: { id } };
      case "robot": return hash > 0 ? { robot: { run: id.slice(0, hash), bar: Number(id.slice(hash + 1)) } } : { robot: { run: "", bar: Number(id) } };
    }
  });
}

// ---- the identity map fills in the other apps --------------------------------------------------------------------

/** The Formcraft id of a pick, from any of its app ids. */
export function fmcOf(map: IdentityMap, p: Pick): string | null {
  if (p.fmc && map.entries[p.fmc]) return p.fmc;
  // owner 27 Oct, speed: only the entries the reverse index names for this pick's ids, earliest first (as the scan was)
  const near = new Set<string>([
    ...(p.revit?.unique_id ? candidates(map, "revit", p.revit.unique_id) : []),
    ...(p.revit?.element_id ? candidates(map, "revit", p.revit.element_id) : []),
    ...(p.navisworks?.guid ? candidates(map, "navisworks", p.navisworks.guid) : []),
    ...(p.rhino?.id ? candidates(map, "rhino", p.rhino.id) : []),
    ...(p.robot ? candidates(map, "robot", `${p.robot.run}#${p.robot.bar}`) : []),
  ]);
  for (const e of byOrder(map, near).map((f) => map.entries[f])) {
    const a = e.apps;
    if (p.revit?.unique_id && a.revit?.id === p.revit.unique_id) return e.fmc;
    // a Revit element linked by its id (no UniqueId known), in the same model
    if (p.revit?.element_id && a.revit?.id === p.revit.element_id && sameModel(a.revit.file ?? "", p.revit.model ?? "")) return e.fmc;
    if (p.navisworks?.guid && a.navisworks?.id.toLowerCase() === p.navisworks.guid.toLowerCase()) return e.fmc;
    if (p.rhino?.id && a.rhino?.id.toLowerCase() === p.rhino.id.toLowerCase()) return e.fmc;
    if (p.robot && a.robot?.id === `${p.robot.run}#${p.robot.bar}`) return e.fmc;
  }
  return null;
}

/** Each pick with its Formcraft id and every app id the map knows for it (what the pick already had wins). */
export function enrich(map: IdentityMap, picks: Pick[]): Pick[] {
  return picks.map((p) => {
    const fmc = fmcOf(map, p);
    if (!fmc) return p;
    const e = map.entries[fmc], a = e.apps, out: Pick = { ...p, fmc, name: p.name ?? e.name, category: p.category ?? e.kind };
    if (a.revit && !p.revit?.unique_id) {
      const id = a.revit.id;
      out.revit = { ...p.revit, ...(isNum(id) ? { element_id: p.revit?.element_id ?? id } : { unique_id: id }), model: p.revit?.model || a.revit.file || "" };
    }
    if (a.navisworks && !p.navisworks?.guid) out.navisworks = { guid: a.navisworks.id };
    if (a.rhino && !p.rhino?.id) out.rhino = { id: a.rhino.id };
    if (a.robot && !p.robot) {
      const h = a.robot.id.lastIndexOf("#");
      if (h > 0) out.robot = { run: a.robot.id.slice(0, h), bar: Number(a.robot.id.slice(h + 1)) };
    }
    return out;
  });
}

/** Revit's answer (found elements) fills in the UniqueId, element id and model of the picks it matched. */
export function mergeRevit(picks: Pick[], found: any[]): Pick[] {
  // owner 27 Oct, speed: Revit's answer indexed once, not searched again for every pick
  const byUid = new Map<string, any>(), byEid = new Map<string, any[]>();
  for (const x of found) {
    if (str(x.unique_id) && !byUid.has(str(x.unique_id))) byUid.set(str(x.unique_id), x);
    const k = str(x.element_id); if (k) (byEid.get(k) ?? byEid.set(k, []).get(k)!).push(x);
  }
  return picks.map((p) => {
    const u = p.revit?.unique_id ? byUid.get(p.revit.unique_id) : undefined;
    const ei = p.revit?.element_id ? (byEid.get(p.revit.element_id) ?? []).find((x) => sameModel(str(x.model), p.revit!.model ?? "")) : undefined;
    const f = u && ei ? (found.indexOf(u) < found.indexOf(ei) ? u : ei) : u ?? ei;
    if (!f) return p;
    return { ...p, name: p.name ?? (str(f.mark) || undefined), category: p.category ?? (str(f.category) || undefined),
      revit: { unique_id: str(f.unique_id), element_id: str(f.element_id), model: str(f.model) } };
  });
}

// ---- what to ask each app ----------------------------------------------------------------------------------------

export function revitRequest(picks: Pick[]) {
  const unique_ids = [...new Set(picks.map((p) => p.revit?.unique_id).filter((x): x is string => !!x))];
  const element_ids = picks.filter((p) => !p.revit?.unique_id && p.revit?.element_id).map((p) => ({ id: p.revit!.element_id!, model: p.revit!.model ?? "" }));
  return { unique_ids, element_ids };
}

export function navisRequest(picks: Pick[]) {
  const items = picks.filter((p) => p.revit?.element_id).map((p) => ({ revit_id: p.revit!.element_id!, source: p.revit!.model ?? "" }));
  const guids = picks.filter((p) => !p.revit?.element_id && p.navisworks?.guid).map((p) => p.navisworks!.guid!);
  return { items, guids };
}

export function rhinoRequest(picks: Pick[]) {
  const ids = picks.map((p) => p.rhino?.id).filter((x): x is string => !!x);
  const values = picks.filter((p) => !p.rhino?.id && p.fmc).map((p) => p.fmc!);
  return { ids, key: "fmc.id", values };
}

/** Robot shows one run at a time: the bars grouped by run, the biggest group first. */
export function robotRequests(picks: Pick[]): Array<{ run: string; bars: number[] }> {
  const runs = new Map<string, number[]>();
  for (const p of picks) if (p.robot && Number.isInteger(p.robot.bar)) runs.set(p.robot.run, [...(runs.get(p.robot.run) ?? []), p.robot.bar]);
  return [...runs.entries()].map(([run, bars]) => ({ run, bars: [...new Set(bars)] })).sort((a, b) => b.bars.length - a.bars.length);
}

/** The picks an app can't be asked about: nothing in the pick or the identity map names them there. */
export function unmapped(picks: Pick[], app: SelectApp): string[] {
  const has = (p: Pick) => app === "revit" ? !!(p.revit?.unique_id || p.revit?.element_id)
    : app === "navisworks" ? !!(p.revit?.element_id || p.navisworks?.guid)
    : app === "rhino" ? !!(p.rhino?.id || p.fmc)
    : !!p.robot;
  return picks.filter((p) => !has(p)).map(label);
}
