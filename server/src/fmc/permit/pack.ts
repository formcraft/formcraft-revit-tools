/** Drawing pack checks (UG-BCR-2020 regs 9 and 13): listed sheets present, viewport scales, a use for every room. */
import { field, parseScales, scaleAllowed, strings } from "./bank.js";
import type { PermitFacts } from "./facts.js";
import type { Ctx, Finding } from "./finding.js";
import { citeFor, make, missing } from "./finding.js";
import { ruleById } from "./rules.js";

/** Name patterns for the sheets the Regulations list. Formcraft's matching words; an unknown item matches its own first words. */
const SHEET_WORDS: Array<[RegExp, RegExp]> = [
  [/location/i, /\blocation\b/i],
  [/context|block/i, /\bcontext\b|\bblock plan\b/i],
  [/site plan/i, /\bsite (plan|layout)\b/i],
  [/floor plan/i, /\bfloor plan|\b(ground|first|second|third|fourth|upper|lower|basement|roof) (floor|level)\b|\blevel \d+\b.*plan|\bplan\b.*\blevel\b/i],
  [/elevation/i, /\belevation/i],
  [/section/i, /\bsection/i],
  [/door.*window|window.*door/i, /\b(door|window)s?\b.*\bschedule|\bschedule\b.*\b(door|window)/i],
  [/drainage/i, /\bdrainage|\bfoul\b|\bstorm\b|\bsewer|\bwaste water/i],
  [/boundary/i, /\bboundary\b/i],
];

export function sheetPattern(item: string): RegExp {
  for (const [key, re] of SHEET_WORDS) if (key.test(item)) return re;
  const words = item.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).slice(0, 2);
  return new RegExp(words.map((w) => `\\b${w}`).join(".*"), "i");
}

export type ViewKind = "site" | "layouts" | "sections_elevations" | "other";

/** The kind of a placed view, from its name (Phase A has no view type: an assumption the report states). */
export function viewKind(name: string): ViewKind {
  if (/\bsite\b|\blocation\b|\bblock plan\b|\bcontext\b/i.test(name)) return "site";
  if (/\bsection|\belevation/i.test(name)) return "sections_elevations";
  if (/\bplan\b|\blayout\b|\bfloor\b|\blevel\b|\bceiling\b/i.test(name)) return "layouts";
  return "other";
}

export function evaluatePack(ctx: Ctx, f: PermitFacts): Finding[] {
  const out: Finding[] = [];
  const arch = citeFor(ctx, ruleById("PACK.arch_set"), "drawings.architectural_set");

  // reg 9: each listed sheet is found by sheet name or by the name of a view placed on it.
  if (!arch.found) out.push(missing(ctx, "PACK.arch_set", [arch]));
  else if (!f.sheets) out.push(make(ctx, "PACK.arch_set", "NOT_CHECKED", "Sheets could not be read from the model.", [arch]));
  else {
    const names = f.sheets.flatMap((s) => [`${s.number} ${s.name}`, ...s.views]);
    for (const item of strings(field(arch, "sheets"))) {
      const re = sheetPattern(item);
      const hit = f.sheets.filter((s) => re.test(`${s.number} ${s.name}`) || s.views.some((v) => re.test(v)));
      if (hit.length) out.push(make(ctx, "PACK.arch_set", "PASS", `"${item}": found on ${hit.map((s) => s.number).join(", ")}.`, [arch], hit.map((s) => s.id)));
      else out.push(make(ctx, "PACK.arch_set", "REVIEW", `"${item}": no sheet or placed view name matches (${names.length ? "checked " + f.sheets.length + " sheets" : "the model has no sheets"}). It may be named differently or be outside this model.`, [arch]));
    }
  }

  // reg 9: scales. The bank gives a text per kind; views are typed by name.
  if (arch.found) {
    const scales = (field(arch, "scales_min") ?? {}) as Record<string, unknown>;
    if (!f.viewports) out.push(make(ctx, "PACK.arch_scales", "NOT_CHECKED", "Viewport scales could not be read from the model.", [arch]));
    else {
      let checked = 0;
      const bad: Finding[] = [];
      for (const vp of f.viewports) {
        const kind = viewKind(vp.name);
        if (kind === "other" || vp.scale === null || !(kind in scales)) continue;
        const allowed = parseScales(scales[kind]);
        if (!allowed.list.length && !allowed.range) continue;
        checked++;
        if (!scaleAllowed(vp.scale, allowed)) bad.push(make(ctx, "PACK.arch_scales", "REVIEW", `"${vp.name}" on ${vp.sheet || "a sheet"} is at 1:${vp.scale}; ${kind.replace("_", " and ")} drawings are listed at ${String(scales[kind])}.`, [arch], [vp.id]));
      }
      out.push(...bad);
      if (!checked) out.push(make(ctx, "PACK.arch_scales", "NOT_CHECKED", "No placed view could be typed as site, layout, section or elevation from its name.", [arch]));
      else if (!bad.length) out.push(make(ctx, "PACK.arch_scales", "PASS", `${checked} placed view(s) typed by name use a listed scale.`, [arch]));
    }
  }

  // reg 13: the use of every room is shown. A room with no name, or the default "Room", shows no use.
  const general = citeFor(ctx, ruleById("PACK.room_use"), "drawings.general");
  const unnamed = f.rooms.filter((r) => !r.name.trim() || /^room(\s*\d+)?$/i.test(r.name.trim()));
  for (const r of unnamed) out.push(make(ctx, "PACK.room_use", "FAIL", `Room ${r.number || r.id} on ${r.level || "an unknown level"} has no use in its name ("${r.name}").`, [general], [r.id]));
  if (f.rooms.length && !unnamed.length) out.push(make(ctx, "PACK.room_use", "PASS", `All ${f.rooms.length} placed room(s) have a name.`, [general]));
  if (!f.rooms.length) out.push(make(ctx, "PACK.room_use", "NOT_CHECKED", "The model has no placed rooms with area.", [general]));
  for (const p of f.room_problems ?? []) out.push(make(ctx, "PACK.room_use", "REVIEW", p.sentence, [general], p.ids));
  if (f.room_problems === null) out.push(make(ctx, "PACK.room_use", "NOT_CHECKED", "Rooms not placed or not enclosed could not be read (fmc_model_check).", [general]));

  // Paper items and other discipline sets: not visible in this model.
  out.push(make(ctx, "PACK.paper", "NOT_CHECKED", "Signature and registration of the architect, lettering size, north point and hard copies are on the issued paper, not in the model.", [general]));
  out.push(make(ctx, "PACK.other_sets", "NOT_CHECKED", "Structural, electrical and mechanical sets are in other models or packages; not read in Phase A.",
    ["drawings.structural_set", "drawings.electrical_set", "drawings.mechanical_set"].map((k) => citeFor(ctx, ruleById("PACK.other_sets"), k))));
  return out;
}
