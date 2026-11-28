import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FamEditIo, Reply, applyFamily, errorText, famLog, gateProblems, makeCtx, nextStep, readFamily } from "../fmc/famedit_common.js";
import { ConnectorRead, DOMAINS, FamilyConnectors, SIZE_KEYS, checkConnector, validateConnectors } from "../fmc/famconn_rules.js";

export const FMC_FAM_CONNECTOR_DESCRIPTION =
  "Formcraft family editor: MEP connectors in a family document (never a project). read: each connector's domain, system " +
    "classification, flow direction, shape, size in mm, primary flag, linked connector and which family parameter drives each " +
    "size, flow and electrical parameter, plus the family's parameters with their data types (read only). validate: the read " +
    "checked against the rules: a system classification that isn't the domain's (or Fitting/Global outside fittings), a flow " +
    "direction on electrical, cable tray or conduit, a size parameter that doesn't fit the shape or domain, a size driven by a " +
    "parameter of the wrong data type or one the family lacks, two primaries in a domain, and links across domains are errors; " +
    "an undriven size, no flow direction or no primary are warnings (the engineer decides, rule 5). set: change one connector's " +
    "system, flow direction and parameter associations (associate: {diameter|radius|width|height|duct_flow|pipe_flow|voltage|" +
    "poles|apparent_load|power_factor: \"<family parameter>\" or null to remove}). add: a connector on a planar face of a solid " +
    "(host element_id or an fmc_doc solid name, and side) with domain, system, shape, size, flow and associations. set and add " +
    "are validated first and an invalid combination is refused with the reasons before Revit is called; the dry run is the real " +
    "change rolled back (one transaction), dry_run=false needs confirm=true (one Undo). Every reply has a run_id (also in the file log).";

const ASSOC = z.record(z.string(), z.string().nullable());
export const FMC_FAM_CONNECTOR_SHAPE = {
  action: z.enum(["read", "validate", "set", "add"]),
  document: z.string().optional().default("").describe("The open family document: title or path (an fmc_doc session's document or a family open in Revit)"),
  connector: z.union([z.number(), z.string()]).optional().describe("set: the connector's element id or name"),
  name: z.string().optional().describe("add: a name for the new connector (kept with it, so a re-run skips it)"),
  domain: z.enum(["duct", "pipe", "electrical", "cable_tray", "conduit"]).optional().describe("add: the connector's domain"),
  system: z.string().optional().describe("set, add: the system classification (Revit's name, e.g. SupplyAir, DomesticColdWater, PowerBalanced)"),
  flow_direction: z.enum(["In", "Out", "Bidirectional"]).optional().describe("set, add: duct and pipe only"),
  shape: z.enum(["round", "rectangular", "oval"]).optional().describe("add: duct round, rectangular or oval; pipe and conduit round; cable tray rectangular"),
  size: z.object({ diameter: z.number().positive().optional(), width: z.number().positive().optional(), height: z.number().positive().optional() }).optional()
    .describe("add: mm"),
  host: z.object({ element_id: z.number().int().optional(), solid: z.string().optional(), side: z.enum(["top", "bottom", "left", "right", "front", "back"]).optional().default("top") }).optional()
    .describe("add: the solid whose planar face takes the connector (its element id, or its fmc_doc name) and which side"),
  associate: ASSOC.optional().describe("set, add: connector parameter → family parameter (null removes the association)"),
  dry_run: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false).describe("set, add: needed with dry_run=false, after the person has seen the dry run"),
};
export type FmcFamConnectorArgs = z.infer<z.ZodObject<typeof FMC_FAM_CONNECTOR_SHAPE>>;

function findConnector(read: FamilyConnectors, key: number | string | undefined): ConnectorRead | undefined {
  if (key === undefined || key === "") return undefined;
  return read.connectors.find((c) => c.id === Number(key) || (c.name ?? "").toLowerCase() === String(key).toLowerCase());
}

/** The connector as it would be after the change, for the rules. */
export function simulate(args: FmcFamConnectorArgs, before: ConnectorRead | undefined): ConnectorRead {
  const base: ConnectorRead = before ? { ...before, associations: { ...(before.associations ?? {}) } }
    : { id: -1, name: args.name ?? "new connector", domain: args.domain ?? "", shape: args.shape ?? (args.domain === "cable_tray" ? "rectangular" : args.domain === "electrical" ? null : "round"), associations: {} };
  if (args.system !== undefined) base.system = args.system;
  if (args.flow_direction !== undefined) base.flow_direction = args.flow_direction;
  for (const [k, v] of Object.entries(args.associate ?? {})) base.associations![k] = v;
  return base;
}

