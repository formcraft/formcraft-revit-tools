/**
 * Shared dry-run and apply path for the electrical and plumbing diagram tools.
 * The read stays on fmc_elec_diagrams or fmc_plumb_diagrams. The write is one transaction.
 */
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "./target.js";
import { loadConfig, type GuardConfig } from "./policy.js";
import { writeReport } from "./localreport.js";
import {
  diagramApiLimits, elecInputFromTrace, planElecDiagrams, planPlumbDiagrams, plumbInputFromTrace,
  type DiagramPlan, type DiagramView, type ElecDiagramInput, type PlumbDiagramInput, type RiserStyle,
} from "./schematicplan.js";
import type { TraceSnapshot } from "./trace.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export interface DiagramArgs {
  action: "plan" | "apply" | "limits";
  document: string;
  dry_run: boolean;
  batch_lease: string;
  riser: RiserStyle;
  references?: { kit?: string[]; standards?: string[]; rulebook?: string[] };
  /** Plumbing only (PD-1): system names or ids, and paging. */
  systems?: string[];
  offset?: number;
  limit?: number;
}

export interface DiagramIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
}

export interface DiagramTool {
  tool: "fmc_elec_diagrams" | "fmc_plumb_diagrams";
  readCommand: string;
  applyCommand: string;
  discipline: "elec" | "plumb";
}

function referenceProblems(refs: DiagramArgs["references"]): string | null {
  if (!refs) return "[FMC-DIAGRAM-REFERENCES] A write needs references.kit, references.standards and references.rulebook.";
  for (const key of ["kit", "standards", "rulebook"] as const) {
    const list = refs[key];
    if (!Array.isArray(list) || !list.some((item) => String(item).trim())) {
      return "[FMC-DIAGRAM-REFERENCES] A write needs references.kit, references.standards and references.rulebook.";
    }
  }
  return null;
}

