/**
 * The batch line reads the settings that already exist. It does not add its own.
 *
 * Auto-save that actually runs: fmc_guard.json ai_modeller.auto_save_minutes, applied by autoSave() in aigate.ts
 * (testing default 10 minutes, 0 off). Never a workshared model, a background document, a detached or read-only
 * verification copy, a link, or a protected original (including originals on D: once protected_roots names them).
 *
 * Auto-approve that actually runs: the same file, auto_approve true and mode "testing". aigate.ts skips the
 * approval queue for ordinary model changes. A direct sync waits unless auto_approve_sync is also on. Relinquish stays manual.
 *
 * Workshared sync is fmc_guard.json sync_minutes (default 15) and sync_on_batch_end (default true), applied to every
 * open workshared document. A person's own fmc_revit_file sync waits for approval unless auto_approve_sync is on
 * in testing mode with auto_approve, and every sync check passes. Relinquish stays manual. Stop AI and the live-model
 * lock still refuse the batch sync. The pane's admin.scheduledsync toggle is in memory only and is not read.
 */
import fs from "node:fs";
import path from "node:path";
import { syncSettings } from "./batchsync.js";
import { configPath, expandEnv, loadConfig, type GuardConfig } from "./policy.js";
import { loadAiConfig } from "./aiuse_io.js";
import { findRecipes, suggestRecipe } from "./standards.js";
import { kitPaths, recipeIndex } from "./context.js";
import { mergeRulebooks } from "./rules.js";

export const SYNC_NOT_RUN =
  "Not run for this batch. Workshared models sync from fmc_guard.json sync_minutes and sync_on_batch_end. " +
  "A non-workshared model is autosave only. A direct sync waits for approval unless auto_approve_sync is on. Relinquish stays manual.";

/** What auto-approve turns off, and what it does not. */
export const APPROVAL_COVERS = [
  "The approval queue in aiGate (aigate.ts) for an ordinary model-changing command, and only when ai_modeller.mode is testing and auto_approve is true.",
];

export const APPROVAL_DOES_NOT_COVER = [
  "fmc_batch references: kit, standards and rulebook are still required.",
  "A direct fmc_revit_file sync waits for approval unless auto_approve_sync is on and every sync check passes. Relinquish stays manual. The batch line's own sync does not wait, and it still stops for Stop AI and the live-model lock.",
  "Keynotes on fmc_replace (X.YYY_ZZ) and Gate A keynote and library checks (recipes.ts gateA).",
  "Stop AI, the rulebook limits, and the live-model lock.",
];

export interface BatchCareReport {
  approval: "auto" | "manual";
  approval_source: string;
  autosave_minutes: number;
  autosave_source: string;
  sync: "managed" | "off";
  sync_minutes: number;
  sync_on_batch_end: boolean;
  sync_exclude: string[];
  /** Null when every document that is not excluded may sync. */
  sync_documents: string[] | null;
  sync_source: string;
  approval_covers: string[];
  approval_does_not_cover: string[];
}

export function batchCareReport(env: NodeJS.ProcessEnv = process.env): BatchCareReport {
  let approval: "auto" | "manual" = "manual";
  let minutes = 0;
  let mode = "strict";
  let sync = syncSettings(undefined);
  try {
    const cfg = loadConfig(configPath(env)).config;
    const ai = loadAiConfig(cfg, env);
    mode = ai?.mode ?? "strict";
    if (ai?.mode === "testing" && ai.auto_approve === true) approval = "auto";
    minutes = ai?.auto_save_minutes ?? (ai?.mode === "testing" ? 10 : 0);
    sync = syncSettings(cfg);
  } catch { /* no guard file: manual, and do not save */ }
  const syncOn = sync.minutes > 0 || sync.onBatchEnd;
  return {
    approval,
    approval_source: `fmc_guard.json ai_modeller (mode ${mode}, auto_approve). Auto only when mode is testing and auto_approve is true, the same test aigate.ts uses.`,
    autosave_minutes: minutes,
    autosave_source: "fmc_guard.json ai_modeller.auto_save_minutes, applied by autoSave() in aigate.ts. The pane's admin.autosave toggle is in memory only (AdminService.TeamValues) and is not read.",
    sync: syncOn ? "managed" : "off",
    sync_minutes: sync.minutes,
    sync_on_batch_end: sync.onBatchEnd,
    sync_exclude: sync.exclude,
    sync_documents: sync.documents,
    sync_source: "fmc_guard.json sync_minutes and sync_on_batch_end. sync_exclude skips those documents. sync_documents, when set, is the only list that syncs (sync only Structure is [\"Structure\"]). Save the local file, then fmc_revit_file sync with relinquish. Non-workshared models are autosave only. Stop AI and the live-model lock still refuse it.",
    approval_covers: APPROVAL_COVERS,
    approval_does_not_cover: APPROVAL_DOES_NOT_COVER,
  };
}

