import path from "node:path";
import { batchLease, documentTarget } from "./target.js";
import { documentsMatch, leaseHeldDocuments } from "./batchline.js";
import { leaseCoversAny } from "./docresolve.js";
import { approvalFor, claimApproval, enqueue, readItem, type QueueItem } from "./aiuse_io.js";
import type { DriveKind } from "./central.js";

const win = path.win32;

/**
 * Follow-up to fmc_central (owner 28 Nov 2026, safety review of bfa82a0):
 *   - a real person's confirmation from the pane (the AI approval queue); plan_token + confirmed_by is not enough
 *   - every write needs a batch lease, on the same terms as fmc_dynamo apply (scriptexec leaseProblem)
 *   - save-as-central and the rule-13 sync have no AI path (CLAUDE.md rule 6) until the owner allows an exception
 *   - temp paths (build and the self-test throwaway) must sit inside the tool-owned temp root, after canonicalisation
 */

export const CENTRAL_APPROVAL = "fmc_central_approval";
export const ISO_FOLDERS_APPROVAL = "fmc_iso_folders_approval";

/** Revit commands that save as a central or sync (rule 13). Person-only; even access=full does not open an AI path. */
export const CENTRAL_PERSON_ONLY_COMMANDS = ["fmc_central_build", "fmc_central_promote", "fmc_central_selftest"] as const;

export const CENTRAL_PERSON_ONLY_REASON =
  "Creating a central (save as central) and its self-test sync are person-only until the owner allows an exception to rule 6 (tools never save or synchronise a workshared model). There is no AI path.";

/** Folder the server and the add-in both use: %LOCALAPPDATA%\Formcraft\central-temp */
export const CENTRAL_TEMP_SEGMENTS = ["Formcraft", "central-temp"] as const;

export function defaultCentralTempRoot(env: NodeJS.ProcessEnv = process.env): string {
  const local = env.LOCALAPPDATA || env.TEMP || "C:\\Temp";
  return win.join(win.normalize(local), ...CENTRAL_TEMP_SEGMENTS);
}

/** Canonical absolute Windows path, no trailing slash (except a drive root). Empty if the path is not usable. */
export function canonicalPath(p: string): string {
  if (!p || !p.trim()) return "";
  const n = win.normalize(p.trim());
  if (!win.isAbsolute(n) && !n.startsWith("\\\\")) return "";
  const resolved = win.normalize(n);
  if (/^[A-Za-z]:\\$/.test(resolved)) return resolved.toUpperCase();
  return resolved.replace(/[\\/]+$/, "");
}

export function isUncPath(p: string): boolean {
  return canonicalPath(p).startsWith("\\\\") || p.trim().startsWith("\\\\");
}

/**
 * True when `child` is `root` or a file/folder inside it, after both paths are canonicalised.
 * A neighbour like `central-temp-evil` is not inside `central-temp`.
 */
export function isInsideDir(child: string, root: string): boolean {
  const c = canonicalPath(child), r = canonicalPath(root);
  if (!c || !r) return false;
  const cl = c.toLowerCase(), rl = r.toLowerCase();
  return cl === rl || cl.startsWith(rl + "\\");
}

export function isNetworkLocation(p: string, kind: (root: string) => DriveKind): boolean {
  const c = canonicalPath(p);
  if (!c) return false;
  if (c.startsWith("\\")) return true;
  // Pass the full path so a test (or a custom kind) can treat a share folder as network even when it shares a letter with the local temp root.
  return kind(c) === "network";
}

export function tempPathProblems(p: string, tempRoot: string, kind: (root: string) => DriveKind): string[] {
  const c = canonicalPath(p);
  if (!c) return [`${p || "(empty)"} is not an absolute path`];
  if (isUncPath(c) || isNetworkLocation(c, kind)) return [`${c} is on a network share; the central temp folder must be a local disk`];
  if (!isInsideDir(c, tempRoot)) return [`${c} is not inside the tool-owned temp root ${canonicalPath(tempRoot)}`];
  return [];
}

export function promoteTargetProblems(target: string, tempRoot: string, kind: (root: string) => DriveKind): string[] {
  const c = canonicalPath(target);
  if (!c) return [`${target || "(empty)"} is not an absolute path`];
  if (isInsideDir(c, tempRoot)) return [`${c} is inside the temp root; the share path must be on the workshare drive`];
  if (!isNetworkLocation(c, kind)) return [`Rule 4: the central goes only on the shared network drive, never local. ${c} is not a network path`];
  if (!c.toLowerCase().includes("\\01_wip\\")) return [`${c} is not under an ISO 19650 01_WIP folder`];
  return [];
}

