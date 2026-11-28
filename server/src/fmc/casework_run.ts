import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Run bookkeeping and the safe shop-PDF swap for fmc_casework.
 *
 * A run id is made for every call, goes back in the reply and into the file log, so two calls (and the rows they wrote) can be
 * told apart. The standards revision says which standards a result was worked out with. The shop PDF is exported under a
 * temporary name beside the current one and swapped in only after Revit reports the export done: a failed export never
 * touches the current PDF.
 */

/** "CW-20261128T104500-a1b2c3": file-name safe, sortable, and random enough that two runs in the same second differ. */
export function newRunId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const t = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}T${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `CW-${t}-${crypto.randomBytes(3).toString("hex")}`;
}

/** Sorted-key JSON, so the same standards always give the same text. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

const sha = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");

export interface StandardsRevision {
  /** Where the values came from (the kit file, the kit file with the call's values over it, or the call alone) */
  from: string;
  /** The kit standards file, and whether it was there */
  kit_file: string;
  kit_file_found: boolean;
  /** The file's own revision label (revision, rev or version), when it carries one: the tool never makes one up */
  label: string | null;
  /** The kit file's modified time and a short hash of its bytes (null when there is no file) */
  kit_file_modified: string | null;
  kit_file_hash: string | null;
  /** A short hash of the standards the result was worked out with (kit file and the call's values merged): equal hashes, equal standards */
  effective_hash: string;
  /** True when the call's own `standards` changed the kit's values */
  call_overrides: boolean;
}

export function standardsRevision(input: { kitFile: string; kitJson: unknown; effective: unknown; from: string; callOverrides: boolean }): StandardsRevision {
  let bytes: Buffer | null = null;
  let modified: string | null = null;
  try { bytes = fs.readFileSync(input.kitFile); modified = fs.statSync(input.kitFile).mtime.toISOString(); } catch { /* no kit file */ }
  const k = input.kitJson && typeof input.kitJson === "object" ? input.kitJson as Record<string, unknown> : {};
  const raw = k.revision ?? k.rev ?? k.version;
  const label = typeof raw === "string" || typeof raw === "number" ? String(raw) : null;
  return {
    from: input.from, kit_file: input.kitFile, kit_file_found: bytes !== null, label,
    kit_file_modified: modified, kit_file_hash: bytes ? sha(bytes).slice(0, 12) : null,
    effective_hash: sha(canonical(input.effective)).slice(0, 12), call_overrides: input.callOverrides,
  };
}

export interface ExportOutcome {
  state: "exported" | "failed";
  /** Why it failed */
  reason?: string;
  /** Where the old PDF went (the swap happened) */
  archived?: string;
  /** The current shop PDF is exactly as it was before the run */
  current_untouched: boolean;
  pdf: string;
}

/** What the add-in says about the PDF it exported: {exported:{result:"exported"}} (a run that rolled back didn't export). */
export function exportReport(result: unknown): { done: boolean; why: string } {
  const r = result && typeof result === "object" ? result as Record<string, unknown> : {};
  if (r.rolled_back === true) return { done: false, why: "Revit rolled the changes back" };
  const e = r.exported && typeof r.exported === "object" ? r.exported as Record<string, unknown> : null;
  if (!e) return { done: false, why: "Revit reported no export" };
  return e.result === "exported" ? { done: true, why: "" } : { done: false, why: String(e.result ?? "Revit didn't export it") };
}

export interface SwapPlan {
  folder: string;
  /** The current shop PDF's file name (name.pdf) */
  finalName: string;
  /** The temporary name given to Revit, without .pdf (Revit adds it) */
  pendingBase: string;
  /** Archive file name for the old PDF, e.g. 20261128-104500_name.pdf */
  archiveName: string;
}

/** The names for one run: the temporary export sits beside the current PDF so the swap is a rename. */
export function swapPlan(folder: string, finalName: string, runId: string, stamp: string): SwapPlan {
  return { folder, finalName, pendingBase: `${finalName.replace(/\.pdf$/i, "")}.pending-${runId}`, archiveName: `${stamp}_${finalName}` };
}

const pendingPath = (s: SwapPlan) => path.join(s.folder, `${s.pendingBase}.pdf`);

/** Removes only this run's temporary export. */
function dropPending(s: SwapPlan) {
  try { fs.rmSync(pendingPath(s), { force: true }); } catch { /* left for the next clean-up; it has a run id in its name */ }
}

/**
 * After Revit has answered (or failed): swap the new PDF in only on success.
 *  success: the old PDF moves to _Archive, the temporary export takes its name (if the last rename fails the old one is put back);
 *  failure: the temporary export is removed and the current PDF is not touched.
 */
export function finishExport(s: SwapPlan, outcome: { result?: unknown; error?: string }): ExportOutcome {
  const current = path.join(s.folder, s.finalName);
  const fail = (reason: string): ExportOutcome => { dropPending(s); return { state: "failed", reason, current_untouched: true, pdf: current }; };
  if (outcome.error !== undefined) return fail(outcome.error);
  const rep = exportReport(outcome.result);
  if (!rep.done) return fail(rep.why);
  let size = 0;
  try { size = fs.statSync(pendingPath(s)).size; } catch { /* missing */ }
  if (size <= 0) return fail("Revit said it exported but no PDF is there");
  let archived: string | undefined;
  try {
    if (fs.existsSync(current)) {
      const dir = path.join(s.folder, "_Archive");
      fs.mkdirSync(dir, { recursive: true });
      archived = path.join(dir, s.archiveName);
      fs.renameSync(current, archived);
    }
    fs.renameSync(pendingPath(s), current);
  } catch (e) {
    // put the old one back so the folder is as it was
    if (archived && !fs.existsSync(current)) { try { fs.renameSync(archived, current); } catch { /* reported below */ } }
    return fail(`The new PDF couldn't be swapped in: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { state: "exported", ...(archived ? { archived } : {}), current_untouched: false, pdf: current };
}
