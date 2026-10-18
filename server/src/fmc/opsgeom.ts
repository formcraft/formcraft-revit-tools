/**
 * F-064 check rules (QG5): geometry Revit refuses in the middle of a build, caught by fmc_recipe check before Revit opens.
 * Every number here comes from a build that failed overnight on 17–18 Oct:
 * - a dimension between planes closer than about 1.5 mm, and a sketch edge shorter than Revit's short-curve tolerance
 *   (0.78 mm), fail;
 * - lock_face needs a face exactly on the plane: a solid drawn 0.6 mm off a reused plane failed "no face of X lies on Y".
 */
import type { Op } from "./ops.js";

/** Revit can't dimension two planes closer than this (mm). */
export const MIN_DIMENSION_MM = 1.5;
/** Revit can't draw a sketch edge shorter than this (mm): Application.ShortCurveTolerance, 0.00256 ft. Door stops round their
 * corners with 0.785 mm segments and build, so this is Revit's own value, not F-064's rounded 0.8 mm. */
export const MIN_EDGE_MM = 0.00256 * 304.8;
/** A face is on a plane when both ends of its edge are this close (mm). */
export const ON_PLANE_MM = 0.01;
/** A face this close to a plane, but not on it, was meant to lie on it (mm). */
export const NEAR_PLANE_MM = 1.0;

/** The marker ops.ts splits on: a problem passed on as a note, not an error (ops.ts WARNING). */
const WARN = "warning:";

type Pt = [number, number];
interface Plane { name: string; view: string; from: Pt; to: Pt }

const isPlan = (view?: string) => {
  const v = (view ?? "Ref. Level").trim().toLowerCase();
  return v === "ref. level" || v === "plan" || v.includes("level");
};
const isElevation = (view?: string) => !isPlan(view);
const fmt = (mm: number) => (mm < 0.1 ? mm.toFixed(3) : mm.toFixed(2)).replace(/\.?0+$/, "");

function distToLine(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dx * (a[1] - p[1]) - dy * (a[0] - p[0])) / len;
}

function parallel(a: Plane, b: Plane): boolean {
  const ax = a.to[0] - a.from[0], ay = a.to[1] - a.from[1], bx = b.to[0] - b.from[0], by = b.to[1] - b.from[1];
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (!la || !lb) return false;
  return Math.abs(ax * by - ay * bx) / (la * lb) < 1e-6;
}

/** Edges of a closed outline, as [from, to] pairs (the last point joins the first). */
function edges(points: Pt[], closed = true): Array<[Pt, Pt]> {
  const out: Array<[Pt, Pt]> = [];
  for (let k = 0; k + 1 < points.length; k++) out.push([points[k], points[k + 1]]);
  if (closed && points.length > 2) out.push([points[points.length - 1], points[0]]);
  return out;
}

function shortEdges(points: unknown, closed: boolean): string[] {
  if (!Array.isArray(points)) return [];
  const pts = points.filter((p): p is Pt => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "number"));
  const p: string[] = [];
  edges(pts, closed).forEach(([a, b], k) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > 0 && len < MIN_EDGE_MM)
      p.push(`${WARN} edge ${k + 1} (${a.join(", ")} to ${b.join(", ")}) is ${fmt(len)} mm, under Revit's ${fmt(MIN_EDGE_MM)} mm short-curve tolerance. ` +
        "Outlines like this usually build (88 of the 17–18 Oct batch did), but merge the points if Revit refuses it");
  });
  return p;
}

/**
 * The F-064 geometry rules for one batch. Planes are compared only when both are drawn in this batch, in the same kind
 * of view (plan or elevation); a plane the template brings has no coordinates here and is left to Revit.
 */
