import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { FMC_SHEETS_SHAPE, runFmcSheets, type FmcSheetsArgs } from "../tools/fmc_sheets.js";
import { FMC_REGISTER_SHAPE, runFmcRegister, type FmcRegisterArgs } from "../tools/fmc_register.js";
import { FMC_BATCH_UNDO_SHAPE, runFmcBatchUndo, type FmcBatchUndoArgs } from "../tools/fmc_batch_undo.js";
import { captureCreated } from "./createdlog.js";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> {
  return { ...(JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: result.isError === true };
}

test("pack dry-runs inside the title block zone and refuses apply when a view overflows", async () => {
  const args = (partial: Record<string, unknown>) => z.object(FMC_SHEETS_SHAPE).parse({ register: "", ...partial }) as FmcSheetsArgs;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-pack-"));
  const read = async () => ({
    title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
    family: "FMC_TB_A1",
    views: [{ id: "1", name: "Level 1", sheet: "A-101", model_width_mm: 4000, model_height_mm: 3000, title_mm: 12 }],
    others: [{ id: "9", name: "Key", sheet: "A-901", model_width_mm: 400, model_height_mm: 300, title_mm: 12 }],
  });
  const dry = textOf(await runFmcSheets(args({ action: "pack", document: "A", sheet: "A-101", min_scale: 20, pair_small: true }), {
    read, env: { ...process.env, LOCALAPPDATA: dir } as NodeJS.ProcessEnv, reportDir: dir,
  }));
  assert.equal(dry.dry_run, true);
  assert.equal((dry.moves as unknown[]).length >= 1, true);
  assert.equal(dry.zone_source, "kit");
  const overflow = textOf(await runFmcSheets(args({
    action: "pack", document: "A", sheet: "A-101", dry_run: false, batch_lease: "lease-1",
    references: { kit: ["FMC-BIM-MAN-001"], standards: ["FMC-BIM-STD-002"], rulebook: ["sheets"] },
    views: ["Huge"],
  }), {
    read: async () => ({ family: "FMC_TB_A1", views: [{ id: "2", name: "Huge", model_width_mm: 1e8, model_height_mm: 1e8, title_mm: 12 }] }),
    apply: async () => { throw new Error("apply must not run"); },
    env: { ...process.env, LOCALAPPDATA: dir } as NodeJS.ProcessEnv, reportDir: dir,
  }));
  assert.equal(overflow.code, "FMC-SHEETS-OVERFLOW");
  assert.equal(overflow.isError, true);
});

test("the drawing register dry-run names the filter and the parked sheet", async () => {
  const args = (partial: Record<string, unknown>) => z.object(FMC_REGISTER_SHAPE).parse(partial) as FmcRegisterArgs;
  const dry = textOf(await runFmcRegister(args({ document: "A", schedule: "G100" }), {
    read: async () => ({
      exists: true,
      schedule: { name: "G100", exists: true, fields: ["Sheet Number"], filters: [], status_parameter: "FMC_Sheet_Status" },
      sheets: [
        { number: "A-101", name: "Plan", revision: "P1", status: "In work" },
        { number: "A-901", name: "Spare", revision: "", status: "PARKED" },
      ],
    }),
  }));
  assert.equal(dry.dry_run, true);
  assert.deepEqual((dry.excluded as Array<{ number: string }>).map((row) => row.number), ["A-901"]);
  assert.equal((dry.add_filters as unknown[]).length, 2);
  const refused = textOf(await runFmcRegister(args({ document: "A", schedule: "G100", dry_run: false }), { read: async () => ({}) }));
  assert.equal(refused.code, "FMC-REGISTER-STATUS");
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_register_read"));
  assert.ok(WRITE_COMMANDS.has("fmc_register_apply"));
});

test("undo after sync deletes only an unchanged created id, and confirm is required", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-undo-"));
  const env = { ...process.env, FMC_CREATED_DIR: dir } as NodeJS.ProcessEnv;
  captureCreated({ document: "Plumbing" }, { applied: true, batch_id: "B09", created: [{ id: 11, fingerprint: "0,0,0|1,1,1" }, { id: 12, fingerprint: "0,0,0|2,2,2" }] }, env);
  const args = (partial: Record<string, unknown>) => z.object(FMC_BATCH_UNDO_SHAPE).parse(partial) as FmcBatchUndoArgs;
  const read = async () => ({
    elements: [
      { id: "11", exists: true, editable: true, fingerprint: "0,0,0|1,1,1" },
      { id: "12", exists: true, editable: true, fingerprint: "9,9,9|9,9,9" },
    ],
  });
  const dry = textOf(await runFmcBatchUndo(args({ batch_id: "B09", document: "Plumbing" }), { env, read }));
  assert.equal(dry.dry_run, true);
  assert.deepEqual((dry.would_delete as Array<{ id: string }>).map((row) => row.id), ["11"]);
  assert.equal((dry.kept as string[]).includes("12"), true);
  const unconfirmed = textOf(await runFmcBatchUndo(args({ batch_id: "B09", document: "Plumbing", dry_run: false, confirm: false }), { env, read }));
  assert.equal(unconfirmed.code, "FMC-UNDO-CONFIRM");
  let deleted: unknown[] = [];
  const applied = textOf(await runFmcBatchUndo(args({
    batch_id: "B09", document: "Plumbing", dry_run: false, confirm: true, batch_lease: "lease-1",
    references: { kit: ["k"], standards: ["s"], rulebook: ["r"] },
  }), {
    env, read,
    apply: async (body) => { deleted = (body.ids as unknown[]) ?? []; return { deleted }; },
  }));
  assert.deepEqual(deleted, ["11"]);
  assert.deepEqual(applied.deleted, ["11"]);
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_batch_undo_read"));
  assert.ok(WRITE_COMMANDS.has("fmc_batch_undo_apply"));
});
