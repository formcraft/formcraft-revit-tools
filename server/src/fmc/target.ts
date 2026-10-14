import { AsyncLocalStorage } from "node:async_hooks";

/** The `revit` target of the tool call running now (set by the wrapper in tools/register.ts and by the CLI). */
export const revitTarget = new AsyncLocalStorage<string | undefined>();

/**
 * The `document` target of the tool call running now: a document title or a full path. Every command sent to Revit
 * carries it, so Formcraft's commands work on that document even when it's open in the background (or, for reads,
 * open it in the background themselves). Unset: the active document.
 */
export const documentTarget = new AsyncLocalStorage<string | undefined>();

/** The default target chosen with fmc_revit use (lives as long as the MCP server). */
let chosen: string | undefined;
export const getChosen = () => chosen;
export const setChosen = (t: string | undefined) => { chosen = t && t.trim() ? t.trim() : undefined; };
