import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readJsonLines, jobFiles } from "../fmc/jobs.js";
import {
  addRule, blockingDialog, defaultRules, dialogAlerts, dialogCounts, neverAutoReason, readRules, setRuleEnabled,
  type DialogLine, type DialogRule,
} from "../fmc/dialogrules.js";
import { recentDialogs } from "../fmc/dialogs.js";

export const FMC_DIALOG_RULES_DESCRIPTION =
  "Dialog rules that keep Revit pop-ups from blocking unattended work. list: the rules (from " +
  "fmc_dialog_rules.json, or the built-in defaults when that file is missing), recent dialog history with counts by " +
  "dialog_id and answer, any dialog the add-in says is open, and alerts for dialogs that are never answered automatically. " +
  "add: propose a rule (dry_run true, the default) or write it (dry_run false). enable and disable change one rule the same way. " +
  "A rule matches dialog_id, plus an optional message regex and an optional active-document regex, and gives an answer " +
  "(Ok, Cancel, Close, No, CommandLink1..4, a positive OverrideResult, or log) and a scope (ai_jobs or always). " +
  "Save, sync, relinquish, upgrade, recover, fatal and serious-error dialogs are refused, including Save_File, " +
  "RevitSaveOptions, PartitionsSaveToCentral, Worksets_Errors and Changes_Not_Saved. The save reminder's only automatic " +
  "answers are CommandLink3 (Do not save the project, 1003), Cancel or Close. The sync reminder's only automatic answers " +
  "are CommandLink3 (Do not synchronize, 1003), Close or Cancel. This tool does not call Revit and does not read the guard file. " +
  "An older add-in ignores the file until Revit is restarted onto a build that loads it; list still works.";

const ruleShape = z.object({
  id: z.string().optional().describe("Rule id. Default is taken from dialog_id."),
  dialog_id: z.string().describe("Revit dialog id, for example TaskDialog_Project_Not_Saved_Recently."),
  message: z.string().optional().describe("Optional regex tested against the dialog text. Empty matches any text."),
  document: z.string().optional().describe("Optional regex tested against the active document title and path."),
  answer: z.string().describe("Ok, Cancel, Close, No, CommandLink1, CommandLink2, CommandLink3, CommandLink4, a positive OverrideResult, or log."),
  scope: z.enum(["ai_jobs", "always"]).optional().describe("ai_jobs answers only during an AI job. always also answers between jobs. Default ai_jobs."),
  enabled: z.boolean().optional().describe("Default true."),
  note: z.string().optional().describe("Why this answer is safe."),
}).optional();

const shape = {
  action: z.enum(["list", "history", "propose", "add", "enable", "disable"]).optional()
    .describe("list (default) returns rules, counts, the open dialog and alerts. history is the counts and recent lines. propose is a dry run of add. add writes when dry_run is false. enable and disable take rule_id."),
  dry_run: z.boolean().optional().describe("add, enable and disable show the change and write only when this is false. Default true."),
  rule: ruleShape,
  rule_id: z.string().optional().describe("enable and disable: the rule id."),
  enabled: z.boolean().optional().describe("enable and disable: ignored; the action sets it."),
  limit: z.number().int().min(1).max(200).optional().describe("How many recent dialog lines. Default 30."),
};

function reply(body: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

function linesOf(env: NodeJS.ProcessEnv, limit: number): DialogLine[] {
  return readJsonLines(jobFiles(env).revit, Math.max(limit, 800)) as DialogLine[];
}

export function runFmcDialogRules(args: {
  action?: "list" | "history" | "propose" | "add" | "enable" | "disable";
  dry_run?: boolean;
  rule?: Partial<DialogRule>;
  rule_id?: string;
  enabled?: boolean;
  limit?: number;
} = {}, env: NodeJS.ProcessEnv = process.env) {
  const action = args.action ?? "list";
  const limit = args.limit ?? 30;
  const dry = args.dry_run !== false;
  const loaded = readRules(env);
  const lines = linesOf(env, limit);
  const recent = recentDialogs(lines, limit);
  const counts = dialogCounts(lines);
  const alerts = dialogAlerts(lines);
  const blocking = blockingDialog(env);

  if (action === "history") {
    return reply({ read_only: true, counts, recent, alerts, blocking });
  }
  if (action === "list") {
    return reply({
      read_only: true,
      changes_model: false,
      source: loaded.source,
      file: loaded.file,
      file_exists: loaded.file_exists,
      error: loaded.error,
      ignored: loaded.ignored,
      rules: loaded.source === "file" ? loaded.rules : defaultRules(),
      never_auto: [
        "Save_File", "RevitSaveOptions", "PartitionsSaveToCentral", "Worksets_Errors", "Changes_Not_Saved",
        "fatal error", "serious error", "relinquish", "upgrade", "recover", "corrupt", "sync with central", "save",
      ],
      never_auto_reason: neverAutoReason("TaskDialog_Save_File"),
      counts, recent, alerts, blocking,
      defaults: defaultRules().map((item) => ({ dialog_id: item.dialog_id, answer: item.answer, scope: item.scope, note: item.note })),
    });
  }
  if (action === "propose" || action === "add") {
    if (!args.rule) return reply({ refused: true, reason: "add needs a rule" }, true);
    const change = addRule(args.rule, env, action === "propose" ? true : dry);
    return reply({ ...change, alerts, blocking }, change.refused);
  }
  const id = (args.rule_id ?? args.rule?.id ?? "").trim();
  if (!id) return reply({ refused: true, reason: `${action} needs rule_id` }, true);
  const change = setRuleEnabled(id, action === "enable", env, dry);
  return reply({ ...change, alerts, blocking }, change.refused);
}

export function registerFmcDialogRulesTool(server: McpServer) {
  server.tool("fmc_dialog_rules", FMC_DIALOG_RULES_DESCRIPTION, shape, (args) => runFmcDialogRules(args));
}
