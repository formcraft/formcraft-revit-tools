/**
 * fmc_directshape: DirectShape volumes in a whitelisted category, under a batch lease (gap proposal 25).
 * The work is in fmc/directshape_run.ts; the spec in directshape_spec.ts; the whitelist in directshape_cats.ts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runFmcDirectshape } from "../fmc/directshape_run.js";
import { FMC_DIRECTSHAPE_DESCRIPTION, FMC_DIRECTSHAPE_SHAPE, type FmcDirectshapeArgs } from "../fmc/directshape_args.js";

export { FMC_DIRECTSHAPE_DESCRIPTION, FMC_DIRECTSHAPE_SHAPE, runFmcDirectshape };
export type { FmcDirectshapeArgs };

export function registerFmcDirectshapeTool(server: McpServer) {
  server.tool("fmc_directshape", FMC_DIRECTSHAPE_DESCRIPTION, FMC_DIRECTSHAPE_SHAPE, async (args) => runFmcDirectshape(args as FmcDirectshapeArgs));
}