export function geometryProblems(ops: Op[]): string[] {
  const p: string[] = [];
  const planes = new Map<string, Plane>();
  const solids = new Map<string, Record<string, any>>();
  // a plane a labelled dimension drives moves when the family regenerates, so its drawn position isn't final
  const driven = new Set<string>();
  ops.forEach((op, i) => {
    const o = op as Record<string, any>;
    const at = `op ${i + 1} (${o.op} ${o.name})`;
    switch (o.op) {
      case "add_ref_plane":
        planes.set(o.name, { name: o.name, view: o.view ?? "Ref. Level", from: o.from, to: o.to });
        break;
      case "extrusion":
      case "void_extrusion": {
        for (const x of shortEdges(o.points, true)) p.push(`${at}: ${x}`);
        // F-064: a solid thinner than the short-curve tolerance has edges Revit can't draw; it fails as it's made
        const depth = Math.abs(Number(o.end ?? 1000) - Number(o.start ?? 0));
        if (depth > 0 && depth < MIN_EDGE_MM)
          p.push(`${at}: start ${o.start ?? 0} and end ${o.end ?? 1000} make it ${fmt(depth)} mm thick, under Revit's ${fmt(MIN_EDGE_MM)} mm short-curve tolerance: ` +
            "Revit refuses it. Make it at least 0.8 mm (or leave the part out at this size)");
        solids.set(o.name, o);
        break;
      }
      case "sweep":
      case "void_sweep":
        for (const x of shortEdges(o.profile, true)) p.push(`${at}: profile ${x}`);
        for (const x of shortEdges(o.path, false)) p.push(`${at}: path ${x}`);
        solids.set(o.name, o);
        break;
      case "revolution":
        for (const x of shortEdges(o.profile, true)) p.push(`${at}: profile ${x}`);
        solids.set(o.name, o);
        break;
      case "add_eq_dimension":
        for (const n of o.planes ?? []) driven.add(n);
        break;
      case "add_dimension": {
        if (o.label) for (const n of o.between ?? []) driven.add(n);
        const [a, b] = (o.between ?? []).map((n: string) => planes.get(n));
        if (!a || !b || isPlan(a.view) !== isPlan(b.view) || !parallel(a, b)) break;
        const gap = distToLine(b.from, a.from, a.to);
        if (gap < MIN_DIMENSION_MM)
          p.push(`${at}: "${a.name}" and "${b.name}" are ${fmt(gap)} mm apart: Revit can't dimension planes closer than ${MIN_DIMENSION_MM} mm. ` +
            (gap < ON_PLANE_MM ? "They lie on one line: use one plane" : "Use one plane, or move one at least 1.5 mm"));
        break;
      }
      case "lock_face": {
        // Revit can lock only a face that lies exactly on the plane; if none does, the op fails at any distance
        const s = solids.get(o.solid), pl = planes.get(o.plane);
        if (!s || !pl) break; // a template's plane or an earlier file's solid: Revit decides
        // the engine regenerates before it locks: a dimension-driven plane may have moved onto the face by then
        const lead = driven.has(o.plane) ? `${WARN} ` : "";
        const sketchedInPlan = !s.view || isPlan(s.view);
        if ((o.view ?? "plan") === "plan" && isPlan(pl.view) && sketchedInPlan && Array.isArray(s.points) && !s.rect) {
          const d = edges(s.points as Pt[]).map(([a, b]) => Math.max(distToLine(a, pl.from, pl.to), distToLine(b, pl.from, pl.to)));
          if (d.some((x) => x <= ON_PLANE_MM)) break;
          const near = Math.min(...d);
          p.push(`${at}: ${lead}no edge of "${o.solid}" lies on "${o.plane}" (the nearest is ${fmt(near)} mm off), so Revit has no face to lock. ` +
            (near <= NEAR_PLANE_MM ? "Snap the outline's points to the plane" : "Lock it to the plane its side is drawn on"));
        } else if (o.view === "front" && isElevation(pl.view) && pl.from[1] === pl.to[1] && sketchedInPlan && (s.op === "extrusion" || s.op === "void_extrusion")) {
          const level = pl.from[1];
          const ends = [Number(s.start ?? 0), Number(s.end ?? 1000)];
          const d = ends.map((z) => Math.abs(z - level));
          if (d.some((x) => x <= ON_PLANE_MM)) break;
          const near = Math.min(...d);
          p.push(`${at}: ${lead}neither end of "${o.solid}" (${ends.join(" and ")} mm) is on "${o.plane}" (${level} mm; the nearest is ${fmt(near)} mm off), ` +
            "so Revit has no face to lock. " + (near <= NEAR_PLANE_MM ? "Set start or end to the plane's height" : "Lock it to the plane at its start or end height, or use end_plane"));
        }
        break;
      }
    }
  });
  return p;
}

