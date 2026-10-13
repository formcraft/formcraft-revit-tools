import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { FMC_UI_DESCRIPTION, FMC_UI_SHAPE, runFmcUi } from "../fmc/ui.js";

export function registerFmcUiTool(server: McpServer) {
  server.tool("fmc_ui", FMC_UI_DESCRIPTION, FMC_UI_SHAPE, (args) =>
    runFmcUi(args, (command, params) => withRevitConnection((c) => c.sendRaw(command, params, 20000))));
}
