import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { planTransfer, projectFolder, sameProject, type TransferDoc } from "./transfer.js";
import { FMC_TRANSFER_SHAPE, runFmcTransfer, type FmcTransferArgs } from "../tools/fmc_transfer.js";

const args = (partial: Record<string, unknown>): FmcTransferArgs => z.object(FMC_TRANSFER_SHAPE).parse(partial);
const textOf = (r: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> =>
  ({ ...(JSON.parse(r.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: r.isError === true });

const SRC: TransferDoc = {
  title: "F26901-FMC-ZZ-ZZ-M3-A-0001", path: "D:\\Jobs\\_Staging\\F26901\\01_WIP\\A\\F26901-FMC-ZZ-ZZ-M3-A-0001.rvt", project_number: "F26901",
  items: [
    { id: "1", kind: "view_templates", name: "FMC_A_Plan", signature: "FloorPlan" },
    { id: "2", kind: "view_templates", name: "FMC_A_Section", signature: "Section" },
    { id: "3", kind: "filters", name: "FMC_Fire", signature: "-2000011" },
    { id: "4", kind: "legends", name: "Door legend" },
    { id: "5", kind: "revisions", name: "For tender", key: "For tender|2026-11-28", signature: "Client|FMC" },
    { id: "6", kind: "sheets", name: "Ground floor plan", key: "A-101", signature: "Ground floor plan" },
    { id: "7", kind: "sheets", name: "First floor plan", key: "A-102", signature: "First floor plan" },
    { id: "8", kind: "filters", name: "FMC_Dup", signature: "x" },
    { id: "9", kind: "filters", name: "fmc_dup", signature: "y" },
  ],
};
const DST: TransferDoc = {
  title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", path: "D:\\Jobs\\_Staging\\F26901\\01_WIP\\A\\F26901-FMC-ZZ-ZZ-M3-A-0002_USER.rvt", project_number: "F26901",
  items: [
    { id: "11", kind: "view_templates", name: "FMC_A_Plan", signature: "FloorPlan" },
    { id: "12", kind: "view_templates", name: "fmc_a_section", signature: "CeilingPlan" },
    { id: "16", kind: "sheets", name: "First floor plan", key: "A-201", signature: "First floor plan" },
  ],
};

test("the project folder is above the first 0N_ folder, and two projects never mix", () => {
  assert.equal(projectFolder(SRC.path), "D:\\Jobs\\_Staging\\F26901");
  assert.equal(projectFolder("C:\\Temp\\x.rvt"), "");
  assert.equal(sameProject(SRC, DST).same, true);
  assert.equal(sameProject(SRC, SRC).same, false);
  assert.equal(sameProject(SRC, { ...DST, path: "D:\\Jobs\\_Staging\\F27000\\01_WIP\\x.rvt" }).same, false);
  assert.equal(sameProject(SRC, { ...DST, project_number: "F99999" }).same, false);
  assert.equal(sameProject(SRC, { ...DST, path: "" }).same, false);
});

test("the plan names duplicates and conflicts and never overwrites", () => {
  const plan = planTransfer(SRC, DST, ["view_templates", "filters", "legends", "revisions", "sheets"]);
  assert.deepEqual(plan.ops.map((o) => o.source_id).sort(), ["3", "4", "5", "6", "7"]);
  assert.equal(plan.duplicates[0]?.name, "FMC_A_Plan");
  assert.equal(plan.duplicates[0]?.code, "FMC-TRANSFER-DUPLICATE");
  const section = plan.conflicts.find((c) => c.name === "FMC_A_Section");
  assert.equal(section?.code, "FMC-TRANSFER-CONFLICT");
  assert.equal(section?.target_signature, "CeilingPlan");
  assert.equal(plan.conflicts.filter((c) => c.code === "FMC-TRANSFER-SOURCE-DUPLICATE").length, 2);
  assert.equal(plan.warnings[0]?.code, "FMC-TRANSFER-SHEET-NAME");
  assert.equal(plan.counts.view_templates.duplicate, 1);
  const only = planTransfer(SRC, DST, ["sheets"], ["A-101"]);
  assert.deepEqual(only.ops.map((o) => o.key), ["A-101"]);
});

test("a write needs a dry run, confirm, the same plan_hash and a lease; the dry run copies nothing", async () => {
  const guard: GuardConfig = { ...DEFAULT_CONFIG };
  const read = async () => ({ source: SRC, target: DST });
  let applied = 0;
  const apply = async () => { applied += 1; return { ok: true }; };
  const dry = textOf(await runFmcTransfer(args({ source: SRC.title, target: DST.title }), { read, apply, guard }));
  assert.equal(dry.dry_run, true);
  assert.equal(dry.isError, false);
  assert.match(dry.plan_hash, /^[0-9a-f]{16}$/);
  const noConfirm = textOf(await runFmcTransfer(args({ source: SRC.title, target: DST.title, dry_run: false, plan_hash: dry.plan_hash, batch_lease: "l" }), { read, apply, guard }));
  assert.equal(noConfirm.code, "FMC-GAP-CONFIRM");
  const noHash = textOf(await runFmcTransfer(args({ source: SRC.title, target: DST.title, dry_run: false, confirm: true, batch_lease: "l" }), { read, apply, guard }));
  assert.equal(noHash.code, "FMC-GAP-DRY-RUN-FIRST");
  const stale = textOf(await runFmcTransfer(args({ source: SRC.title, target: DST.title, dry_run: false, confirm: true, plan_hash: "0000000000000000", batch_lease: "l" }), { read, apply, guard }));
  assert.equal(stale.code, "FMC-GAP-PLAN-CHANGED");
  const noLease = textOf(await runFmcTransfer(args({ source: SRC.title, target: DST.title, dry_run: false, confirm: true, plan_hash: dry.plan_hash }), { read, apply, guard }));
  assert.equal(noLease.code, "FMC-BATCH-LOCKED");
  const central = textOf(await runFmcTransfer(args({ source: SRC.title, target: DST.title, dry_run: false, confirm: true, plan_hash: dry.plan_hash, batch_lease: "l" }),
    { read: async () => ({ source: SRC, target: { ...DST, is_central: true } }), apply, guard }));
  assert.equal(central.code, "FMC-GAP-GUARD");
  assert.equal(applied, 0);
  const done = textOf(await runFmcTransfer(args({ source: SRC.title, target: DST.title, dry_run: false, confirm: true, plan_hash: dry.plan_hash, batch_lease: "l" }), { read, apply, guard }));
  assert.equal(done.read_only, false);
  assert.equal(applied, 1);
});

test("another project is refused even on a dry run", async () => {
  const read = async () => ({ source: SRC, target: { ...DST, path: "D:\\Jobs\\_Staging\\F27000\\01_WIP\\B.rvt" } });
  const r = textOf(await runFmcTransfer(args({ source: "a", target: "b" }), { read }));
  assert.equal(r.code, "FMC-TRANSFER-PROJECT");
  assert.equal(r.isError, true);
});

test("the transfer read is a read and the apply is a write", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_transfer_read"));
  assert.ok(WRITE_COMMANDS.has("fmc_transfer_apply"));
});