/** Parameters every family has, so a recipe may set them without adding them (seen in all 536 recipes, 18 Oct). */
export const BUILTIN_PARAMS = new Set(["Keynote", "Description", "URL", "Model", "Manufacturer", "Type Comments", "Cost", "Assembly Code",
  "Type Mark", "OmniClass Number", "OmniClass Title", "Default Elevation"]);
/** Parameters the door and window templates bring. */
export const OPENING_PARAMS = new Set(["Width", "Height", "Thickness", "Rough Width", "Rough Height", "Sill Height"]);
export const isOpeningTemplate = (template?: string) => /\bmetric (door|window)\b/i.test(template ?? "");

// ---- F-061: does the template host the way the register says? ---------------------------------------------------------

/** How a template places: a host face, a particular host, or unhosted. Read from the template's name. */
export function templateHosting(template: string): "face" | "wall" | "ceiling" | "floor" | "roof" | "none" {
  const t = template.toLowerCase();
  if (/face based/.test(t)) return "face";
  if (/wall based/.test(t) || /\bmetric (door|window)\b/.test(t)) return "wall";
  if (/ceiling based/.test(t)) return "ceiling";
  if (/floor based/.test(t)) return "floor";
  if (/roof based/.test(t)) return "roof";
  return "none";
}

/**
 * What the register's Host asks of the template: null when an unhosted template is fine (Level, Floor, Work plane, View,
 * pipes, ducts, or a choice that includes one of those). Otherwise the hostings that satisfy it.
 */
export function hostNeeds(host: string): Array<"face" | "wall" | "ceiling" | "floor" | "roof"> | null {
  const alts = host.toLowerCase().split(/\s*(?:\/|,|\bor\b)\s*/).map((a) => a.trim()).filter(Boolean);
  if (!alts.length || alts.includes("-")) return null;
  const need = (a: string): Array<"face" | "wall" | "ceiling" | "floor" | "roof"> | null => {
    if (/void|curtain|panel|nested|bracket|top|board|rack|stand|plinth|pole/.test(a)) return null;
    if (/\bface\b/.test(a)) {
      if (/^wall face$/.test(a) || /door frame face/.test(a)) return ["face", "wall"];
      if (/^ceiling face$/.test(a)) return ["face", "ceiling"];
      if (/^floor face$/.test(a)) return ["face", "floor"];
      if (/^roof face$/.test(a)) return ["face", "roof"];
      return ["face"];
    }
    if (a === "wall") return ["face", "wall"];
    if (a === "ceiling") return ["face", "ceiling"];
    if (a === "roof") return ["face", "roof"];
    return null; // level, floor, work plane, view, pipe, duct, toposolid, line based, …
  };
  const each = alts.map(need);
  if (each.some((n) => n === null)) return null; // one choice is unhosted: an unhosted template is fine
  // every choice is hosted: only a hosting that serves all of them will do (two different hosts: face based)
  return (["face", "wall", "ceiling", "floor", "roof"] as const).filter((h) => each.every((n) => n!.includes(h)));
}

/** F-061 #3: a warning when the register's Host needs a hosted template and the recipe names one that can't host. */
export function hostTemplateProblem(family: string, template: string, host: string | null): string | null {
  if (!host) return null;
  const needs = hostNeeds(host);
  if (!needs) return null;
  const has = templateHosting(template);
  if (needs.includes(has as any)) return null;
  const want = needs.includes("face") ? "a face based template (e.g. Metric Generic Model face based.rft), which hosts on walls and ceilings, linked ones too" : `a ${needs[0]} based template`;
  return `${family}: the register's host is "${host}", but ${template} ${has === "none" ? "is unhosted" : `hosts on a ${has}`}, ` +
    `so it can't be placed there (F-061). Use ${want}`;
}
