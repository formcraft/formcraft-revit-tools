import fs from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expandEnv, loadConfig } from "../fmc/policy.js";
import { navisCall, processAlive, readState } from "../fmc/navis.js";
import { readRhinoState, rhinoCall } from "../hub/rhino.js";
import { exchangeRoot, identityFile, loadIdentity } from "../hub/exchange.js";
import { Pick, SELECT_APPS, SelectApp, enrich, label, mergeRevit, navisRequest, picksFromIds, picksFromNavis, picksFromRevit,
  picksFromRhino, picksFromRobot, revitRequest, rhinoRequest, robotRequests, unmapped } from "../hub/select.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { connector, robotExe } from "./fmc_robot.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_SELECT_DESCRIPTION =
  "Formcraft engineering hub, one selection (docs/PLAN_ENGINEERING_HUB.md, X1): select elements in one app and the same " +
    "elements are selected and zoomed to in the others. from: revit, navisworks, rhino or robot; to: the apps to show them " +
    "in (default every other app that is open). ids: the elements in the from app (Revit UniqueIds or element ids, " +
    "Navisworks <model>#<element id> or GUIDs, Rhino object ids, Robot <run>#<bar>, or Formcraft ids FMC-…); without ids, " +
    "the from app's current selection. The project's identity map (01_WIP\\_Exchange\\FMC_Identity.json) links the apps; " +
    "Navisworks also finds Revit elements by their Element ID and model, and Rhino by the user text fmc.id. The answer says, " +
    "per app, what was found, what wasn't, and which elements have no id there yet. read: each open app's current selection, " +
    "nothing changes. Selection changes only what each app shows (its selection and camera), never a model, so there is no " +
    "dry run.";

export const FMC_SELECT_SHAPE = {
  action: z.enum(["show", "read"]).optional().default("show"),
  from: z.enum(SELECT_APPS).optional().default("revit").describe("show: the app whose elements are shown in the others"),
  to: z.array(z.enum(SELECT_APPS)).optional().default([]).describe("show: the apps to show them in (default every other app)"),
  ids: z.array(z.string()).optional().default([]).describe("show: the elements in the from app; empty takes its current selection"),
  zoom: z.boolean().optional().default(true).describe("show: zoom each app to the elements"),
  project_folder: z.string().optional().default("").describe("The project whose 01_WIP\\_Exchange holds the identity map (default <reports>\\Exchange)"),
};

export type FmcSelectArgs = z.infer<z.ZodObject<typeof FMC_SELECT_SHAPE>>;

type Call = (method: string, params: object) => Promise<any>;

/** How the tool reaches each app; null when the app isn't open with its connector. Tests pass stand-ins. */
export interface SelectDeps {
  revit: Call;
  navis: Call | null;
  rhino: Call | null;
  robot: Call | null;
  identityRoot: string;
}

