import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { DIAGRAM_KINDS, DRAW_RESULT, DiagramKind, SCAN_RESULT, ScanResult } from "../fmc/diagram/contract.js";
import { drawSpec, layoutScan, planSummary } from "../fmc/diagram/layout.js";
import { kitDiagramFile, loadDiagramKit } from "../fmc/diagram/symbols.js";
import { DRAINAGE_LONG, DRAINAGE_LONG_MISSING, DrawnView, a1Frame, diagramSheets, gateD, sheetPlan } from "../fmc/diagram/sheets.js";

const win = path.win32;

function log(cfg: GuardConfig, action: string, dryRun: boolean, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = win.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dryRun, target, result, detail]));
  } catch {
    // logging must never block the work
  }
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_DIAGRAM_DESCRIPTION =
  "Formcraft line diagrams from the model (track LD): electrical single-lines (BS 7671, IEC 60617 symbols) and power risers, fire alarm " +
    "zone charts (BS 5839), ELV risers, fire fighting (BS EN 12845), water and drainage schematics, refrigerant and " +
    "lightning protection schematics, and the building controls network riser with its points list (m_controls). Values come only from the model: a missing value prints TBC and is listed; nothing " +
    "is sized, rated or computed. scan (read-only) reads the systems and returns per diagram the node and edge counts and " +
    "the gaps. plan (read-only) scans and lays out the views and returns per view its name, item counts, TBC count, " +
    "collisions and warnings; nothing is drawn (save: true writes the draw spec JSON to the reports folder). draw scans, " +
    "lays out and makes one drafting view per diagram: a dry run unless dry_run is false, and dry_run=false needs " +
    "confirm=true after a person said yes to the dry run. scan and plan work on every model, live and shared ones too. " +
    "The tool draws by itself only in new (unsaved) documents and in files in _Staging and _ChainTests; on a live project " +
    "draw is refused, and a person presses Generate in the pane (Engineer › Systems › Diagrams) instead. " +
    "sheets (LD5): the kit's Sheet Register rows that hold diagrams (E-0003 single-line, E-0004 earthing and bonding, " +
    "E-6002 riser, P-0003 water and drainage schematics) and which drawn views go on each, packed into the kit's A1 " +
    "drawing area with the kit's title block (FMC_Rulebook_Sheets.json); a dry run unless dry_run is false (confirm=true " +
    "after a person's yes), and the real run creates or updates the sheets and places the views already drawn, never " +
    "saves. Kinds with no register row and views that don't fit are kit change requests, never invented sheet numbers; the " +
    "drainage long section (P-3001, C-3002) is TBC until the scan reads inverts, lengths and manholes. gate (read-only): " +
    "Gate D compares each drawn diagram with a fresh scan: items in the model missing from the drawing, drawn items no " +
    "longer in the model, TBC values, views not drawn or not on a sheet; Pass / Warn / Fail lines.";

export const FMC_DIAGRAM_SHAPE = {
  action: z.enum(["scan", "plan", "draw", "sheets", "gate"]),
  kinds: z.array(z.enum(DIAGRAM_KINDS)).optional().default([])
    .describe("Diagrams: e_sld, e_power_riser, e_fa_riser, e_elv_riser, fp_schematic, p_water, p_drainage, m_refrigerant, lp_schematic, m_controls. Empty: all"),
  kit_folder: z.string().optional().default("")
    .describe("The kit folder, for 03_Master_Data\\FMC_Diagram_Symbols.json (symbols and styles). Empty: the kit beside the family specs"),
  views: z.array(z.string()).optional().default([]).describe("draw and sheets: only these views (names from plan). Empty: all"),
  save: z.boolean().optional().default(false).describe("plan: write the draw spec JSON to <reports>\\Diagrams and return its path"),
  dry_run: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false).describe("draw or sheets with dry_run=false: true only once a person said yes to the dry run"),
};

export type FmcDiagramArgs = z.infer<z.ZodObject<typeof FMC_DIAGRAM_SHAPE>>;

/** The scan in a few lines: counts per diagram and the gaps, never the graph. */
export function scanSummary(scan: ScanResult) {
  const diagrams = scan.diagrams.map((d) => {
    const by_kind: Record<string, number> = {};
    for (const n of d.nodes) by_kind[n.kind] = (by_kind[n.kind] ?? 0) + 1;
    return { kind: d.kind, system: d.system, nodes: d.nodes.length, edges: d.edges.length, by_kind };
  });
  const gaps: Record<string, { count: number; first: string[] }> = {};
  for (const g of scan.gaps) {
    const e = gaps[g.kind] ?? (gaps[g.kind] = { count: 0, first: [] });
    e.count++;
    if (e.first.length < 20) e.first.push(g.element_id ? `${g.message} (${g.element_id})` : g.message);
  }
  return { model: scan.model, levels: scan.levels.length, diagrams, gaps };
}

