/**
 * N064 (L001 build plan, 28 Nov 2026): the generator recipe no longer built. FMC_E_EQ_Generator_Diesel_Standby's
 * current recipe (the 6 Nov repair, parametric v2 on planes) uses three recipe-language ops this server didn't know
 * (set_line_weight, envelope, visibility_tier), so fmc_recipe refused it before Revit saw it ("Invalid discriminator
 * value"). Ported from the recipe language of the formcraft plugin (server/src/fmc/recipelang.ts, 5 Nov 2026), these
 * three ops only. Pure: ops in, ops or problems out; no Revit, no files.
 *
 *   set_line_weight   pens (and line colour) of an existing subcategory: the FAM-044 repair path
 *   envelope          the Coarse envelope box between four planes, declared once: expanded to its subcategory, box,
 *                     subcategory assignment and Coarse-only visibility
 *   visibility_tier   one op for the Coarse / Medium / Fine setting of many solids
 *
 * Not ported (no recipe here uses them yet): flex_test and type_catalogue.
 */
import { PENS, role } from "./familygraphics.js";

type R = Record<string, any>;

/** The marker ops.ts splits on (ops.ts WARNING; copied: importing ops.ts here would make a cycle). */
const WARNING = "warning:";

/** The kit rule FAM-044's pens for a subcategory by its name (outline 3/4, detail 2/4, light 1/1). */
export function fam044Pens(subcategory: string): { role: string; projection: number; cut: number } {
  const r = role(subcategory);
  return { role: r, projection: PENS[r].projection, cut: PENS[r].cut };
}

/** Each add_subcategory with the pens and colour the recipe's later set_line_weight gives it (what Revit ends with). */
export function withLineWeights<T>(ops: T[]): T[] {
  const last = new Map<string, R>();
  for (const o of ops as R[]) if (o.op === "set_line_weight") last.set(String(o.name), o);
  if (!last.size) return ops;
  return (ops as R[]).map((o) => {
    const l = o.op === "add_subcategory" ? last.get(String(o.name)) : undefined;
    if (!l) return o;
    return { ...o, ...(l.projection !== undefined ? { line_weight_projection: l.projection } : {}), ...(l.cut !== undefined ? { line_weight_cut: l.cut } : {}),
      ...(l.color ? { color: l.color } : {}), ...(l.keep_graphics ? { keep_graphics: true } : {}) };
  }) as T[];
}

/** Coarse / Medium / Fine for each tier (vis.py V1 to V4; owner ladder 18 to 19 Oct). */
export const TIERS: Record<string, { coarse: boolean; medium: boolean; fine: boolean }> = {
  envelope: { coarse: true, medium: false, fine: false },   // V1: the Coarse box, Coarse only
  clearance: { coarse: true, medium: true, fine: false },   // V2: clearance at Coarse and Medium, hidden at Fine
  body: { coarse: false, medium: true, fine: true },        // the native body (no twins)
  medium: { coarse: false, medium: true, fine: false },     // the native body under Rhino twins
  fine: { coarse: false, medium: false, fine: true },       // twins and Fine-only detail
  all: { coarse: true, medium: true, fine: true },
};

export function tierFlags(o: R): { coarse?: boolean; medium?: boolean; fine?: boolean } {
  const base = o.tier ? TIERS[o.tier] ?? {} : {};
  const own = Object.fromEntries((["coarse", "medium", "fine"] as const).filter((k) => typeof o[k] === "boolean").map((k) => [k, o[k]]));
  return { ...base, ...own };
}

/** envelope and visibility_tier as the ops they stand for; every other op (set_line_weight too) passes through. */
export function expandLanguage<T extends { op: string }>(ops: T[]): T[] {
  const subcats = new Set(ops.filter((o) => o.op === "add_subcategory").map((o) => String((o as unknown as R).name)));
  return ops.flatMap((op) => {
    const o = op as unknown as R;
    if (o.op === "envelope") {
      const sub = String(o.subcategory ?? "Coarse Envelope");
      const out: R[] = [];
      if (!subcats.has(sub)) { subcats.add(sub); out.push({ op: "add_subcategory", name: sub, color: [0, 0, 0], line_weight_projection: PENS.outline.projection, line_weight_cut: PENS.outline.cut }); }
      out.push({ op: "extrusion", name: o.name, rect: o.rect, start: o.start ?? 0, end: o.end ?? 1000,
        ...(o.start_plane ? { start_plane: o.start_plane } : {}), ...(o.end_plane ? { end_plane: o.end_plane } : {}) },
      { op: "set_subcategory", name: o.name, subcategory: sub },
      { op: "set_visibility", name: o.name, ...TIERS.envelope });
      return out as unknown as T[];
    }
    if (o.op === "visibility_tier") return (o.solids as string[]).map((s) => ({ op: "set_visibility", name: s, ...tierFlags(o) })) as unknown as T[];
    return [op];
  });
}

const at = (ops: R[], i: number) => `op ${i + 1} (${ops[i].op} ${ops[i].name})`;

/** The three ops' own rules, on the recipe's ops before expansion. */
export function languageProblems(ops: R[]): string[] {
  const p: string[] = [];
  const envelopes = ops.filter((o) => o.op === "envelope").length;
  let firstEnvelope = true;
  ops.forEach((o, i) => {
    switch (o.op) {
      case "set_line_weight": {
        if (o.projection === undefined && o.cut === undefined && !o.color) p.push(`${at(ops, i)}: give projection, cut or color`);
        if (o.keep_graphics) break;
        const want = fam044Pens(String(o.name));
        if (want.role !== "light" && o.projection !== undefined && o.projection < want.projection)
          p.push(`${at(ops, i)}: pen ${o.projection} on "${o.name}": FAM-044 wants pen ${want.projection} for ${want.role === "outline" ? "outlines" : "parts"} (mark keep_graphics for a deliberate exception)`);
        if (Array.isArray(o.color) && want.role !== "light" && (0.299 * o.color[0] + 0.587 * o.color[1] + 0.114 * o.color[2]) / 255 > 0.45)
          p.push(`${at(ops, i)}: a pale line colour on "${o.name}": FAM-044 lines are black or dark grey; the colour goes on the material`);
        break;
      }
      case "envelope":
        if (new Set(o.rect).size !== 4) p.push(`${at(ops, i)}: the envelope needs four different planes (left, right, front, back)`);
        if (o.start_plane && o.start_plane === o.end_plane) p.push(`${at(ops, i)}: the envelope's bottom and top are on one plane`);
        if (!o.start_plane && !o.end_plane && Number(o.end ?? 1000) <= Number(o.start ?? 0)) p.push(`${at(ops, i)}: end (${o.end}) must be above start (${o.start})`);
        if (envelopes > 1 && !firstEnvelope) p.push(`${at(ops, i)}: one envelope per family`);
        firstEnvelope = false;
        break;
      case "visibility_tier": {
        const f = tierFlags(o);
        const explicit = ["coarse", "medium", "fine"].some((k) => typeof o[k] === "boolean");
        if (o.tier && explicit) p.push(`${WARNING} ${at(ops, i)}: tier ${o.tier} and explicit levels both given: the explicit levels win`);
        if (!o.tier && !explicit) p.push(`${at(ops, i)}: give a tier or coarse / medium / fine`);
        else if (f.coarse === false && f.medium === false && f.fine === false) p.push(`${at(ops, i)}: every level off: Revit refuses a solid hidden at every detail level`);
        if (new Set(o.solids).size !== o.solids.length) p.push(`${at(ops, i)}: a solid is named twice`);
        break;
      }
    }
  });
  return p;
}