function changeProblems(args: FmcFamConnectorArgs, read: FamilyConnectors): { target?: ConnectorRead; reasons: string[]; warnings: string[] } {
  const reasons: string[] = [];
  let target: ConnectorRead | undefined;
  if (args.action === "set") {
    target = findConnector(read, args.connector);
    if (!target) return { reasons: [`No connector ${args.connector ?? "(none given)"} in the family; read lists them`], warnings: [] };
    if (args.system === undefined && args.flow_direction === undefined && !args.associate) reasons.push("set needs system, flow_direction or associate");
  } else {
    if (!args.domain) reasons.push(`add needs a domain (${DOMAINS.join(", ")})`);
    if (!args.host || (args.host.element_id === undefined && !args.host.solid)) reasons.push("add needs host: the solid's element_id or its fmc_doc solid name, and a side");
    if (args.name && read.connectors.some((c) => (c.name ?? "").toLowerCase() === args.name!.toLowerCase())) reasons.push(`The family already has a connector named ${args.name}`);
    const s = args.size ?? {};
    if (args.domain && args.domain !== "electrical") {
      const round = (args.shape ?? (args.domain === "cable_tray" ? "rectangular" : "round")) === "round";
      if (round && s.diameter === undefined) reasons.push(`A round ${args.domain} connector needs size.diameter (mm)`);
      if (!round && (s.width === undefined || s.height === undefined)) reasons.push(`A ${args.shape ?? "rectangular"} ${args.domain} connector needs size.width and size.height (mm)`);
      if (round && (s.width !== undefined || s.height !== undefined)) reasons.push("A round connector takes size.diameter, not width or height");
    } else if (args.domain === "electrical" && Object.keys(s).length) reasons.push("An electrical connector has no size");
  }
  for (const k of Object.keys(args.associate ?? {})) if (!SIZE_KEYS[k]) reasons.push(`associate: ${k} isn't one of ${Object.keys(SIZE_KEYS).join(", ")}`);
  const after = simulate(args, target);
  const chk = checkConnector(after, read.parameters, read.category);
  return { target, reasons: [...reasons, ...chk.errors], warnings: chk.warnings };
}

export async function runFmcFamConnector(args: FmcFamConnectorArgs, io: FamEditIo = {}): Promise<Reply> {
  const ctx = makeCtx("fmc_fam_connector", args, io);
  const change = args.action === "set" || args.action === "add";
  try {
    const gate = gateProblems(ctx, change, "changes the family's connectors");
    if (gate.length) return ctx.reply({ refused: true, reasons: gate }, true);
    const read = await readFamily<FamilyConnectors>(ctx, "fmc_fam_connector_read");
    if (args.action === "read") return ctx.reply({ family: read.family, category: read.category, connectors: read.connectors, parameters: read.parameters });
    const v = validateConnectors(read);
    if (args.action === "validate") {
      famLog(ctx.config, true, ctx.document, v.ok ? "valid" : "invalid", `${read.connectors.length} connector(s), ${v.errors.length} error(s), ${v.warnings.length} warning(s)`, "fam_connector_validate", ctx.run_id);
      return ctx.reply({ family: read.family, category: read.category, ...v });
    }
    const p = changeProblems(args, read);
    if (p.reasons.length) {
      famLog(ctx.config, ctx.dry, ctx.document, "refused", p.reasons.join("; "), `fam_connector_${args.action}`, ctx.run_id);
      return ctx.reply({ refused: true, reasons: p.reasons, warnings: p.warnings }, true);
    }
    const assoc = Object.fromEntries(Object.entries(args.associate ?? {}).map(([k, val]) => [k, { revit: SIZE_KEYS[k].revit, param: val }]));
    const payload = args.action === "set"
      ? { action: "set", connector: p.target!.id, system: args.system, flow_direction: args.flow_direction, associate: assoc }
      : { action: "add", name: args.name, domain: args.domain, system: args.system, shape: args.shape, size: args.size ?? {}, host: args.host, flow_direction: args.flow_direction, associate: assoc };
    const { result, outcome } = await applyFamily(ctx, "fmc_fam_connector_apply", payload,
      args.action === "set" ? `set connector ${p.target!.name || p.target!.id}` : `add ${args.domain} connector ${args.name ?? ""}`.trim(), `fam_connector_${args.action}`);
    return ctx.reply({ dry_run: ctx.dry, action: args.action, warnings: p.warnings, result, next: nextStep(ctx, outcome) }, !!result?.failed);
  } catch (error) {
    famLog(ctx.config, ctx.dry, ctx.document || "(none)", "error", errorText(error), `fam_connector_${args.action}`, ctx.run_id);
    return ctx.reply({ error: errorText(error) }, true);
  }
}

export function registerFmcFamConnectorTool(server: McpServer) {
  server.tool("fmc_fam_connector", FMC_FAM_CONNECTOR_DESCRIPTION, FMC_FAM_CONNECTOR_SHAPE, (args) => runFmcFamConnector(args));
}
