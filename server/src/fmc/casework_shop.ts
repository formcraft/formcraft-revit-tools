/** Casework in the model: shop-drawing sheets from the kit's register and rulebook, and the A3 layout. Part of casework_place.ts. */
import { Standards, Unit } from "./casework.js";

export interface SheetRow { number: string; name: string; scale: number; placed: string }

/** A sheet in FMC_Sheet_Register.csv (Role,Discipline,SheetNumber,SheetName,Series,Scale,Core,IssueSet,Placed). */
export function registerSheet(rows: string[][], number: string): SheetRow | null {
  const head = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const c = (k: string) => head.indexOf(k);
  for (const r of rows.slice(1)) {
    if ((r[c("sheetnumber")] ?? "").trim() !== number) continue;
    const m = /^1\s*:\s*(\d+)$/.exec((r[c("scale")] ?? "").trim());
    return { number, name: (r[c("sheetname")] ?? "").trim(), scale: m ? Number(m[1]) : 0, placed: (r[c("placed")] ?? "").trim() };
  }
  return null;
}

/** The register's sheet that holds this schedule or view template (its Placed column). */
export function registerSheetFor(rows: string[][], placed: string): SheetRow | null {
  const head = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const cP = head.indexOf("placed"), cN = head.indexOf("sheetnumber");
  const row = rows.slice(1).find((r) => (r[cP] ?? "").split(";").map((x) => x.trim()).includes(placed));
  return row ? registerSheet(rows, (row[cN] ?? "").trim()) : null;
}

export interface SheetFrame { title_block: { family: string; type: string }; origin: [number, number]; area: [number, number] }

/**
 * The A3 drawing area from the sheets rulebook: SHT-011 (FMC_TitleBlock, type A3), SHT-013 (margins), SHT-014 (the A1
 * drawing area) and SHT-017's a3_scale (A3 is the half-size set). Null with the reason when the rulebook lacks one.
 */
export function a3Frame(rulebook: unknown): { frame: SheetFrame | null; problem: string } {
  const rules = (rulebook && typeof rulebook === "object" ? (rulebook as Record<string, unknown>).rules : null) as Array<Record<string, any>> | null;
  const p = (id: string) => rules?.find((r) => r.id === id)?.check?.params as Record<string, any> | undefined;
  const tb = p("SHT-011"), margin = p("SHT-013"), area = p("SHT-014"), text = p("SHT-017");
  const family = typeof tb?.family === "string" ? tb.family : "";
  const types: string[] = Array.isArray(tb?.types) ? tb.types : [];
  if (!family || !types.includes("A3")) return { frame: null, problem: "The sheets rulebook (SHT-011) names no A3 title block type" };
  const a = area?.drawing_area_mm, k = text?.a3_scale;
  if (!Array.isArray(a) || a.length !== 2 || typeof k !== "number" || typeof margin?.margin_left_mm !== "number" || typeof margin?.margin_other_mm !== "number")
    return { frame: null, problem: "The sheets rulebook lacks the drawing area (SHT-014), the margins (SHT-013) or the A3 scale (SHT-017)" };
  return { frame: { title_block: { family, type: "A3" }, origin: [margin.margin_left_mm * k, margin.margin_other_mm * k], area: [a[0] * k, a[1] * k] }, problem: "" };
}

export interface ShopView { mark: string; sheet: string; centre: [number, number]; size: [number, number] }

/** Model size of a unit's front elevation with its margin, mm: width × height (base and tall units on their legs). */
export function elevationSize(u: Unit, s: Standards, margin: number): [number, number] {
  const box = u.kind === "wall" ? s.wall : u.kind === "tall" ? s.tall : s.base;
  const h = box.height + (u.kind === "wall" ? 0 : s.plinth);
  return [u.width + 2 * margin, h + 2 * margin];
}

/**
 * Rows of elevations, left to right and top down, on as many of the given sheets as they need; what doesn't fit on the
 * last sheet is named. Centres are mm on the sheet from its lower-left corner.
 */
export function shopLayout(units: Unit[], s: Standards, scale: number, frame: SheetFrame, sheets: string[], margin: number, gap = 8): { views: ShopView[]; overflow: string[] } {
  const views: ShopView[] = [];
  const overflow: string[] = [];
  const [ox, oy] = frame.origin, [aw, ah] = frame.area;
  let si = 0, x = 0, rowTop = 0, rowH = 0;
  for (const u of units.filter((x) => x.kind !== "gap")) {
    const [mw, mh] = elevationSize(u, s, margin);
    const w = mw / scale, h = mh / scale;
    if (w > aw || h > ah) { overflow.push(`${u.mark} (${Math.round(w)} × ${Math.round(h)} mm at 1:${scale})`); continue; }
    if (x > 0 && x + w > aw) { x = 0; rowTop += rowH + gap; rowH = 0; }
    if (rowTop + h > ah) { si++; x = 0; rowTop = 0; rowH = 0; }
    if (si >= sheets.length) { overflow.push(u.mark); continue; }
    views.push({ mark: u.mark, sheet: sheets[si], centre: [Math.round((ox + x + w / 2) * 10) / 10, Math.round((oy + ah - rowTop - h / 2) * 10) / 10], size: [Math.round(w * 10) / 10, Math.round(h * 10) / 10] });
    x += w + gap;
    rowH = Math.max(rowH, h);
  }
  return { views, overflow };
}
