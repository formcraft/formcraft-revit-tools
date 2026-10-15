import { DIAGRAM_KINDS, DiagramKind, DrawSpec, DrawView, ScanDiagram, ScanResult } from "./contract.js";
import { BandSetup, COUNTED_KINDS, bandPage, nearestSpine } from "./bands.js";
import { Collision, collisions, natural, viewSafe } from "./geometry.js";
import { treePage } from "./schematic.js";
import { controlsPages } from "./controls.js";
import { powerRiserPage } from "./riser.js";
import { Page, sldPages } from "./sld.js";
import { DEFAULT_DIAGRAM_KIT, DiagramKit, Mark, param, text } from "./symbols.js";

/**
 * Line diagrams: SCAN_RESULT -> views (DRAW_VIEW). Pure and deterministic: the same scan gives the same views, item for
 * item, so regenerating a diagram updates it in place. Every view passes the collision check or the plan says where.
 *
 *   e_sld                       sld.ts        tree top-down, one view per top-level board
 *   e_power_riser               riser.ts      boards per level and the feeders between them, from the e_sld graph
 *   e_fa_riser, e_elv_riser     bands.ts      level bands, zone / system columns, panel at the base
 *   fp_schematic, p_water,      bands.ts      level bands, one column per riser or stack, plant in flow order
 *   p_drainage
 *   lp_schematic                bands.ts      bands by part: air terminations, down conductors, test joints, earths
 *   m_refrigerant               schematic.ts  outdoor unit trees, left to right
 *   m_controls                  controls.ts   controls network riser (head end at the base) and a points list view
 */

export interface PlannedView {
  view: DrawView;
  /** Values printed TBC in this view (each listed in its notes). */
  tbc: number;
  collisions: Collision[];
  warnings: string[];
  /** Scan ids shown in the view: drawn, labelled, counted or listed in the notes. */
  covered: string[];
}

export interface Plan { model: string; views: PlannedView[]; warnings: string[] }

const levelBands = (levels: ScanResult["levels"]) =>
  levels.slice().sort((a, b) => b.elevation_mm - a.elevation_mm || natural(a.name, b.name) || a.id.localeCompare(b.id))
    .map((l) => ({ id: l.id, title: `${l.name || "Level TBC"}\n${l.elevation_mm >= 0 ? "+" : ""}${(l.elevation_mm / 1000).toFixed(3)}` }));

const spineKinds: Partial<Record<DiagramKind, string[]>> = {
  fp_schematic: ["riser"], p_water: ["riser"], p_drainage: ["stack", "riser"], lp_schematic: ["down_conductor"],
};

function counted(n: { kind: string }, m: Mark): boolean {
  if (m.t !== "box" && m.rule.counted !== undefined) return m.rule.counted;
  return COUNTED_KINDS.has(n.kind);
}

