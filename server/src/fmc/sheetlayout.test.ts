import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { drawingFrame, packViews, parkParameter, resolveMargins, type SheetRead } from "./sheetlayout.js";
import { FMC_SHEETS_SHAPE, runFmcSheets, type FmcSheetsArgs } from "../tools/fmc_sheets.js";

function args(partial: Record<string, unknown>): FmcSheetsArgs {
  return z.object(FMC_SHEETS_SHAPE).parse({ register: "", ...partial });
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> {
  return { ...(JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: result.isError === true };
}

const sheet: SheetRead = {
  id: "50",
  number: "A-101",
  name: "Plans",
  titleblock_mm: { min_x: 0, min_y: 0, max_x: 800, max_y: 560 },
  placed: [
    { id: "1", name: "Level 1", width_mm: 300, height_mm: 200 },
    { id: "2", name: "Level 2", width_mm: 300, height_mm: 200 },
  ],
  views: [
    { id: "1", name: "Level 1", width_mm: 300, height_mm: 200 },
    { id: "2", name: "Level 2", width_mm: 300, height_mm: 200 },
    { id: "3", name: "Level 3", width_mm: 900, height_mm: 200, on_sheet: "A-102" },
  ],
  parameters: { "Browser Organization": "Working", FMC_Sheet_Status: "In work" },
};

test("margins are provisional unless the standards bank has them, and packing stays inside the frame", () => {
  const provisional = resolveMargins(null);
  assert.equal(provisional.source, "provisional");
  assert.equal(provisional.can_pass, false);
  assert.equal(provisional.left_mm, 20);
  const approved = resolveMargins({
    "sheets.margin_left_mm": { value: 25, status: "approved" },
    "sheets.margin_other_mm": { value: 12, status: "approved" },
    "sheets.gap_mm": { value: 6, status: "draft" },
  });
  assert.equal(approved.can_pass, true);
  assert.equal(approved.left_mm, 25);
  const frame = drawingFrame(sheet, provisional);
  assert.equal(frame.ok, true);
  if (!frame.ok) return;
  assert.equal(frame.frame.origin_x, 20);
  assert.equal(frame.frame.width, 770);
  const packed = packViews(sheet.views!.slice(0, 2), frame.frame, "grid", provisional.gap_mm);
  assert.equal(packed.placed.length, 2);
  assert.ok(packed.placed.every((row) => row.center_x_mm > frame.frame.origin_x && row.center_y_mm > frame.frame.origin_y));
  const stack = packViews(sheet.views!.slice(0, 2), frame.frame, "stack", 8);
  assert.ok(stack.placed[0].center_y_mm > stack.placed[1].center_y_mm);
  const pair = packViews(sheet.views!.slice(0, 2), frame.frame, "pair", 8);
  assert.ok(pair.placed[1].center_x_mm > pair.placed[0].center_x_mm);
  assert.equal(pair.placed[0].center_y_mm, pair.placed[1].center_y_mm);
  const huge = packViews([{ id: "9", name: "Too big", width_mm: 5000, height_mm: 200 }], frame.frame, "grid", 8);
  assert.equal(huge.skipped[0]?.code, "FMC-SHEETS-NO-FIT");
});

test("park prefers a browser parameter and otherwise FMC_Sheet_Status", () => {
  assert.equal(parkParameter(["Drawn By", "Browser Organization", "FMC_Sheet_Status"]).parameter, "Browser Organization");
  assert.equal(parkParameter(["FMC_Sheet_Status"]).parameter, "FMC_Sheet_Status");
  assert.equal(parkParameter(["Drawn By"]).code, "FMC-SHEETS-PARK-PARAM");
  assert.equal(parkParameter(undefined).parameter, "FMC_Sheet_Status");
});

test("pair, arrange and park dry-run, and a write needs a lease", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-sheets-"));
  const guard: GuardConfig = { ...DEFAULT_CONFIG };
  const env = { ...process.env, LOCALAPPDATA: dir, APPDATA: dir, FMC_SHEETS_DIR: path.join(dir, "sheets"), FMC_STANDARDS_FILE: path.join(dir, "missing.json") } as NodeJS.ProcessEnv;
  const read = async () => ({ title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", path: "D:\\Jobs\\_Staging\\A.rvt", sheets: [sheet] });
  let applied = 0;
  const pair = textOf(await runFmcSheets(args({ action: "pair", document: "A", sheet: "A-101", views: ["Level 1", "Level 2", "Level 3"] }), { read, env, guard, standards: null }));
  assert.equal(pair.dry_run, true);
  assert.equal(pair.status, "PROVISIONAL");
  const ops = pair.ops as Array<{ name: string }>;
  assert.deepEqual(ops.map((row) => row.name), ["Level 1", "Level 2"]);
  assert.ok((pair.skipped as Array<{ code: string }>).some((row) => row.code === "FMC-SHEETS-VIEW-TAKEN"));
  const arrange = textOf(await runFmcSheets(args({ action: "arrange", document: "A", sheet: "A-101", layout: "stack" }), { read, env, guard, standards: null }));
  const stacked = arrange.ops as Array<{ center_y_mm: number }>;
  assert.ok(stacked[0].center_y_mm > stacked[1].center_y_mm);
  const park = textOf(await runFmcSheets(args({ action: "park", document: "A", sheets: ["A-101"], target: "Parked" }), { read, env, guard, standards: null }));
  assert.deepEqual(park.ops, [{ sheet_id: "50", number: "A-101", parameter: "Browser Organization", value: "Parked" }]);
  const refused = textOf(await runFmcSheets(args({ action: "pair", document: "A", sheet: "A-101", views: ["Level 1"], dry_run: false }), { read, env, guard, standards: null }));
  assert.equal(refused.code, "FMC-BATCH-LOCKED");
  assert.equal(applied, 0);
  const refs = { kit: ["FMC-BIM-MAN-001"], standards: ["FMC-BIM-STD-002"], rulebook: ["FMC_Rulebook_AIUse"] };
  const done = textOf(await runFmcSheets(args({ action: "pair", document: "A", sheet: "A-101", views: ["Level 1"], dry_run: false, batch_lease: "lease-1", references: refs }), {
    read, apply: async () => { applied += 1; return { ok: true }; }, env, guard, standards: null,
  }));
  assert.equal(done.dry_run, false);
  assert.equal(applied, 1);
});

test("the layout read is not a write and the apply is", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_sheets_layout"));
  assert.ok(WRITE_COMMANDS.has("fmc_sheets_layout_apply"));
});