const DISCIPLINE: Record<string, string> = {
  architecture: "A", arch: "A", structure: "S", struct: "S", electrical: "E", elec: "E",
  plumbing: "P", mechanical: "M", mech: "M", coordination: "Z",
};

export interface CorrectionHelp {
  error: string;
  fix_hints: Array<{ id: string; rule: string; fix_hint: string }>;
  recipes: Array<{ family: string; file: string }>;
  recipe_to_write: { name: string; folder: string } | null;
  template: { name: string; folder: string } | null;
}

export interface CorrectionLookup {
  rules?: Array<{ id: string; rule?: string; fix_hint?: string }>;
  recipes?: Array<{ family: string; file: string }>;
  templateName?: string;
  templateFolder?: string;
}

/** What a bot can try next. Uses the rulebook, the recipe index and suggestRecipe when they are reachable. */
export function correctionHelp(
  input: { error: string; references: { [key: string]: string[] }; label: string; bot: string },
  lookup?: CorrectionLookup,
  cfg?: GuardConfig,
): CorrectionHelp {
  const error = input.error || "failed";
  const hints: CorrectionHelp["fix_hints"] = [];
  const wanted = new Set((input.references.rulebook ?? []).map((id) => id.toLowerCase()));
  const errorText = error.toLowerCase();
  const rules = lookup?.rules ?? rulesFromKit(cfg);
  for (const rule of rules) {
    const id = rule.id.toLowerCase();
    if (!rule.fix_hint) continue;
    if (wanted.has(id) || errorText.includes(id)) hints.push({ id: rule.id, rule: rule.rule ?? "", fix_hint: rule.fix_hint });
  }
  const words = `${input.label} ${input.bot} ${error}`;
  let recipes = lookup?.recipes ?? recipesFromKit(words, cfg);
  const discipline = DISCIPLINE[input.bot.trim().toLowerCase()] ?? "A";
  const recipeToWrite = recipes.length ? null : suggestRecipe(input.label || input.bot || "batch", discipline);
  const folder = lookup?.templateFolder ?? templateFolder(cfg);
  const templateName = lookup?.templateName ?? templateFromRecipe(recipes[0]?.file);
  return {
    error,
    fix_hints: hints.slice(0, 5),
    recipes: recipes.slice(0, 3).map((row) => ({ family: row.family, file: row.file })),
    recipe_to_write: recipeToWrite,
    template: templateName || folder ? { name: templateName || "", folder } : null,
  };
}

function rulesFromKit(cfg?: GuardConfig): Array<{ id: string; rule?: string; fix_hint?: string }> {
  try {
    const config = cfg ?? loadConfig().config;
    const dir = expandEnv(config.rulebooks_dir);
    const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => ({
      name, json: JSON.parse(fs.readFileSync(path.win32.join(dir, name), "utf8")),
    }));
    return mergeRulebooks(files).rules.map((rule) => ({ id: rule.id, rule: rule.rule, fix_hint: rule.fix_hint }));
  } catch { return []; }
}

function recipesFromKit(words: string, cfg?: GuardConfig): Array<{ family: string; file: string }> {
  try {
    const found = findRecipes(recipeIndex(kitPaths(cfg ?? loadConfig().config)), words, 3);
    return found.map((row) => ({ family: row.family, file: row.file }));
  } catch { return []; }
}

function templateFolder(cfg?: GuardConfig): string {
  try { return (cfg ?? loadConfig().config).family_template_dir || ""; } catch { return ""; }
}

function templateFromRecipe(file: string | undefined): string {
  if (!file) return "";
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { template?: string };
    return typeof raw.template === "string" ? raw.template : "";
  } catch { return ""; }
}
