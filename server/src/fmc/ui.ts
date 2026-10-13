import { z } from "zod";

/**
 * fmc_ui (U11): read and steer the Formcraft pane for UI tests. It runs in the add-in (revit_mcp_plugin.Shell.UiBridgeHost)
 * through the command set's fmc_ui command. It never touches the model, so the live-model lock lets it through
 * (policy.ts PANE_COMMANDS); set_mock_licence works only in test builds of the add-in.
 */
export const FMC_UI_DESCRIPTION =
  "Formcraft pane, for UI tests: read what the pane shows and steer it. Never changes the Revit model, so it works on " +
    "live models. Actions: get_state (screen, licence, group, section, settings tab, open dialog, state banner, footer, " +
    "connection, document, theme, and the groups and sections that can be opened); open_section (a section name such as " +
    "\"QA\" or \"Setup › Templates\", or Connect, Settings, \"Settings › Flow\", Admin); set_mock_licence (test builds " +
    "only: preset signed_out, signed_in, online, offline or grace_over, and optional module statuses); screenshot_pane " +
    "(saves a PNG of the pane to the reports folder and returns its path).";

export const MOCK_PRESETS = ["signed_out", "signed_in", "online", "offline", "grace_over"] as const;
export const MODULE_STATUSES = ["Included", "Active", "Trial", "NotLicensed", "Expired"] as const;

export const FMC_UI_SHAPE = {
  action: z.enum(["get_state", "open_section", "set_mock_licence", "screenshot_pane"]),
  section: z.string().optional().describe("open_section: section name, \"Group › Section\", Connect, Settings, \"Settings › <tab>\" or Admin"),
  preset: z.enum(MOCK_PRESETS).optional().describe("set_mock_licence: the licence state to put the pane in"),
  modules: z.record(z.enum(["Manage", "Flow", "Model", "Build"]), z.enum(MODULE_STATUSES)).optional()
    .describe("set_mock_licence: module statuses to set after the preset, e.g. {\"Build\": \"Active\"}"),
};

export type FmcUiArgs = z.infer<z.ZodObject<typeof FMC_UI_SHAPE>>;

/** What goes to Revit, or why nothing should. Checked here so a bad call fails fast without waiting on Revit. */
export function uiRequest(args: FmcUiArgs): { params?: Record<string, unknown>; problems: string[] } {
  const problems: string[] = [];
  const params: Record<string, unknown> = { action: args.action };
  switch (args.action) {
    case "open_section":
      if (!args.section?.trim()) problems.push("open_section needs section (see get_state groups)");
      else params.section = args.section.trim();
      break;
    case "set_mock_licence":
      if (!args.preset && !args.modules) problems.push("set_mock_licence needs preset, modules or both");
      if (args.preset) params.preset = args.preset;
      if (args.modules) params.modules = args.modules;
      break;
  }
  return problems.length ? { problems } : { params, problems };
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export type Send = (command: string, params: Record<string, unknown>) => Promise<unknown>;

/** The whole tool. `send` is the Revit call (injected so tests run without Revit). */
export async function runFmcUi(args: FmcUiArgs, send: Send) {
  const { params, problems } = uiRequest(args);
  if (!params) return reply({ refused: true, reasons: problems }, true);
  try {
    const result = await send("fmc_ui", params);
    return reply(args.action === "screenshot_pane" ? { saved: result } : { state: result });
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error) }, true);
  }
}
