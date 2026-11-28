/** Casework engine: prices from the kit library, everything at once, the workshop pack files. Part of casework.ts. */
import { Standards, isObj } from "./casework_standards.js";
import { Layout, Unit } from "./casework_layout.js";
import { CutRow, HardwareRow, Nest, Part, allParts, boardsOf, cutList, edgeMetres, hardware, nest, worktopMetres } from "./casework_parts.js";

export interface LibPrice { ugx: string; unit: string; date: string; source: string; status: string }
export interface LibMaterial { name: string; price: LibPrice | null; keynote?: string }

export function readLibrary(json: unknown): Map<string, LibMaterial> {
  const list = Array.isArray(json) ? json : isObj(json) && Array.isArray(json.materials) ? json.materials : [];
  const map = new Map<string, LibMaterial>();
  for (const m of list as Array<Record<string, unknown>>) {
    const name = typeof m?.name === "string" ? m.name.trim() : "";
    if (!name) continue;
    const p = isObj(m.price) ? m.price : null;
    const keynote = typeof m.keynote === "string" && m.keynote.trim() ? { keynote: m.keynote.trim() } : {};
    map.set(name, { name, price: p ? { ugx: String(p.ugx ?? ""), unit: String(p.unit ?? ""), date: String(p.date ?? ""), source: String(p.source ?? ""), status: String(p.status ?? "") } : null, ...keynote });
  }
  return map;
}

/** "60,000-90,000" → [60000, 90000]; "105,000" → [105000, 105000]; anything else → null. */
export function parseUgx(ugx: string): [number, number] | null {
  const parts = ugx.split(/\s*[-–]\s*/).map((x) => x.replace(/[, ]/g, ""));
  if (!parts.length || parts.length > 2 || parts.some((x) => !/^\d+(\.\d+)?$/.test(x))) return null;
  const nums = parts.map(Number);
  return [nums[0], nums[nums.length - 1]];
}

type Basis = "sheet" | "m" | "m2";

/** What the library's price is per, when it is something the pack can multiply: a full sheet of this size, a metre, a square metre. */
export function priceBasis(unit: string, sheet: { length: number; width: number }): Basis | null {
  const u = unit.toLowerCase();
  const L = Math.max(sheet.length, sheet.width), W = Math.min(sheet.length, sheet.width);
  if (/sheet|board/.test(u)) {
    const ft = /8\s*x\s*4\s*ft|4\s*x\s*8\s*ft/.test(u) && L === 2440 && W === 1220;
    const mm = new RegExp(`${L}\\s*[x×]\\s*${W}|${W}\\s*[x×]\\s*${L}`).test(u);
    return ft || mm ? "sheet" : null;
  }
  if (/^per (linear )?m(etre)?\b(?!2|²)/.test(u)) return "m";
  if (/^per (m2|m²|sq\.? ?m)\b/.test(u)) return "m2";
  return null;
}

export interface CostLine {
  item: string;
  material: string;
  quantity: number;
  unit: string;
  ugx_low: number | null;
  ugx_high: number | null;
  price: string;
  status: string;
  source: string;
  date: string;
}
export interface KitRequest { item: string; request: string; why: string }

export interface CostInput {
  boards: Array<{ material: string; sheets: number }>;
  edge_m: number;
  worktop_m: number;
  hardware: HardwareRow[];
}

