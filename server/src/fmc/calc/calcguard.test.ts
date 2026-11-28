import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BOARD_CALCS, confirmProblem, heldIds, holdForBoards, sheetConfirmToken, type PlannedSheet } from "./boards.js";
import { readFacts } from "../../tools/fmc_calc.js";
import type { CalcResult } from "./types.js";

// Tool research 1-25 (fmc_calc, approved 28 Nov): boards that were not read hold the board calcs as TBC; a sheet is
// written only with its own dry run's confirm token.

const result = (id: string, verdict: CalcResult["result"] = "pass"): CalcResult => ({
  id, title: id, role: "E", method: "", method_source: "kit", rows: [], totals: [], tbc: [], notes: [], result: verdict,
});

test("calc: when the boards are not read, CA-E-01 is held as TBC with the reason; other calcs are unchanged", () => {
  assert.deepEqual(BOARD_CALCS, ["CA-E-01"]);
  const out = holdForBoards([result("CA-E-01", "pass"), result("CA-P-01", "pass")], { read: false, reason: "fmc_electrical_facts failed: timeout" });
  assert.equal(out[0].result, "TBC");
  assert.equal(out[0].held?.result_without_boards, "pass");
  assert.match(out[0].held?.reason ?? "", /not run on circuits alone/);
  assert.equal(out[0].tbc.some((t) => /boards/.test(t.item) && /timeout/.test(t.missing)), true);
  assert.equal(out[1].result, "pass");
  assert.equal(out[1].held, undefined);
  assert.deepEqual(heldIds(out), ["CA-E-01"]);
  // a fail found without boards is still held (the person sees what it was)
  const failed = holdForBoards([result("CA-E-01", "fail")], { read: false, reason: "x" });
  assert.equal(failed[0].result, "TBC");
  assert.equal(failed[0].held?.result_without_boards, "fail");
  // boards read: nothing is held
  assert.deepEqual(heldIds(holdForBoards([result("CA-E-01")], { read: true, reason: "" })), []);
});

test("calc: readFacts says the boards were not read when fmc_electrical_facts fails or replies without a list", async () => {
  const failed = await readFacts({ facts_file: "" }, { mep: async () => ({ model: "M" }), boards: async () => { throw new Error("Revit busy"); } });
  assert.equal(failed.boards.read, false);
  assert.match(failed.boards.reason, /Revit busy/);
  assert.match(failed.notes.join(" "), /CA-E-01 held as TBC/);
  const empty = await readFacts({ facts_file: "" }, { mep: async () => ({}), boards: async () => ({ error: "no electrical model" }) });
  assert.equal(empty.boards.read, false);
  assert.match(empty.boards.reason, /no electrical model/);
  const ok = await readFacts({ facts_file: "" }, { mep: async () => ({}), boards: async () => ({ boards: [] }) });
  assert.equal(ok.boards.read, true, "an empty boards list is a read: the model has no boards");
  assert.deepEqual(ok.notes, []);
});

test("calc: a facts file without a boards key is not read; with one it is", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-calc-"));
  const without = path.join(dir, "a.json");
  const withBoards = path.join(dir, "b.json");
  fs.writeFileSync(without, JSON.stringify({ mep: { model: "M" } }));
  fs.writeFileSync(withBoards, JSON.stringify({ mep: { model: "M" }, boards: [{ id: 1, name: "DB", connected_va: 1, demand_va: 1 }] }));
  assert.equal((await readFacts({ facts_file: without })).boards.read, false);
  const read = await readFacts({ facts_file: withBoards });
  assert.equal(read.boards.read, true);
  assert.equal(read.facts.boards.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("calc: the sheet confirm token is the dry run's own; blank or stale is refused", () => {
  const files: PlannedSheet[] = [{ calc: "CA-P-01", result: "pass", tbc: 0, md: "a.md", csv: "a.csv", json: "a.json" }];
  const token = sheetConfirmToken(files, "M", "2026-11-28");
  assert.match(token, /^calc-[0-9a-f]{12}$/);
  assert.equal(sheetConfirmToken(files, "M", "2026-11-28"), token, "the same plan gives the same token");
  assert.notEqual(sheetConfirmToken([{ ...files[0], result: "fail" }], "M", "2026-11-28"), token);
  assert.notEqual(sheetConfirmToken(files, "M", "2026-11-29"), token);
  assert.equal(confirmProblem(token, token), null);
  assert.match(confirmProblem("", token) ?? "", /needs confirm/);
  assert.match(confirmProblem("true", token) ?? "", /does not match/);
});