function guardOf(snapshot: { model?: string; resolved_document?: { title?: string; path?: string }; is_central?: boolean }, named: string, io: DiagramIo, tool: string): string | null {
  const config = io.guard ?? loadConfig().config;
  const title = snapshot.resolved_document?.title || snapshot.model || "";
  const file = snapshot.resolved_document?.path || "";
  if (/hebert hostels/i.test(`${title} ${file} ${named}`)) return `HEBERT HOSTELS is not written by ${tool}.`;
  if (snapshot.is_central) return `A central model is not written by ${tool}.`;
  const pathName = file.replace(/\//g, "\\").toLowerCase();
  for (const root of config.protected_paths ?? []) {
    const norm = root.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    if (norm && (pathName === norm || pathName.startsWith(norm + "\\"))) return `The document is under a protected path (${root}).`;
  }
  return null;
}

function summarise(view: DiagramView) {
  const texts = view.items.filter((item) => item.t === "text").map((item) => item.text ?? "").filter(Boolean);
  return {
    name: view.name, kind: view.kind, system: view.system, building: view.building, scale: view.scale,
    items: view.items.length, lines: view.items.filter((item) => item.t === "line").length,
    texts: texts.slice(0, 12), symbols: view.items.filter((item) => item.t === "symbol").length, notes: view.notes,
  };
}

function planOf(tool: DiagramTool, snapshot: Record<string, unknown>, style: RiserStyle, args?: DiagramArgs): DiagramPlan {
  if (tool.discipline === "elec") {
    const input = Array.isArray(snapshot.panels) ? snapshot as ElecDiagramInput : elecInputFromTrace(snapshot as TraceSnapshot);
    return planElecDiagrams(input, style);
  }
  const input = Array.isArray(snapshot.systems) ? snapshot as PlumbDiagramInput : plumbInputFromTrace(snapshot as TraceSnapshot);
  return planPlumbDiagrams(input, style, { systems: args?.systems, offset: args?.offset, limit: args?.limit });
}

export async function runDiagramTool(tool: DiagramTool, args: DiagramArgs, io: DiagramIo = {}) {
  if (args.action === "limits") {
    return reply({
      tool: tool.tool, read_only: true, action: "limits", api_limits: diagramApiLimits(tool.discipline),
      symbols: ["FMC_DI_E_SLD_Board", "FMC_DI_E_SLD_Breaker", "FMC_DI_P_Schematic"],
      riser: ["bands", "elevation"],
      rule: "dry_run defaults to true. apply with dry_run false is one transaction and needs batch_lease and references.",
    });
  }
  if (!args.document.trim()) {
    return reply({ tool: tool.tool, refused: true, code: "FMC-DOC-REQUIRED", message: `[FMC-DOC-REQUIRED] ${tool.tool} needs document: a title or a full path.` }, true);
  }
  let snapshot: Record<string, unknown>;
  try {
    const body = { document: args.document, mode: "snapshot" };
    snapshot = (io.read ? await io.read(body) : await withRevitConnection((client) => client.sendCommand(tool.readCommand, body, 300000))) as Record<string, unknown>;
  } catch (error) {
    return reply({ tool: tool.tool, read_only: true, error: error instanceof Error ? error.message : String(error) }, true);
  }
  if (!snapshot || typeof snapshot !== "object") {
    return reply({ tool: tool.tool, read_only: true, error: `${tool.tool} returned no graph.` }, true);
  }
  const plan = planOf(tool, snapshot, args.riser, args);
  const resolved = (snapshot.resolved_document ?? {}) as { title?: string; path?: string };
  const document = { title: String(resolved.title || snapshot.model || args.document), path: String(resolved.path || "") };
  const report = writeReport(tool.discipline === "elec" ? "elec-diagrams" : "plumb-diagrams", args.action, { plan, document }, io.env);
  const body = {
    tool: tool.tool,
    action: args.action,
    ...(plan.summary ? { summary: plan.summary } : {}),
    document,
    riser: args.riser,
    counts: plan.counts,
    ...(plan.selection ? { selection: plan.selection } : {}),
    views: plan.views.map(summarise),
    warnings: plan.warnings,
    supersedes_3d: plan.supersedes_3d,
    api_limits: diagramApiLimits(tool.discipline),
    ...(plan.connector_input ? { connector_input: plan.connector_input } : {}),
    report,
    cites: {
      kit: "Generic annotation and detail items FMC_DI_E_SLD_* and FMC_DI_P_Schematic, when loaded. Otherwise lines and text.",
      standards: "FMC-BIM-STD-002",
      rulebook: "A diagram shows the model. A missing rating, load or pipe size is TBC. The earthing view is a template.",
    },
  };
  const refusal = guardOf(snapshot as { model?: string; resolved_document?: { title?: string; path?: string }; is_central?: boolean }, args.document, io, tool.tool);
  if (args.action === "plan" || args.dry_run !== false) {
    if (refusal && args.action === "apply") {
      return reply({ ...body, refused: true, code: "FMC-DIAGRAM-GUARD", dry_run: true, read_only: true, message: refusal }, true);
    }
    return reply({
      ...body,
      read_only: true,
      dry_run: true,
      next: "Apply with dry_run false, batch_lease, and references. That call is one transaction.",
    });
  }
  if (refusal) return reply({ ...body, refused: true, code: "FMC-DIAGRAM-GUARD", message: refusal, saved: false }, true);
  const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
  if (!lease) {
    return reply({ tool: tool.tool, refused: true, code: "FMC-BATCH-LOCKED", dry_run: true, message: "[FMC-BATCH-LOCKED] This write needs batch_lease from fmc_batch request. Nothing was changed." }, true);
  }
  const refs = referenceProblems(args.references);
  if (refs) return reply({ tool: tool.tool, refused: true, code: "FMC-DIAGRAM-REFERENCES", message: refs, saved: false }, true);
  if (!plan.views.length) {
    return reply({ ...body, refused: true, code: "FMC-DIAGRAM-EMPTY", message: "[FMC-DIAGRAM-EMPTY] Nothing to draw.", saved: false }, true);
  }
  try {
    const applyBody = { document: args.document, views: plan.views, references: args.references ?? {} };
    const applied = (io.apply
      ? await io.apply(applyBody)
      : await withRevitConnection((client) => client.sendCommand(tool.applyCommand, applyBody, 300000))) as Record<string, unknown>;
    const ok = applied?.applied === true;
    return reply({ ...body, read_only: false, dry_run: false, saved: false, synced: false, applied }, !ok);
  } catch (error) {
    return reply({ tool: tool.tool, error: error instanceof Error ? error.message : String(error), saved: false }, true);
  }
}
