import { AsyncLocalStorage } from "node:async_hooks";

/** The `revit` target of the tool call running now (set by the wrapper in tools/register.ts and by the CLI). */
export const revitTarget = new AsyncLocalStorage<string | undefined>();

/** The default target chosen with fmc_revit use (lives as long as the MCP server). */
let chosen: string | undefined;
export const getChosen = () => chosen;
export const setChosen = (t: string | undefined) => { chosen = t && t.trim() ? t.trim() : undefined; };
