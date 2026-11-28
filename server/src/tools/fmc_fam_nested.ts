import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FamEditIo, Reply, applyFamily, errorText, famLog, gateProblems, makeCtx, nextStep, readFamily } from "../fmc/famedit_common.js";
import { NestedFamilyRead, checkAssociate, checkReload, checkSwap, reloadRoots } from "../fmc/famnested_plan.js";

export const FMC_FAM_NESTED_DESCRIPTION =
  "Formcraft family editor: nested families in a family document (never a project). read: each nested instance (family, " +
    "type, category, shared, the <Family Type> parameter driving its type, its instance parameters with their data types and " +
    "associations), the families loaded with their types, and the host family's parameters (read only). swap: nested " +
    "instances (ids, names, or a family name for all of its instances) changed to another type, of the same family or another " +
    "loaded one of the same category; load_path loads that family first in the same transaction. associate: a nested " +
    "instance's parameters driven by the host's (associate: {nested parameter: host parameter, or null to remove}; data types " +
    "must match), and/or its type driven by a <Family Type> parameter (type_parameter; create_type_parameter makes it, " +
    "is_instance for an instance one). reload: a nested family replaced from an .rfa with the same name in the family roots " +
    "(staging, 04_Families, library and write roots), parameter values overwritten or kept (overwrite_values); the dry run " +
    "lists the types added and removed. Every change is checked against the read first and refused with the reasons before " +
    "Revit is called; the dry run is the real change rolled back (one transaction), dry_run=false needs confirm=true (one " +
    "Undo). Every reply has a run_id (also in the file log).";

const KEY = z.union([z.number(), z.string()]);
export const FMC_FAM_NESTED_SHAPE = {
  action: z.enum(["read", "swap", "associate", "reload"]),
  document: z.string().optional().default("").describe("The open family document: title or path (an fmc_doc session's document or a family open in Revit)"),
  nested: z.union([KEY, z.array(KEY)]).optional().describe("swap: instances (ids, names or a family name); associate: one instance (id or name)"),
  to_family: z.string().optional().default("").describe("swap: the family of the new type"),
  to_type: z.string().optional().default("").describe("swap: the new type"),
  load_path: z.string().optional().describe("swap: load to_family from this .rfa (family roots) first, in the same transaction"),
  associate: z.record(z.string(), z.string().nullable()).optional().describe("associate: nested instance parameter → host parameter (null removes)"),
  type_parameter: z.string().nullable().optional().describe("associate: the host <Family Type> parameter that drives the nested type (null removes the association)"),
  create_type_parameter: z.boolean().optional().default(false).describe("associate: make type_parameter if the family hasn't got it"),
  is_instance: z.boolean().optional().default(false).describe("associate with create_type_parameter: an instance parameter (default type)"),
  family: z.string().optional().default("").describe("reload: the nested family's name"),
  path: z.string().optional().default("").describe("reload: the .rfa to reload it from (same name, in the family roots)"),
  overwrite_values: z.boolean().optional().default(false).describe("reload: overwrite the nested family's parameter values with the file's"),
  dry_run: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false).describe("swap, associate, reload: needed with dry_run=false, after the person has seen the dry run"),
};
export type FmcFamNestedArgs = z.infer<z.ZodObject<typeof FMC_FAM_NESTED_SHAPE>>;

const keysOf = (v: FmcFamNestedArgs["nested"]) => v === undefined ? [] : Array.isArray(v) ? v : [v];

export async function runFmcFamNested(args: FmcFamNestedArgs, io: FamEditIo = {}): Promise<Reply> {
  const ctx = makeCtx("fmc_fam_nested", args, io);
  const change = args.action !== "read";
  const action = `fam_nested_${args.action}`;
  try {
    const gate = gateProblems(ctx, change, "changes the nested families");
    if (gate.length) return ctx.reply({ refused: true, reasons: gate }, true);
    const read = await readFamily<NestedFamilyRead>(ctx, "fmc_fam_nested_read");
    if (args.action === "read") return ctx.reply({ family: read.family, category: read.category, nested: read.nested, families: read.families, host_parameters: read.host_parameters });
    let payload: object;
    let summary: string;
    let warnings: string[] = [];
    let reasons: string[] = [];
    if (args.action === "swap") {
      const loading = !!args.load_path?.trim();
      const s = checkSwap(read, keysOf(args.nested), args.to_family, args.to_type, loading);
      reasons = s.reasons;
      warnings = s.warnings;
      if (loading) {
        const fam = read.families.find((f) => f.name.toLowerCase() === args.to_family.trim().toLowerCase());
        const r = checkReload({ ...read, families: fam ? read.families : [...read.families, { name: args.to_family, types: [] }] }, args.to_family, args.load_path!.trim(), ctx.config, ctx.exists);
        reasons.push(...r.reasons);
        warnings.push(...r.warnings.filter((w) => !/no placed instance/.test(w)));
      }
      payload = { action: "swap", ids: s.picked.map((n) => n.id), to_family: args.to_family.trim(), to_type: args.to_type.trim(), load_path: loading ? args.load_path!.trim() : null };
      summary = `swap ${s.picked.length} instance(s) to ${args.to_family} : ${args.to_type}${loading ? " (loaded first)" : ""}`;
    } else if (args.action === "associate") {
      const keys = keysOf(args.nested);
      const a = checkAssociate(read, keys.length === 1 ? keys[0] : keys.length ? "" : undefined, args.associate ?? {}, args.type_parameter, args.create_type_parameter);
      if (keys.length > 1) a.reasons.unshift("associate works on one nested instance at a time");
      reasons = a.reasons;
      warnings = a.warnings;
      payload = { action: "associate", id: a.target?.id, associate: args.associate ?? {}, type_parameter: args.type_parameter === undefined ? undefined : args.type_parameter,
        create_type_parameter: args.create_type_parameter, is_instance: args.is_instance };
      summary = `associate on ${a.target?.name || a.target?.id || "?"}: ${Object.keys(args.associate ?? {}).length} parameter(s)${args.type_parameter !== undefined ? `, type ← ${args.type_parameter}` : ""}`;
    } else {
      const r = checkReload(read, args.family, args.path.trim(), ctx.config, ctx.exists);
      reasons = r.reasons;
      warnings = r.warnings;
      payload = { action: "reload", family: args.family.trim(), path: args.path.trim(), overwrite_values: args.overwrite_values };
      summary = `reload ${args.family} from ${args.path}`;
    }
    if (reasons.length) {
      famLog(ctx.config, ctx.dry, ctx.document, "refused", reasons.join("; "), action, ctx.run_id);
      return ctx.reply({ refused: true, reasons, warnings, ...(args.action === "reload" || args.load_path ? { family_roots: reloadRoots(ctx.config) } : {}) }, true);
    }
    const { result, outcome } = await applyFamily(ctx, "fmc_fam_nested_apply", payload, summary, action);
    return ctx.reply({ dry_run: ctx.dry, action: args.action, warnings, result, next: nextStep(ctx, outcome) }, !!result?.failed);
  } catch (error) {
    famLog(ctx.config, ctx.dry, ctx.document || "(none)", "error", errorText(error), action, ctx.run_id);
    return ctx.reply({ error: errorText(error) }, true);
  }
}

export function registerFmcFamNestedTool(server: McpServer) {
  server.tool("fmc_fam_nested", FMC_FAM_NESTED_DESCRIPTION, FMC_FAM_NESTED_SHAPE, (args) => runFmcFamNested(args));
}
