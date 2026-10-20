/**
 * Families made from a picture (owner 20 Oct; kit FMC_Rulebook_Rhino.json RHN-020 to RHN-024).
 *
 * <family>.reference.json (fmc-reference/0.1), beside the recipe: what the family must look like and the real-life
 * evidence for it, found by searching the product's name: catalogue, datasheet, listing, standard or maker sources;
 * views (front, side, top, iso) with where each came from; dimensions with their source status; each material with its
 * evidence; and the signature features a viewer recognises the product by. A view generated or traced by AI is kind
 * "generated": it may guide modelling but never counts as evidence.
 *
 * <family>.likeness.json (fmc-likeness/0.1): the comparison rounds. Each round compares every reference view with the
 * same view of the model (from "rhino" before the Revit build, "revit" before release): the outline overlap (IoU) and
 * width/height ratio from scripts/likeness/compare.py, and a reviewer who didn't build the family marks each feature
 * present or missing. Gate A reads the last round.
 */
import type { GateLine } from "./recipes.js";
import type { RhinoRulebook } from "../hub/rhino.js";

export const EVIDENCE_KINDS = ["catalogue", "datasheet", "listing", "standard", "maker", "photo"];

export interface Reference {
  family: string;
  sources?: Array<{ url: string; kind: string; title?: string; fetched?: boolean }>;
  views?: Array<{ view: string; image: string; kind?: string; source?: string }>;
  dimensions?: Record<string, { value: number | string; source_status: string; source?: string }>;
  materials?: Array<{ part: string; material: string; evidence?: string; kit_material?: string }>;
  features?: Array<{ name: string; parts?: string[] }>;
}

export interface LikenessRound {
  round: number; at?: string; from: "rhino" | "revit";
  views?: Array<{ view: string; iou?: number | null; aspect_diff?: number | null; note?: string }>;
  features?: Array<{ name: string; present: boolean; note?: string }>;
  reviewer?: { who: string; blind: boolean };
}
export interface Likeness { family: string; rounds: LikenessRound[] }

export const REFERENCE_CHECK = "Reference evidence (views, sources, materials, features)";
export const LIKENESS_CHECK = "Looks like the reference";

/** RHN-020, RHN-021: enough real-life evidence to model from; generated views don't count. */
export function referenceLine(ref: Reference | null, book: RhinoRulebook | null): GateLine {
  if (!ref) return { check: REFERENCE_CHECK, state: "Not checked", detail: "No <family>.reference.json: the family wasn't made from a picture" };
  if (!book) return { check: REFERENCE_CHECK, state: "Fail", detail: "No Rhino rulebook in the kit (FMC_Rulebook_Rhino.json), so the evidence can't be judged: a kit change request" };
  const r = book.reference;
  const why: string[] = [];
  const realViews = (ref.views ?? []).filter((v) => v.kind !== "generated");
  const sources = (ref.sources ?? []).filter((s) => s.fetched && EVIDENCE_KINDS.includes(s.kind) && s.kind !== "photo");
  const verified = Object.entries(ref.dimensions ?? {}).filter(([, d]) => d.source_status === "verified" && d.source);
  const noEvidence = (ref.materials ?? []).filter((m) => !m.evidence);
  const features = ref.features ?? [];
  if (realViews.length < r.min_views) why.push(`${realViews.length} real views of ${r.min_views} (generated views don't count)`);
  if (sources.length < r.min_sources) why.push(`${sources.length} fetched catalogue, datasheet, listing, standard or maker sources of ${r.min_sources}`);
  if (verified.length < r.min_verified_dimensions) why.push(`${verified.length} verified dimensions of ${r.min_verified_dimensions}`);
  if (r.material_evidence && (!(ref.materials ?? []).length || noEvidence.length))
    why.push((ref.materials ?? []).length ? `no evidence for ${noEvidence.map((m) => `${m.part} (${m.material})`).join(", ")}` : "no materials listed");
  if (features.length < r.min_features) why.push(`${features.length} signature features of ${r.min_features}`);
  return { check: REFERENCE_CHECK, state: why.length ? "Fail" : "Pass",
    detail: why.length ? why.join("; ") : `${realViews.length} views, ${sources.length} sources, ${verified.length} verified dimensions, ${features.length} features` };
}

/**
 * RHN-022 to RHN-024: the last round must come from the Revit family (before release), match every reference view
 * the rulebook lists, and have every feature marked present by a blind reviewer. A view whose IoU couldn't be measured
 * (a room photo, not a clean catalogue view) leaves that view to the reviewer, and says so.
 */
export function likenessLine(ref: Reference | null, like: Likeness | null, book: RhinoRulebook | null, stage: "rhino" | "revit" = "revit"): GateLine {
  if (!ref) return { check: LIKENESS_CHECK, state: "Not checked", detail: "No reference: the family wasn't made from a picture" };
  if (!book) return { check: LIKENESS_CHECK, state: "Fail", detail: "No Rhino rulebook in the kit (FMC_Rulebook_Rhino.json): a kit change request" };
  const k = book.likeness;
  const rounds = (like?.rounds ?? []).filter((r) => r.from === stage || stage === "rhino");
  const last = rounds[rounds.length - 1];
  if (!last) return { check: LIKENESS_CHECK, state: "Fail", detail: `Not compared from ${stage} yet: render the model's views and run scripts/likeness/compare.py, then a blind review` };
  const why: string[] = [], notes: string[] = [];
  // generated views guide modelling only (RHN-021): the reviewer judges them, the outline check doesn't
  const refViews = new Set((ref.views ?? []).filter((v) => k.views.includes(v.view) && v.kind !== "generated").map((v) => v.view));
  for (const view of refViews) {
    const v = (last.views ?? []).find((x) => x.view === view);
    if (!v) { why.push(`${view} not compared`); continue; }
    if (v.iou == null) { notes.push(`${view}: outline not measurable${v.note ? ` (${v.note})` : ""}, judged by the reviewer`); continue; }
    if (v.iou < k.min_iou) why.push(`${view} outline overlap ${v.iou.toFixed(2)} < ${k.min_iou}`);
    if (v.aspect_diff != null && Math.abs(v.aspect_diff) > k.max_aspect_diff) why.push(`${view} proportions off by ${(Math.abs(v.aspect_diff) * 100).toFixed(0)}% (limit ${(k.max_aspect_diff * 100).toFixed(0)}%)`);
  }
  const marked = new Map((last.features ?? []).map((f) => [f.name, f]));
  const missing = (ref.features ?? []).filter((f) => !marked.get(f.name)?.present).map((f) => f.name);
  if (k.all_features && missing.length) why.push(`features missing or not reviewed: ${missing.join(", ")}`);
  if (k.blind_reviewer && !last.reviewer?.blind) why.push("no blind review (a reviewer who didn't build the family)");
  if (why.length && rounds.length >= k.max_rounds)
    why.push(`${rounds.length} rounds without a match: stop and give it to a person with the renders and scores (RHN-024)`);
  const head = `round ${last.round} from ${last.from}`;
  return { check: LIKENESS_CHECK, state: why.length ? "Fail" : "Pass",
    detail: `${head}: ${why.length ? why.join("; ") : `every view and all ${(ref.features ?? []).length} features match`}${notes.length ? `; ${notes.join("; ")}` : ""}` };
}