function setupFor(d: ScanDiagram, scan: ScanResult, kit: DiagramKit, title: string): BandSetup {
  const levels = levelBands(scan.levels);
  const bandOf = (n: { level: string | null }) => n.level ?? "__none";
  const sys = (n: { params: Record<string, string | number | null> }) => text(param(n.params, "system").value);
  switch (d.kind) {
    case "e_fa_riser":
      return {
        title, bands: levels, bandOf, levelBands: true, baseTitle: "Control and indicating equipment",
        columnOf: (n) => {
          const z = text(param(n.params, "zone").value);
          return z ? { key: `zone:${z}`, header: `Zone ${z}` } : { key: "zone:~", header: "Zone TBC" };
        },
        headerExtra: (ns) => {
          const loops = [...new Set(ns.map((n) => text(param(n.params, "loop").value)).filter((l): l is string => !!l))].sort(natural);
          return loops.length ? [`Loop ${loops.join(", ")}`] : [];
        },
        isBase: (n, m) => (m.t !== "box" && !!m.rule.base) || n.kind === "panel" || n.kind === "board",
        isCounted: counted,
      };
    case "e_elv_riser":
      return {
        title, bands: levels, bandOf, levelBands: true, baseTitle: "Head end (racks, NVR, energiser)",
        columnOf: (n, m) => {
          const g = (m.t !== "box" && m.rule.group) || sys(n) || "Other";
          return { key: g, header: g };
        },
        isBase: (n, m) => (m.t !== "box" && !!m.rule.base) || n.kind === "panel" || n.kind === "board",
        isCounted: counted,
      };
    case "lp_schematic": {
      const rows = [["air_terminal", "Air terminations"], ["down_conductor", "Down conductors"], ["test_joint", "Test joints"], ["earth_pit", "Earth electrodes"]];
      const isBase = (n: { kind: string }, m?: Mark) => ["earth_bar", "spd", "bond"].includes(n.kind) || (!!m && m.t !== "box" && !!m.rule.base);
      const owner = nearestSpine(d, (n) => n.kind === "down_conductor", (n) => isBase(n));
      return {
        title, bands: [...rows.map(([id, t]) => ({ id, title: t })), { id: "__none", title: "Other parts" }],
        bandOf: (n) => n.kind, baseTitle: "Earthing and bonding",
        columnOf: (n) => {
          const s = owner.get(n.id);
          return s ? { key: s.id, header: s.name || "Down conductor" } : { key: "~", header: "Not connected" };
        },
        isBase, isCounted: (_n, m) => m.t !== "box" && m.rule.counted === true,
      };
    }
    default: {
      // fp_schematic, p_water, p_drainage: a column per riser or stack, else per system
      const kinds = spineKinds[d.kind] ?? [];
      const owner = nearestSpine(d, (n) => kinds.includes(n.kind), () => false);
      return {
        title, bands: levels, bandOf, levelBands: true, baseTitle: "",
        columnOf: (n) => {
          const s = owner.get(n.id);
          if (s) return { key: `spine:${s.id}`, header: s.name || "Riser" };
          const g = sys(n) || d.system || "System";
          return { key: `sys:${g}`, header: g };
        },
        isBase: () => false,
        isCounted: counted,
      };
    }
  }
}

const TITLES: Record<DiagramKind, string> = {
  e_sld: "Single-line diagram", e_power_riser: "Power riser", e_fa_riser: "Fire alarm riser and zone chart", e_elv_riser: "ELV and security riser",
  fp_schematic: "Fire fighting schematic", p_water: "Water supply schematic", p_drainage: "Drainage schematic",
  m_refrigerant: "Refrigerant schematic", lp_schematic: "Lightning protection and earthing schematic",
  m_controls: "Controls network riser",
};

