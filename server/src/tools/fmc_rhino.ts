import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { processAlive } from "../fmc/navis.js";
import { PartFacts, RHINO_PART, familyNameProblem, isError, partProblems, readRhinoState, rhinoCall, rhinoPaths, rhinoStateFile } from "../hub/rhino.js";

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

export const FMC_RHINO_DESCRIPTION =
  "Formcraft engineering hub: Rhino 8 (H1), the smooth fixed-shape parts of LOD 400 families (castors, grips, light " +
    "heads, knobs, canopies). Talks to the Formcraft bridge in the open Rhino; parts are built in the bridge's own memory, " +
    "never in the person's drawing, and files are written with openNURBS, so it works whatever the licence state. " +
    "status: Rhino and the bridge. new_doc / open / save: a family's part set (files only in <staging>\\_Rhino). part: " +
    "build named closed solids from the vocabulary (box_rounded, extrude, revolve, pipe, loft, torus, sphere, shell, " +
    "boolean, fillet; mm; each with subcategory, material, visibility fine|medium_fine|all), all or none. check: the rules " +
    "(closed, manifold, 1 mm edge floor, subcategory and material, the type's envelope, mesh weight). render: a shaded PNG " +
    "for the catalogue. export_parts: each part as its own .3dm (Revit reads .3dm directly) plus parts.json, after the " +
    "check passes. describe: the parts and their specs. remove: parts by name. Files: a dry run first.";

export const FMC_RHINO_SHAPE = {
  action: z.enum(["status", "describe", "new_doc", "open", "save", "part", "remove", "check", "render", "export_parts"]),
  family: z.string().optional().default("").describe("The kit family name the parts belong to (FMC_<role>_…)"),
  parts: z.array(z.record(z.string(), z.any())).optional().default([]).describe("part: the parts in order, each { name, op, …values, subcategory, material, visibility }"),
  names: z.array(z.string()).optional().default([]).describe("remove: part names; render, export_parts: only these parts"),
  envelope: z.array(z.number().positive()).length(3).optional().describe("check, export_parts: the type's width, depth, height (mm); no part may be larger"),
  view: z.enum(["iso", "back_iso", "front", "side", "top"]).optional().default("iso"),
  width: z.number().int().min(64).max(4000).optional().default(1600),
  height: z.number().int().min(64).max(4000).optional().default(1200),
  replace: z.boolean().optional().default(false).describe("new_doc, open: replace parts already in the bridge for this family"),
  dry_run: z.boolean().optional().default(true).describe("save, render, export_parts: a dry run says what would be written"),
};

export type FmcRhinoArgs = z.infer<z.ZodObject<typeof FMC_RHINO_SHAPE>>;

