import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { applyOps, planPrintSets, registerSets } from "./printsets.js";
import { parseRegister } from "./sheets.js";
import { FMC_PRINT_SETS_SHAPE, runFmcPrintSets, type FmcPrintSetsArgs } from "../tools/fmc_print_sets.js";

const rows = [
  ["Number", "Name", "Role", "Issue sets"],
  ["A-0101", "Ground floor plan", "A", "PERMIT+TENDER+CONSTRUCTION"],
  ["A-0102", "First floor plan", "A", "PERMIT+TENDER"],
  ["A-0501", "Door schedule", "A", "TENDER"],
  ["S-0101", "Foundation plan", "S", "CONSTRUCTION"],
  ["A-0901", "Not drawn yet", "A", "PERMIT"],
];
const register = parseRegister(rows).sheets;
const sheets = [
  { id: "11", number: "A-0101", name: "Ground floor plan" },
  { id: "12", number: "A-0102", name: "First floor plan" },
  { id: "15", number: "A-0501", name: "Door schedule" },
  { id: "21", number: "S-0101", name: "Foundation plan" },
];

function args(partial: Record<string, unknown>): FmcPrintSetsArgs {
  return z.object(FMC_PRINT_SETS_SHAPE).parse(partial);
}
function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> {
  return { ...(JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: result.isError === true };
}

test("set names come only from the register, and members follow fmc_issue's planned()", () => {
  assert.deepEqual(registerSets(register), ["PERMIT", "TENDER", "CONSTRUCTION"]);
  const plan = planPrintSets(register, sheets, [], [], { document: "A" });
  const permit = plan.sets.find((s) => s.name === "PERMIT")!;
  assert.equal(permit.action, "create");
  assert.deepEqual(permit.sheet_numbers, ["A-0101", "A-0102"]);
  assert.deepEqual(permit.missing, ["A-0901"], "a register sheet not in the model is listed, never created");
  assert.deepEqual(plan.sets.find((s) => s.name === "CONSTRUCTION")!.sheet_ids, ["11", "21"]);
  const asked = planPrintSets(register, sheets, [], ["permit", "Stage 9"]);
  assert.deepEqual(asked.sets.map((s) => s.name), ["PERMIT"]);
  assert.deepEqual(asked.unknown, ["STAGE 9"]);
});

test("an existing set that differs is skipped unless replace_existing, and an equal one is unchanged", () => {
  const existing = [{ id: "900", name: "Permit", view_ids: ["11", "15", "77"] }, { id: "901", name: "TENDER", view_ids: ["11", "12", "15"] }];
  const plan = planPrintSets(register, sheets, existing);
  const permit = plan.sets.find((s) => s.name === "PERMIT")!;
  assert.equal(permit.action, "skip");
  assert.equal(permit.code, "FMC-PRINTSETS-EXISTS");
  assert.deepEqual(permit.add, ["12"]);
  assert.deepEqual(permit.remove, ["15"]);
  assert.deepEqual(permit.non_sheet_views, ["77"]);
  assert.equal(plan.sets.find((s) => s.name === "TENDER")!.action, "unchanged");
  const replace = planPrintSets(register, sheets, existing, [], { replaceExisting: true });
  assert.equal(replace.sets.find((s) => s.name === "PERMIT")!.action, "update");
  assert.deepEqual(applyOps(replace).map((o) => [o.name, o.action, o.existing_id ?? ""]), [["PERMIT", "update", "900"], ["CONSTRUCTION", "create", ""]]);
  assert.notEqual(replace.plan_hash, plan.plan_hash);
});

test("an empty set and a name Revit refuses are skipped with a code", () => {
  const reg = parseRegister([["Number", "Issue sets"], ["X-0001", "BAD:NAME"], ["X-0002", "LATER"]]).sheets;
  const plan = planPrintSets(reg, [{ id: "1", number: "X-0001", name: "" }], []);
  assert.equal(plan.sets.find((s) => s.name === "BAD:NAME")!.code, "FMC-PRINTSETS-NAME");
  assert.equal(plan.sets.find((s) => s.name === "LATER")!.code, "FMC-PRINTSETS-EMPTY");
  assert.equal(plan.changes, false);
});

test("the tool needs document, dry-runs by default, and a write needs lease, references and the plan_hash", async () => {
  const guard: GuardConfig = { ...DEFAULT_CONFIG };
  const read = async (body: Record<string, unknown>) => { assert.equal(body.document, "A"); return { title: "A", path: "D:\\Jobs\\_Staging\\A.rvt", sheets, sets: [] }; };
  let applied: Record<string, unknown> | null = null;
  const apply = async (body: Record<string, unknown>) => { applied = body; return { sets: [] }; };
  const io = { read, apply, guard, registerRows: () => rows };
  const register = "D:\\Jobs\\F1\\FMC_Sheet_Register.xlsx";
  assert.equal(textOf(await runFmcPrintSets(args({ action: "list" }), io)).code, "FMC-DOC-REQUIRED");
  const list = textOf(await runFmcPrintSets(args({ action: "list", document: "A" }), io));
  assert.equal(list.read_only, true);
  assert.equal(textOf(await runFmcPrintSets(args({ action: "build", document: "A", register: "D:\\x.txt" }), io)).code, "FMC-PRINTSETS-REGISTER");
  const dry = textOf(await runFmcPrintSets(args({ action: "build", document: "A", register }), io));
  assert.equal(dry.dry_run, true);
  assert.equal(dry.sets.length, 3);
  assert.equal(applied, null);
  const refs = { kit: ["FMC_Sheet_Register"], standards: ["STD-002"], rulebook: ["gap 18"] };
  assert.equal(textOf(await runFmcPrintSets(args({ action: "build", document: "A", register, dry_run: false }), io)).code, "FMC-BATCH-LOCKED");
  assert.equal(textOf(await runFmcPrintSets(args({ action: "build", document: "A", register, dry_run: false, batch_lease: "L1" }), io)).code, "FMC-PRINTSETS-REFERENCES");
  assert.equal(textOf(await runFmcPrintSets(args({ action: "build", document: "A", register, dry_run: false, batch_lease: "L1", references: refs, plan_hash: "old" }), io)).code, "FMC-PRINTSETS-STALE");
  assert.equal(applied, null);
  const done = textOf(await runFmcPrintSets(args({ action: "build", document: "A", register, dry_run: false, batch_lease: "L1", references: refs, plan_hash: dry.plan_hash }), io));
  assert.equal(done.dry_run, false);
  assert.equal((applied as any).ops.length, 3);
  assert.equal((applied as any).document, "A");
  const central = { ...io, read: async () => ({ title: "A", path: "D:\\Jobs\\A.rvt", is_central: true, sheets, sets: [] }) };
  assert.equal(textOf(await runFmcPrintSets(args({ action: "build", document: "A", register, dry_run: false, batch_lease: "L1", references: refs, plan_hash: dry.plan_hash }), central)).code, "FMC-PRINTSETS-GUARD");
});

test("the add-in commands are classed and listed in command.json, and the write goes through sendCommand", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_print_sets_read"));
  assert.ok(WRITE_COMMANDS.has("fmc_print_sets_apply"));
  assert.ok(!WRITE_COMMANDS.has("fmc_print_sets_read"));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(fs.readFileSync(path.resolve(here, "..", "..", "..", "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  const names = new Set(manifest.commands.map((row) => row.commandName));
  for (const name of ["fmc_print_sets_read", "fmc_print_sets_apply"]) assert.ok(names.has(name), name);
  const source = fs.readFileSync(path.resolve(here, "..", "..", "src", "tools", "fmc_print_sets.ts"), "utf8");
  assert.ok(source.includes('sendCommand("fmc_print_sets_apply"'));
  assert.ok(!source.includes("sendRaw"));
});
