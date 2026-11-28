/**
 * The jail of the tool call running now: its document comes from the call's `document` target (tools/register.ts)
 * and the open Revits' instance files. The caller never supplies a root.
 */
import { GuardConfig, loadConfig } from "./policy.js";
import { readInstances } from "./connect.js";
import { documentTarget } from "./target.js";
import { JailKind, JailRoots, JailVerdict, OpenDoc, jailCheck, jailDocumentOf, jailRoots } from "./jail.js";

export interface CallJail { roots: JailRoots; cfg: GuardConfig; problem?: string }

/**
 * `central` asks Revit for a workshared document's central path (fmc_document_info centralPath). When it can't say,
 * the local and its backups are still the jail; the central's folder is left out (narrower, never wider).
 */
export async function callJail(opts: { cfg?: GuardConfig; open?: OpenDoc[]; named?: string; central?: (doc: string) => Promise<string | undefined>; bundled?: string[] } = {}): Promise<CallJail> {
  const cfg = opts.cfg ?? loadConfig().config;
  let open = opts.open;
  if (!open) {
    try { open = readInstances().flatMap((i) => i.documents ?? []); } catch { open = []; }
  }
  const named = opts.named ?? documentTarget.getStore();
  const { doc, problem } = jailDocumentOf(open, named);
  if (doc?.isWorkshared && doc.path && opts.central) {
    try { doc.centralPath = (await opts.central(doc.path)) || undefined; } catch { /* no central folder */ }
  }
  const roots = jailRoots(doc, cfg, opts.bundled ? { bundled: opts.bundled } : {});
  if (problem) roots.notes.unshift(problem);
  return { roots, cfg, problem };
}

/** One path argument through the jail. */
export function checkArg(j: CallJail, kind: JailKind, param: string, value: unknown): JailVerdict {
  return jailCheck(kind, value, j.roots, j.cfg, { param });
}

/** The refusal reply every jailed tool gives (one shape, so a test and a person see the same thing). */
export function jailRefusal(tool: string, v: JailVerdict) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ tool, refused: true, code: v.code, reasons: [v.message],
      next: "Use a path inside this document's project folder (or, for reads, inside read_only_roots). Nothing was read or written." }, null, 2) }],
    isError: true,
  };
}

/** The central of a workshared document, from Revit (fmc_document_info centralPath, add-in cf71214 + this branch). */
export async function revitCentral(doc: string): Promise<string | undefined> {
  const { withRevitConnection } = await import("../utils/ConnectionManager.js");
  const info = await withRevitConnection((c) => c.sendRaw("fmc_document_info", { document: doc }, 15000));
  const central = (info as { active?: { centralPath?: unknown } })?.active?.centralPath;
  return typeof central === "string" && central.trim() ? central.trim() : undefined;
}