export function realSelectDeps(projectFolder: string): SelectDeps {
  const { config } = loadConfig();
  const ns = readState(), rs = readRhinoState();
  return {
    revit: (cmd, params) => withRevitConnection((c) => c.sendRaw(cmd, params, 120000)),
    navis: ns && processAlive(ns.pid) ? (m, p) => navisCall(ns.port, m, p, 120000) : null,
    rhino: rs && processAlive(rs.pid) ? (m, p) => rhinoCall(rs.port, m, p, 60000) : null,
    // fmc-robot.exe never starts Robot for a selection: it says so when Robot isn't open
    robot: fs.existsSync(robotExe()) ? async (cmd, input) => {
      const r = await connector(cmd, input, 120000);
      if (r.error) throw new Error(String(r.error));
      return r;
    } : null,
    identityRoot: exchangeRoot(projectFolder || undefined, expandEnv(config.reports_dir)),
  };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const CLOSED: Record<SelectApp, string> = {
  revit: "Revit isn't reachable (fmc_revit list)",
  navisworks: "Navisworks with the Formcraft bridge isn't open (fmc_navis status)",
  rhino: "Rhino with the Formcraft bridge isn't open (fmc_rhino status)",
  robot: "The Robot connector isn't installed (fmc_robot status)",
};

/** The from app's current selection, as picks. */
async function readSelection(app: SelectApp, d: SelectDeps): Promise<{ picks: Pick[]; raw: any }> {
  switch (app) {
    case "revit": { const r = await d.revit("fmc_selection_get", {}); return { picks: picksFromRevit(r), raw: { model: r?.model, count: r?.count } }; }
    case "navisworks": { const r = await d.navis!("navis_selection", {}); return { picks: picksFromNavis(r), raw: { count: r?.count } }; }
    case "rhino": { const r = await d.rhino!("rhino_selection", {}); return { picks: picksFromRhino(r), raw: { document: r?.document, count: r?.count } }; }
    case "robot": { const r = await d.robot!("selection", {}); return { picks: picksFromRobot(r), raw: { run: r?.run, text: r?.text } }; }
  }
}

const callFor = (app: SelectApp, d: SelectDeps) => (app === "revit" ? d.revit : app === "navisworks" ? d.navis : app === "rhino" ? d.rhino : d.robot);

export async function runFmcSelect(args: FmcSelectArgs, deps?: SelectDeps) {
  const d = deps ?? realSelectDeps(args.project_folder);
  const note = "Selection only: each app's selection and camera change, no model does, so there is no dry run";

  if (args.action === "read") {
    const apps: Record<string, unknown> = {};
    for (const app of SELECT_APPS) {
      if (!callFor(app, d)) { apps[app] = { open: false, detail: CLOSED[app] }; continue; }
      try {
        const { picks, raw } = await readSelection(app, d);
        const map = loadIdentity(d.identityRoot);
        apps[app] = { ...raw, selected: picks.length, elements: enrich(map, picks).slice(0, 50).map((p) => ({ label: label(p), ...p })) };
      } catch (e) { apps[app] = { error: msg(e) }; }
    }
    return reply({ apps, identity: identityFile(d.identityRoot), note: "Read-only: nothing was selected or changed" });
  }

  if (!callFor(args.from, d)) return reply({ refused: true, reasons: [CLOSED[args.from]] }, true);
  const map = loadIdentity(d.identityRoot);
  let picks: Pick[];
  try {
    picks = args.ids.length ? picksFromIds(args.from, args.ids) : (await readSelection(args.from, d)).picks;
  } catch (e) {
    return reply({ error: `Couldn't read the selection in ${args.from}: ${msg(e)}` }, true);
  }
  if (!picks.length) return reply({ refused: true, reasons: [`Nothing is selected in ${args.from}: select elements there, or pass ids`] }, true);
  picks = enrich(map, picks);
  const mapped = picks.filter((p) => p.fmc).length;

  const targets = (args.to.length ? args.to : SELECT_APPS.filter((a) => a !== args.from)).filter((a) => a !== args.from);
  const apps: Record<string, unknown> = {};
  // Revit first: its answer gives every element both its UniqueId and its element id + model, which Navisworks needs
  const order = [...targets].sort((a, b) => (a === "revit" ? -1 : b === "revit" ? 1 : 0));
  const needLookup = !targets.includes("revit") && args.from !== "revit" && targets.includes("navisworks") &&
    picks.some((p) => p.revit?.unique_id && !p.revit.element_id);
  if (needLookup) {
    try {
      const r = await d.revit("fmc_selection_show", { ...revitRequest(picks), select: false });
      picks = mergeRevit(picks, r?.found ?? []);
    } catch { /* Revit closed: Navisworks gets what the map knows */ }
  }

  for (const app of order) {
    const call = callFor(app, d);
    if (!call) { apps[app] = { open: false, detail: CLOSED[app] }; continue; }
    const notMapped = unmapped(picks, app);
    try {
      if (app === "revit") {
        const req = revitRequest(picks);
        if (!req.unique_ids.length && !req.element_ids.length) { apps[app] = { selected: 0, not_mapped: notMapped }; continue; }
        const r = await call("fmc_selection_show", { ...req, zoom: args.zoom });
        picks = mergeRevit(picks, r?.found ?? []);
        apps[app] = { model: r?.model, selected: r?.selected ?? 0, zoomed: r?.zoomed ?? false, missing: r?.missing ?? [],
          in_other_models: r?.in_other_models ?? [], not_mapped: notMapped };
      } else if (app === "navisworks") {
        const req = navisRequest(picks);
        if (!req.items.length && !req.guids.length) { apps[app] = { selected: 0, not_mapped: unmapped(picks, app) }; continue; }
        const r = await call("navis_select", { ...req, zoom: args.zoom });
        apps[app] = { selected: r?.selected ?? 0, zoomed: r?.zoomed ?? false, missing: r?.missing ?? [], not_mapped: unmapped(picks, app) };
      } else if (app === "rhino") {
        const req = rhinoRequest(picks);
        if (!req.ids.length && !req.values.length) { apps[app] = { selected: 0, not_mapped: notMapped }; continue; }
        const r = await call("rhino_select", { ...req, zoom: args.zoom });
        apps[app] = { document: r?.document, selected: r?.selected ?? 0, zoomed: r?.zoomed ?? false, missing: r?.missing ?? [], not_mapped: notMapped };
      } else {
        const runs = robotRequests(picks);
        if (!runs.length) { apps[app] = { selected: 0, not_mapped: notMapped }; continue; }
        // Robot shows one project: the run with most of the bars; the others are named so a person can open them
        const r = await call("select", runs[0]);
        apps[app] = { run: r?.run, selected: r?.selected ?? 0, missing: r?.missing ?? [], ...(r?.note ? { detail: r.note } : {}),
          other_runs: runs.slice(1).map((x) => `${x.run} (${x.bars.length} bars)`), not_mapped: notMapped,
          zoom: "Robot's API selects bars but doesn't zoom: use Zoom to selection in Robot" };
      }
    } catch (e) {
      apps[app] = { error: msg(e), not_mapped: notMapped };
    }
  }

  return reply({
    from: args.from, selection: picks.length, mapped_in_identity: mapped, identity: identityFile(d.identityRoot),
    elements: picks.slice(0, 20).map(label), apps, note,
  });
}

export function registerFmcSelectTool(server: McpServer) {
  server.tool("fmc_select", FMC_SELECT_DESCRIPTION, FMC_SELECT_SHAPE, (args) => runFmcSelect(args));
}