const sha256 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export async function runFmcRhino(args: FmcRhinoArgs) {
  const { config } = loadConfig();
  const state = readRhinoState();
  const up = state !== null && processAlive(state.pid);
  if (args.action === "status") {
    if (!state) return reply({ rhino: "not found", detail: `No ${rhinoStateFile()}: Rhino isn't open, or the Formcraft bridge isn't loaded in it (fmc_apps list)` });
    if (!up) return reply({ rhino: "closed", detail: `Rhino (pid ${state.pid}) has closed` });
    try {
      return reply({ rhino: "running", port: state.port, pid: state.pid, ...(await rhinoCall(state.port, "rhino_status", {}, 15000)) });
    } catch (e) {
      return reply({ rhino: "running", port: state.port, pid: state.pid, bridge: e instanceof Error ? e.message : String(e) }, true);
    }
  }
  if (!up) return reply({ refused: true, reasons: ["Rhino with the Formcraft bridge isn't open (fmc_rhino status)"] }, true);
  const nameProblem = familyNameProblem(args.family);
  if (nameProblem) return reply({ refused: true, reasons: [nameProblem] }, true);

  const staging = expandEnv(config.family_staging_root);
  const where = rhinoPaths(staging, args.family, args.view);
  const call = (method: string, params: object = {}) => rhinoCall(state!.port, method, { family: args.family, ...params });
  const guard = (target: string) => checkWritePath(target, config, { checkName: false });

  try {
    switch (args.action) {
      case "describe": return reply(await call("rhino_describe"));
      case "new_doc": return reply(await call("rhino_new_doc", { replace: args.replace }));
      case "remove": return reply(await call("rhino_remove", { names: args.names }));
      case "open": {
        if (!fs.existsSync(where.model)) return reply({ refused: true, reasons: [`No saved parts for ${args.family} at ${where.model}`] }, true);
        return reply(await call("rhino_open", { path: where.model, replace: args.replace }));
      }
      case "part": {
        const bad = args.parts.map((p, i) => ({ i, r: RHINO_PART.safeParse(p) })).filter((x) => !x.r.success)
          .map((x) => `part ${x.i + 1}: ${x.r.error!.issues.map((q) => `${q.path.join(".")} ${q.message}`).join("; ")}`);
        if (args.parts.length === 0) bad.push("Give the parts to build");
        if (bad.length) return reply({ refused: true, reasons: bad }, true);
        const r = await call("rhino_part", { parts: args.parts });
        const problems = partProblems((r.facts ?? []) as PartFacts[], args.envelope);
        return reply({ ...r, problems, next: problems.some(isError) ? "Fix the parts with errors (part again with the same name replaces one)" : "check, render, then export_parts" });
      }
      case "check": {
        const r = await call("rhino_facts");
        const problems = partProblems((r.facts ?? []) as PartFacts[], args.envelope);
        return reply({ family: args.family, ok: !problems.some(isError), problems, facts: r.facts });
      }
      case "save": case "render": case "export_parts": {
        const target = args.action === "save" ? where.model : args.action === "render" ? where.render : where.manifest;
        const v = guard(target);
        if (!v.ok) return reply({ refused: true, reasons: v.reasons }, true);
        if (args.action === "export_parts") {
          const f = await call("rhino_facts");
          let facts = (f.facts ?? []) as PartFacts[];
          if (args.names.length) facts = facts.filter((x) => args.names.includes(x.name));
          const errors = partProblems(facts, args.envelope).filter(isError);
          if (errors.length) return reply({ refused: true, reasons: ["The check found errors: fix them before the parts go to Revit", ...errors] }, true);
        }
        if (args.dry_run) return reply({ dry_run: true, would_write: args.action === "export_parts" ? where.parts : target, next: "Run again with dry_run=false" });
        if (args.action === "save") {
          const r = await call("rhino_save", { path: where.model });
          log(config, "rhino_save", false, where.model, "saved", `${r.parts} parts`);
          return reply(r);
        }
        if (args.action === "render") {
          const r = await call("rhino_render", { path: where.render, view: args.view, width: args.width, height: args.height, ...(args.names.length ? { parts: args.names } : {}) });
          log(config, "rhino_render", false, where.render, "rendered", `${r.parts} parts`);
          return reply(r);
        }
        const r = await call("rhino_export_parts", { folder: where.parts, ...(args.names.length ? { parts: args.names } : {}) });
        const parts = ((r.parts ?? []) as PartFacts[]).map((p) => ({ ...p, sha256: p.file && fs.existsSync(p.file) ? sha256(p.file) : "" }));
        const manifest = { family: args.family, exported: new Date().toISOString(), from: "rhino", to: "revit", units: "mm",
          note: "Each part is a closed solid in its own .3dm, its origin the point Revit places it at (fmc_doc import_part)", parts };
        fs.writeFileSync(where.manifest, JSON.stringify(manifest, null, 2));
        log(config, "rhino_export_parts", false, where.parts, "exported", `${parts.length} parts`);
        return reply({ family: args.family, folder: where.parts, manifest: where.manifest, parts: parts.map((p) => ({ name: p.name, file: p.file, bytes: p.bytes })),
          problems: partProblems(parts, args.envelope) });
      }
    }
    return reply({ error: `Unknown action ${args.action}` }, true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(config, "rhino_" + args.action, args.dry_run, args.family, "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcRhinoTool(server: McpServer) {
  server.tool("fmc_rhino", FMC_RHINO_DESCRIPTION, FMC_RHINO_SHAPE, (args) => runFmcRhino(args));
}