function kitFolderOf(args: FmcDiagramArgs, cfg: GuardConfig): string {
  if (args.kit_folder.trim()) return args.kit_folder.trim();
  return win.dirname(win.dirname(expandEnv(cfg.specs_path)));
}

/** The kit's Sheet Register (03_Master_Data\\FMC_Sheet_Register.csv), read-only. */
function readRegister(kitFolder: string) {
  const file = win.join(kitFolder, "03_Master_Data", "FMC_Sheet_Register.csv");
  try { return { file, register: diagramSheets(fs.readFileSync(file, "utf8")) }; } catch { return { file, register: null }; }
}

/** The A1 frame from the kit's sheets rulebook (the kit's own copy, else the configured rulebooks folder). */
function readFrame(kitFolder: string, cfg: GuardConfig) {
  const files = [win.join(kitFolder, "03_Master_Data", "FMC_Rulebook", "FMC_Rulebook_Sheets.json"), win.join(expandEnv(cfg.rulebooks_dir), "FMC_Rulebook_Sheets.json")];
  for (const f of files) {
    try { return { ...a1Frame(JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""))), file: f }; } catch { /* next */ }
  }
  return { ...a1Frame(null), file: "" };
}

/** fmc_diagram_drawn's answer: the drafting views holding items this tool drew. */
function drawnViews(raw: any): DrawnView[] {
  const list = Array.isArray(raw?.views) ? raw.views : [];
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return list.filter((v: any) => v && typeof v.name === "string").map((v: any) => ({
    name: v.name, view_id: typeof v.view_id === "string" ? v.view_id : null, keys: strs(v.keys),
    tbc_texts: Number(v.tbc_texts) || 0, kept_by_hand: Number(v.kept_by_hand) || 0, sheets: strs(v.sheets),
  }));
}

