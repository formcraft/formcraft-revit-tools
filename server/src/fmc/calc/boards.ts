/**
 * Tool research 1-25 (fmc_calc, approved 28 Nov). Two guards around the pure calcs:
 *  - boards: when fmc_electrical_facts could not be read (or a facts file has no boards), the calcs that read boards are
 *    held as TBC with the reason, never run on circuits alone with only a note. A sheet for them is refused.
 *  - confirm: a sheet is written only with the confirm token its own dry run returned, so the person has seen exactly
 *    these files and results. A changed plan (other calcs, other facts, another day) needs a new dry run.
 */
import { createHash } from "node:crypto";
import { CalcResult } from "./types.js";

/** Calcs that read facts.boards (CA-E-01 checks its demand against Revit's own demand on the top boards). */
export const BOARD_CALCS = ["CA-E-01"];

export interface BoardsRead { read: boolean; reason: string }

export interface HeldCalc extends CalcResult {
  held?: { reason: string; result_without_boards: CalcResult["result"] };
}

/** Results with every board calc held as TBC when the boards were not read. Others are unchanged. */
export function holdForBoards(results: CalcResult[], boards: BoardsRead): HeldCalc[] {
  if (boards.read) return results;
  return results.map((r): HeldCalc => {
    if (!BOARD_CALCS.includes(r.id)) return r;
    const reason = `Boards not read: ${boards.reason}. ${r.id} is TBC until the boards are read; it was not run on circuits alone.`;
    return {
      ...r,
      result: "TBC",
      tbc: [...r.tbc, { item: "boards (fmc_electrical_facts)", missing: boards.reason, kit_request: false }],
      notes: [...r.notes, reason],
      held: { reason, result_without_boards: r.result },
    };
  });
}

/** The ids held for missing boards. */
export function heldIds(results: HeldCalc[]): string[] {
  return results.filter((r) => r.held).map((r) => r.id);
}

export interface PlannedSheet { calc: string; result: string; tbc: number; md: string; csv: string; json: string }

/** A short token for exactly these planned sheets and results. The dry run returns it; the write must pass it back. */
export function sheetConfirmToken(files: PlannedSheet[], model: string, date: string): string {
  const text = JSON.stringify({ model, date, files: files.map((f) => [f.calc, f.result, f.tbc, f.md, f.csv, f.json]) });
  return "calc-" + createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** null when the write may go ahead, else why it may not. */
export function confirmProblem(given: string, expected: string): string | null {
  const want = given.trim();
  if (!want) return "A sheet write needs confirm: the confirm token from this plan's dry run, after the person has said yes. Nothing was written.";
  if (want !== expected) return "confirm does not match this plan (the calcs, facts, files or date changed since the dry run). Run the dry run again and confirm its token. Nothing was written.";
  return null;
}