export function costs(q: CostInput, s: Standards, lib: Map<string, LibMaterial> | null): { lines: CostLine[]; total: { ugx_low: number; ugx_high: number; priced: number; price_needed: number }; kit_requests: KitRequest[] } {
  const lines: CostLine[] = [];
  const req: KitRequest[] = [];
  const line = (item: string, material: string, quantity: number, unit: string, basis: (b: Basis) => number | null) => {
    const base = { item, material, quantity, unit, ugx_low: null, ugx_high: null, status: "", source: "", date: "" };
    if (!material) return lines.push({ ...base, price: "price needed" });
    if (!lib) return lines.push({ ...base, price: "price needed: the kit's material library isn't readable" });
    const m = lib.get(material);
    if (!m) {
      req.push({ item: material, request: `Add ${material} to 07_Materials\\FMC_Materials.json`, why: `${item} uses it and the library has no such material` });
      return lines.push({ ...base, price: "price needed: not in the kit's material library" });
    }
    if (!m.price) return lines.push({ ...base, price: "price needed" });
    const range = parseUgx(m.price.ugx);
    const b = priceBasis(m.price.unit, s.sheet);
    const per = b ? basis(b) : null;
    const src = { status: m.price.status, source: m.price.source, date: m.price.date };
    if (!range) return lines.push({ ...base, ...src, price: `price needed: the library's price "${m.price.ugx}" isn't a number` });
    if (per === null) return lines.push({ ...base, ...src, price: `price needed: the library prices it "${m.price.unit}", which this quantity can't use` });
    const lo = Math.round(range[0] * per), hi = Math.round(range[1] * per);
    lines.push({ ...base, ...src, ugx_low: lo, ugx_high: hi, price: lo === hi ? `UGX ${lo.toLocaleString("en-US")}` : `UGX ${lo.toLocaleString("en-US")}–${hi.toLocaleString("en-US")}` });
  };
  for (const b of q.boards) line(`Board · ${b.sheets} sheets`, b.material, b.sheets, "sheet", (k) => (k === "sheet" ? b.sheets : null));
  line(`Edge banding · ${q.edge_m} m`, s.edge_band ?? "", q.edge_m, "m", (k) => (k === "m" ? q.edge_m : null));
  if (!s.edge_band) req.push({ item: "Edge band", request: "Add an edge-band material (e.g. 2 mm ABS or PVC, per metre) to 07_Materials\\FMC_Materials.json", why: "The library has no edge band, so the edge banding can't be priced" });
  if (q.worktop_m > 0) {
    line(`Worktop · ${q.worktop_m} m`, s.worktop ?? "", q.worktop_m, "m", (k) => (k === "m" ? q.worktop_m : k === "m2" ? (q.worktop_m * s.worktop_depth) / 1000 : null));
  }
  for (const h of q.hardware) if (h.qty > 0) lines.push({ item: h.item, material: "", quantity: h.qty, unit: h.unit, ugx_low: null, ugx_high: null, price: "price needed", status: "", source: "", date: "" });
  if (q.hardware.some((h) => h.qty > 0))
    req.push({ item: "Hardware", request: "Add a hardware price list (hinges, runners, handles, legs, shelf pins, hangers, kick board) to the kit", why: "The kit has no hardware prices; the pack shows \"price needed\" instead of a guess" });
  const priced = lines.filter((l) => l.ugx_low !== null);
  return {
    lines,
    total: { ugx_low: priced.reduce((a, l) => a + (l.ugx_low ?? 0), 0), ugx_high: priced.reduce((a, l) => a + (l.ugx_high ?? 0), 0), priced: priced.length, price_needed: lines.length - priced.length },
    kit_requests: req,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Everything at once

export interface Casework {
  layout: Layout;
  parts: Part[];
  nests: Nest[];
  cutlist: CutRow[];
  edge_m: number;
  worktop_m: number;
  hardware: HardwareRow[];
  problems: string[];
}

export function compute(units: Unit[], layout: Layout, s: Standards): Casework {
  const { parts, problems } = allParts(units, s);
  const nests = boardsOf(parts).map((m) => nest(parts, m, s.sheet, s.kerf));
  for (const n of nests) for (const t of n.too_big) problems.push(`${t} is bigger than a ${s.sheet.length} × ${s.sheet.width} sheet of ${n.material}`);
  return { layout, parts, nests, cutlist: cutList(parts), edge_m: edgeMetres(parts), worktop_m: worktopMetres(layout.worktop), hardware: hardware(units, s), problems: [...layout.problems, ...problems] };
}

export function summaryOf(c: Casework) {
  const units = c.layout.units.filter((u) => u.kind !== "gap");
  return {
    units: units.length,
    gaps: c.layout.units.filter((u) => u.kind === "gap").map((u) => `${u.mark} ${u.fronts} ${u.width}`),
    part_lines: c.parts.length,
    pieces: c.parts.reduce((a, p) => a + p.qty, 0),
    sheets: c.nests.reduce((a, n) => a + n.sheets.length, 0),
    boards: c.nests.map((n) => ({ material: n.material, sheets: n.sheets.length, parts: n.parts, yield_pct: n.yield_pct })),
    edge_m: c.edge_m,
    worktop_m: c.worktop_m,
    hardware: Object.fromEntries(c.hardware.map((h) => [h.item, h.qty])),
    fillers: c.layout.fillers,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Workshop pack: file names (the same inputs always give the same names) and contents

export function packLabel(label: string): string {
  return label.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export function packNames(code: string, label: string): { cutlist: string; nesting: string; hardware: string; boq: string; pdf: string; shop: string } {
  const stem = `${code}_Casework_${packLabel(label)}`;
  return { cutlist: `${stem}_CutList.csv`, nesting: `${stem}_Nesting.csv`, hardware: `${stem}_Hardware.csv`, boq: `${stem}_BoQ.csv`,
    pdf: `${stem}_WorkshopPack.pdf`, shop: `${stem}_ShopDrawings.pdf` };
}

export function packFiles(c: Casework, cost: ReturnType<typeof costs>, csvLine: (f: Array<string | number | boolean>) => string, code: string, label: string): Array<{ name: string; content: string; rows: number }> {
  const n = packNames(code, label);
  const csv = (head: string[], rows: Array<Array<string | number>>) => [head, ...rows].map((r) => csvLine(r)).join("");
  const cut = c.cutlist.map((r) => [r.mark, r.part, r.length, r.width, r.qty, r.board, r.edge, r.edge_m]);
  const nestRows = c.nests.flatMap((ns) => ns.sheets.flatMap((sh) => sh.items.map((it) => [ns.material, sh.index, it.x, it.y, it.l, it.w, it.label])));
  const hw = c.hardware.map((h) => [h.item, h.qty, h.unit]);
  const boq = cost.lines.map((l) => [l.item, l.material, l.quantity, l.unit, l.ugx_low ?? "", l.ugx_high ?? "", l.price, l.status, l.source, l.date]);
  return [
    { name: n.cutlist, rows: cut.length, content: csv(["mark", "part", "length_mm", "width_mm", "qty", "board", "edge", "edge_m"], cut) },
    { name: n.nesting, rows: nestRows.length, content: csv(["board", "sheet", "x_mm", "y_mm", "length_mm", "width_mm", "part"], nestRows) },
    { name: n.hardware, rows: hw.length, content: csv(["item", "qty", "unit"], hw) },
    { name: n.boq, rows: boq.length, content: csv(["item", "material", "quantity", "unit", "ugx_low", "ugx_high", "price", "price_status", "source", "date"], boq) },
  ];
}