export async function runFmcDiagram(args: FmcDiagramArgs) {
  const dry = args.dry_run !== false;
  // A real draw or sheet run needs a person's yes to the dry run; refused before anything reaches Revit.
  if ((args.action === "draw" || args.action === "sheets") && !dry && args.confirm !== true)
    return reply({ refused: true, reasons: [`dry_run=false ${args.action === "draw" ? "draws views" : "creates sheets and places views"} in the model: run the dry run, show it, and send confirm=true once the person says yes`] }, true);
  const { config } = loadConfig();
  const kinds: DiagramKind[] = args.kinds.length ? [...new Set(args.kinds)] : [...DIAGRAM_KINDS];
  try {
    // the power riser is laid out from the SLD graph, so it needs the e_sld scan too
    const scanKinds = kinds.includes("e_power_riser") && !kinds.includes("e_sld") ? [...kinds, "e_sld" as const] : kinds;
    const raw = await withRevitConnection((c) => c.sendCommand("fmc_diagram_scan", { kinds: scanKinds }, 300000));
    const parsed = SCAN_RESULT.safeParse(raw);
    if (!parsed.success)
      return reply({ error: "The scan didn't match the diagram contract (fmc_diagram_scan)",
        issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`) }, true);
    const scan = parsed.data;
    if (args.action === "scan") return reply({ ...scanSummary(scan), next: "plan lays the diagrams out; the engineer fills the gaps in the model" });

    const kitFile = kitDiagramFile(kitFolderOf(args, config));
    const { kit, source, problems } = loadDiagramKit(kitFile);
    const plan = layoutScan(scan, kit, kinds);
    const views = planSummary(plan);
    const clashing = views.filter((v) => v.collisions > 0);
    const base = { model: scan.model, kit: source, kit_problems: problems, warnings: plan.warnings };

    if (args.action === "plan") {
      let saved: string | undefined;
      if (args.save && plan.views.length) {
        const stamp = new Date().toISOString().slice(0, 10);
        saved = win.join(expandEnv(config.reports_dir), "Diagrams", `FMC_Diagram_Spec_${String(scan.model).replace(/\.rvt$/i, "").replace(/[\\/:*?"<>|]/g, "_")}_${stamp}.json`);
        fs.mkdirSync(win.dirname(saved), { recursive: true });
        fs.writeFileSync(saved, JSON.stringify(drawSpec(plan, true), null, 2));
      }
      log(config, "diagram_plan", true, scan.model, clashing.length ? "collisions" : "ok", `${views.length} views${saved ? `, saved ${saved}` : ""}`);
      return reply({ ...base, views, saved,
        not_drawn: [{ kind: DRAINAGE_LONG, state: "TBC", why: "the drainage long section needs data the scan doesn't read yet", missing: DRAINAGE_LONG_MISSING }],
        next: clashing.length ? "Some views have collisions: they won't be drawn until the layout or the kit sizes are fixed"
          : "draw (a dry run first) makes the views in a new document, _Staging or _ChainTests; in a live project a person presses Generate in the pane" });
    }

    if (args.action === "sheets") {
      const kitFolder = kitFolderOf(args, config);
      const { file, register } = readRegister(kitFolder);
      if (!register) return reply({ refused: true, reasons: [`The kit's Sheet Register isn't readable at ${file}`] }, true);
      const { frame, problem: frameProblem, file: frameFile } = readFrame(kitFolder, config);
      const sp = sheetPlan(plan, register, frame, kit, args.views);
      const sheets = sp.sheets.map((s) => ({ number: s.number, name: s.name, title_block: s.title_block, diagrams: s.kinds,
        views: s.views.map((v) => v.name), left_off: s.left_off, warnings: s.views.map((v) => v.warning).filter(Boolean) }));
      const head = { ...base, register: file, frame: { ...frame, from: frameFile || "defaults", problem: frameProblem || undefined },
        sheets, no_sheet: sp.no_sheet, tbc: sp.tbc, register_rows_not_diagrams: sp.unmapped, kit_change_requests: sp.kit_change_requests };
      const params = { dry_run: dry, sheets: sp.sheets.filter((s) => s.views.length)
        .map((s) => ({ number: s.number, name: s.name, title_block: s.title_block, views: s.views.map((v) => ({ name: v.name, center_mm: v.center_mm })) })) };
      if (!params.sheets.length)
        return reply({ ...head, dry_run: dry, result: "nothing to place", next: "The scan finds no diagram for a register sheet: nothing goes on a sheet yet" });
      if (dry) {
        // the dry run makes the sheets and rolls them back in Revit; it changes nothing, so it needs no lock
        let rv: unknown;
        try { rv = await withRevitConnection((c) => c.sendRaw("fmc_diagram_sheet", params, 600000)); }
        catch (err) { rv = { not_reached: `Revit dry run not run: ${err instanceof Error ? err.message : String(err)}` }; }
        return reply({ ...head, dry_run: true, revit: rv,
          next: "Show this to the person; run again with dry_run=false and confirm=true once they say yes (draw the views first: a view not drawn is reported as not found)" });
      }
      const rv = await withRevitConnection((c) => c.sendCommand("fmc_diagram_sheet", params, 600000));
      log(config, "diagram_sheets", false, scan.model, "done", params.sheets.map((s) => `${s.number}: ${s.views.map((v) => v.name).join(", ")}`).join("; "));
      return reply({ ...head, dry_run: false, done: true, revit: rv, next: "Check each sheet (fmc_doc screenshot); a person arranges the viewports; run gate (Gate D) before issue" });
    }

    if (args.action === "gate") {
      const raw = await withRevitConnection((c) => c.sendCommand("fmc_diagram_drawn", {}, 300000));
      const g = gateD(plan, drawnViews(raw), scan, kit, kinds);
      log(config, "diagram_gate", true, scan.model, g.verdict, g.summary);
      return reply({ ...base, gate: "D", verdict: g.verdict, summary: g.summary, lines: g.lines,
        views: g.views.map((v) => ({ ...v, missing: v.missing.slice(0, 20), gone: v.gone.slice(0, 20), missing_count: v.missing.length, gone_count: v.gone.length })),
        next: g.verdict === "Fail" ? "Regenerate the diagrams (Generate in the pane, or draw), then run the gate again" : "The engineer checks and signs the diagrams off; the tool never does" });
    }

    // draw
    const spec = drawSpec(plan, dry, args.views);
    if (!spec.views.length) return reply({ refused: true, reasons: [args.views.length ? `No view named ${args.views.join(", ")} in the plan` : "Nothing to draw: the scan found no diagrams"] }, true);
    const blocked = views.filter((v) => v.collisions > 0 && spec.views.some((s) => s.name === v.name));
    if (blocked.length)
      return reply({ refused: true, reasons: blocked.map((v) => `${v.name}: ${v.collisions} collision(s)`), collisions: blocked.map((v) => ({ view: v.name, list: v.collision_list })) }, true);
    // The dry run only reads; the real run changes the model and goes through the live-model lock (fmc_diagram_draw).
    const r = await withRevitConnection((c) => dry ? c.sendRaw("fmc_diagram_draw", spec, 600000) : c.sendCommand("fmc_diagram_draw", spec, 600000));
    const result = DRAW_RESULT.safeParse(r);
    const body = result.success ? result.data : r;
    if (!dry) log(config, "diagram_draw", false, scan.model, "done", spec.views.map((v) => v.name).join("; "));
    return reply({ ...base, dry_run: dry, views: views.filter((v) => spec.views.some((s) => s.name === v.name)).map((v) => ({ name: v.name, tbc: v.tbc, warnings: v.warnings })),
      result: body, next: dry ? "Show this to the person; run again with dry_run=false and confirm=true once they say yes" : "Check each view (fmc_doc screenshot); the engineer signs the diagrams off" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, `diagram_${args.action}`, dry, "", "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcDiagramTool(server: McpServer) {
  server.tool("fmc_diagram", FMC_DIAGRAM_DESCRIPTION, FMC_DIAGRAM_SHAPE, (args) => runFmcDiagram(args));
}