/** Views for every diagram in the scan (or only `kinds`). */
export function layoutScan(scan: ScanResult, kit: DiagramKit = DEFAULT_DIAGRAM_KIT, kinds: readonly DiagramKind[] = DIAGRAM_KINDS): Plan {
  const taken = new Set<string>();
  const name = (wanted: string) => {
    let n = viewSafe(wanted), i = 2;
    while (taken.has(n.toLowerCase())) n = `${viewSafe(wanted)}-${i++}`;
    taken.add(n.toLowerCase());
    return n;
  };
  const bySystem = (a: ScanDiagram, b: ScanDiagram) => DIAGRAM_KINDS.indexOf(a.kind) - DIAGRAM_KINDS.indexOf(b.kind) || natural(a.system, b.system);
  const slds = scan.diagrams.filter((d) => d.kind === "e_sld").sort(bySystem);
  // the power riser is drawn from the SLD graph unless the scan sends its own
  const sources = scan.diagrams.some((d) => d.kind === "e_power_riser") ? scan.diagrams
    : [...scan.diagrams, ...slds.map((d) => ({ ...d, kind: "e_power_riser" as const }))];
  const diagrams = sources.filter((d) => kinds.includes(d.kind)).sort(bySystem);
  // which SLD view each board is drawn on (same names the SLD views get), for the riser's "See …"
  const sldOf = new Map<string, string>();
  if (kinds.includes("e_power_riser")) {
    const seen = new Set<string>();
    const ref = (wanted: string) => {
      let n = viewSafe(wanted), i = 2;
      while (seen.has(n.toLowerCase())) n = `${viewSafe(wanted)}-${i++}`;
      seen.add(n.toLowerCase());
      return n;
    };
    for (const d of slds) {
      if (!d.nodes.length) continue;
      for (const p of sldPages(d, { kit, model: scan.model, name: ref }))
        for (const i of p.canvas.items) if (i.t === "symbol" && i.source_id && !sldOf.has(i.source_id)) sldOf.set(i.source_id, p.name);
    }
  }
  const perKind = new Map<DiagramKind, number>();
  for (const d of diagrams) perKind.set(d.kind, (perKind.get(d.kind) ?? 0) + 1);
  const warnings: string[] = [];
  const views: PlannedView[] = [];
  for (const d of diagrams) {
    if (!d.nodes.length) { warnings.push(`${d.kind} ${d.system}: nothing in the model, no view`); continue; }
    const prefix = kit.layout.view_names[d.kind];
    const viewName = () => name((perKind.get(d.kind) ?? 0) > 1 ? `${prefix}-${d.system}` : prefix);
    const title = `${TITLES[d.kind]}${d.system ? `: ${d.system}` : ""}`;
    let pages: Page[];
    if (d.kind === "e_sld") pages = sldPages(d, { kit, model: scan.model, name });
    else if (d.kind === "e_power_riser") {
      const p = powerRiserPage(d, scan.levels, viewName(), { kit, model: scan.model, sldView: (id) => sldOf.get(id) ?? null }, title);
      p.canvas.frame(p.title, `${scan.model} · values from the model only`);
      pages = [p];
    } else if (d.kind === "m_controls") {
      const wanted = (perKind.get(d.kind) ?? 0) > 1 ? `${prefix}-${d.system}` : prefix;
      pages = controlsPages(d, scan.levels, wanted, { kit, model: scan.model, name }, title);
      for (const p of pages) p.canvas.frame(p.title, `${scan.model} · values from the model only`);
    } else if (d.kind === "m_refrigerant") {
      const p = treePage(d, viewName(), { kit, model: scan.model }, { title, rootKinds: ["outdoor_unit"] });
      p.canvas.frame(p.title, `${scan.model} · values from the model only`);
      pages = [p];
    } else {
      const p = bandPage(d, viewName(), { kit, model: scan.model }, setupFor(d, scan, kit, title));
      p.canvas.frame(p.title, `${scan.model} · values from the model only`);
      pages = [p];
    }
    for (const p of pages) {
      const view: DrawView = { name: p.name, kind: d.kind, scale: kit.styles.scale, sheet_hint: null, items: p.canvas.items };
      const covered = new Set<string>(p.canvas.covered);
      for (const i of view.items) if (i.source_id) covered.add(i.source_id);
      views.push({ view, tbc: p.canvas.tbc.size, collisions: collisions(view, kit), warnings: p.canvas.warnings, covered: [...covered].sort() });
    }
  }
  return { model: scan.model, views, warnings };
}

/** The DRAW_SPEC for fmc_diagram_draw: the views (optionally only some, by name). */
export function drawSpec(plan: Plan, dryRun: boolean, only: string[] = []): DrawSpec {
  const want = new Set(only.map((s) => s.toLowerCase()));
  return { views: plan.views.filter((v) => !want.size || want.has(v.view.name.toLowerCase())).map((v) => v.view), dry_run: dryRun };
}

/** One line per view for the plan answer: no geometry, just what a person needs to decide. */
export function planSummary(plan: Plan) {
  return plan.views.map((v) => {
    const counts = { symbols: 0, lines: 0, texts: 0 };
    for (const i of v.view.items) counts[i.t === "symbol" ? "symbols" : i.t === "line" ? "lines" : "texts"]++;
    return { name: v.view.name, kind: v.view.kind, items: counts, tbc: v.tbc, collisions: v.collisions.length,
      collision_list: v.collisions.slice(0, 10), warnings: v.warnings };
  });
}