/** Recursively delete only a folder that canonicalises to inside tempRoot. Throws otherwise. Never used on a share. */
export function deleteOwnTemp(p: string, tempRoot: string, rm: (p: string) => void, kind: (root: string) => DriveKind): void {
  const problems = tempPathProblems(p, tempRoot, kind);
  if (problems.length) throw new Error(`Refusing to delete ${p}: ${problems.join("; ")}`);
  const c = canonicalPath(p);
  const r = canonicalPath(tempRoot);
  if (!c || c.toLowerCase() === r.toLowerCase()) throw new Error(`Refusing to delete the temp root itself: ${p}`);
  rm(c);
}

// ---------------------------------------------------------------- lease (same terms as fmc_dynamo apply)

export function centralLeaseProblem(argsLease: string | undefined, document = ""): string | null {
  const lease = (argsLease ?? batchLease.getStore() ?? "").trim();
  if (!lease) return "[FMC-BATCH-LOCKED] This write needs batch_lease from fmc_batch request.";
  const held = (() => { try { return leaseHeldDocuments(lease); } catch { return []; } })();
  const named = document.trim() || (documentTarget.getStore() ?? "").trim();
  if (held.length && named && !leaseCoversAny(held, { title: named, path: named }, documentsMatch)) {
    return `[FMC-BATCH-LOCKED] Lease ${lease} is for ${held.join(", ")}, not ${named}.`;
  }
  return null;
}

// ---------------------------------------------------------------- person vs AI, pane approval (same queue as the AI gate / fmc_ceiling)

export interface CallerCtx {
  /** The call arrived over MCP (an AI client): never a person's click, whatever the environment says. */
  viaMcp?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** The pane runs the CLI with FMC_CALLER=pane (plugin/Fmc/ServerCli.cs). An MCP call is never a person. */
export const isPerson = (ctx: CallerCtx): boolean => !ctx.viaMcp && (ctx.env ?? process.env).FMC_CALLER === "pane";

export type ApprovalResult =
  | { ok: true; by: string; id: string | null; claim: () => boolean }
  | { ok: false; id: string; message: string };

export function paneApproval(a: {
  command: string;
  person: boolean;
  env: NodeJS.ProcessEnv;
  binding: Record<string, unknown>;
  docPath: string;
  elements: number;
  details: string[];
  now?: Date;
  group?: string;
}): ApprovalResult {
  if (a.person) return { ok: true, by: "person (pane)", id: null, claim: () => true };
  const item = approvalFor(a.command, a.binding, a.docPath, a.env);
  if (item) {
    const held = readItem(item.id, a.env)?.params;
    if (held !== undefined && JSON.stringify(held) === JSON.stringify(a.binding))
      return { ok: true, by: item.by || "person", id: item.id, claim: () => claimApproval(item.id, a.env, a.now) };
  }
  const q: QueueItem = enqueue(a.command, a.binding, a.docPath, a.command, a.group ?? "central", a.elements, a.env, a.now ?? new Date(), a.details);
  return { ok: false, id: q.id, message: `A person has to approve this in the Formcraft pane (Approvals, batch ${q.id}); plan_token and confirmed_by are not an approval. ` +
    `After they approve it, the pane runs it (there is no AI path for save-as-central or the self-test sync).` };
}

/** An AI may not claim a pane approval and then run save-as-central itself. Only the pane (isPerson) may proceed. */
export function personForCentralWrite(ctx: CallerCtx, binding: Record<string, unknown>, docPath: string, elements: number, details: string[], env?: NodeJS.ProcessEnv, now?: Date): ApprovalResult {
  const e = env ?? ctx.env ?? process.env;
  if (isPerson(ctx)) return { ok: true, by: "person (pane)", id: null, claim: () => true };
  const queued = paneApproval({ command: CENTRAL_APPROVAL, person: false, env: e, binding, docPath, elements, details, now, group: "central" });
  if (!queued.ok) return queued;
  return { ok: false, id: queued.id ?? "", message: `Batch ${queued.id} is approved, but save-as-central and the self-test sync have no AI path (rule 6). The pane runs it when a person approves; do not send the create from this session.` };
}

export function approvalForIsoFolders(ctx: CallerCtx, binding: Record<string, unknown>, docPath: string, details: string[]): ApprovalResult {
  return paneApproval({ command: ISO_FOLDERS_APPROVAL, person: isPerson(ctx), env: ctx.env ?? process.env, binding, docPath, elements: 1, details, now: ctx.now?.(), group: "central" });
}
