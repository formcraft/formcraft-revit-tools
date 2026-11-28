import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";
import { EXPLODE_MAX, asGroupsRead, auditGroups, mirroredGuess, nestingDepth, planExplode, type GroupsRead } from "./groups.js";
import { FMC_GROUPS_SHAPE, runFmcGroups, type FmcGroupsArgs } from "../tools/fmc_groups.js";

const sample: GroupsRead = {
  types: [
    { id: "T1", name: "Chair row", kind: "model" },
    { id: "T2", name: "Chair pair", kind: "model" },
    { id: "T3", name: "Unused typ", kind: "model" },
    { id: "T4", name: "Note cluster", kind: "detail" },
  ],
  instances: [
    { id: "10", type_id: "T1", members: 5, member_family_instances: 4, mirrored_members: 0, nested_group_ids: ["20"], text_notes: 0, attached_parent_id: "", checkout: "", owner: "", workset: "Shared" },
    { id: "12", type_id: "T1", members: 5, member_family_instances: 4, mirrored_members: 0, nested_group_ids: [], text_notes: 0, attached_parent_id: "", checkout: "", owner: "", workset: "Shared" },
    { id: "11", type_id: "T1", members: 5, member_family_instances: 4, mirrored_members: 4, nested_group_ids: ["21"], text_notes: 0, attached_parent_id: "", checkout: "", owner: "", workset: "Shared" },
    { id: "20", type_id: "T2", members: 2, member_family_instances: 2, mirrored_members: 0, nested_group_ids: [], text_notes: 0, attached_parent_id: "", checkout: "", owner: "", workset: "Shared" },
    { id: "21", type_id: "T2", members: 2, member_family_instances: 2, mirrored_members: 0, nested_group_ids: [], text_notes: 0, attached_parent_id: "", checkout: "", owner: "", workset: "Shared" },
    { id: "30", type_id: "T4", members: 3, member_family_instances: 0, mirrored_members: 0, nested_group_ids: [], text_notes: 2, attached_parent_id: "10", checkout: "OwnedByOtherUser", owner: "Ann", workset: "Shared" },
  ],
};

function args(partial: Record<string, unknown>): FmcGroupsArgs {
  return z.object(FMC_GROUPS_SHAPE).parse(partial);
}
function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> {
  return { ...(JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: result.isError === true };
}

test("audit finds unused types, nesting, text in groups, and a likely-mirrored instance", () => {
  const a = auditGroups(sample);
  assert.equal(a.totals.types, 4);
  assert.equal(a.totals.instances, 6);
  assert.deepEqual(a.unused_types.rows.map((r) => r.name), ["Unused typ"]);
  assert.equal(nestingDepth(sample).get("T1"), 2);
  assert.equal(a.nested.rows[0].depth, 2);
  assert.equal(a.text_in_groups.rows[0].type_id, "T4");
  assert.equal(mirroredGuess(sample).get("11"), "likely");
  assert.equal(mirroredGuess(sample).get("10"), "no");
  assert.equal(a.mirrored.rows[0].id, "11");
  assert.equal(a.mirrored.inferred, true);
});

test("explode plan lists members, leaves nested groups, and blocks attached or checked-out instances", () => {
  const plan = planExplode(sample, ["10", "30", "99"], "A");
  assert.deepEqual(plan.not_found, ["99"]);
  const model = plan.rows.find((r) => r.id === "10")!;
  assert.equal(model.members, 5);
  assert.equal(model.nested_groups_stay, 1);
  assert.equal(model.attached_detail_groups, 1);
  assert.equal(model.blocked, undefined);
  assert.equal(plan.rows.find((r) => r.id === "30")!.blocked, "an attached detail group: it follows its model group");
  assert.equal(plan.runnable, 1);
  const both = planExplode(sample, ["20", "21"], "A");
  assert.equal(both.rows.every((r) => r.type_left_unused), true);
});

test("the tool needs document, audit is read-only, and a real explode is refused pending a person's approval", async () => {
  const io = { read: async (body: Record<string, unknown>) => { assert.equal(body.document, "A"); return { title: "A", ...sample }; } };
  assert.equal(textOf(await runFmcGroups(args({ action: "audit" }), io)).code, "FMC-DOC-REQUIRED");
  const audit = textOf(await runFmcGroups(args({ action: "audit", document: "A" }), io));
  assert.equal(audit.read_only, true);
  assert.equal(audit.unused_types.count, 1);
  assert.equal(textOf(await runFmcGroups(args({ action: "explode", document: "A" }), io)).code, "FMC-GROUPS-IDS");
  const too = textOf(await runFmcGroups(args({ action: "explode", document: "A", ids: Array.from({ length: EXPLODE_MAX + 1 }, (_, i) => String(i)) }), io));
  assert.equal(too.code, "FMC-GROUPS-TOO-MANY");
  const dry = textOf(await runFmcGroups(args({ action: "explode", document: "A", ids: ["10", "11"] }), io));
  assert.equal(dry.dry_run, true);
  assert.equal(dry.runnable, 2);
  assert.ok(String(dry.next).includes("Nothing was changed"));
  const real = textOf(await runFmcGroups(args({ action: "explode", document: "A", ids: ["10"], dry_run: false }), io));
  assert.equal(real.code, "FMC-GROUPS-APPROVAL");
  assert.equal(real.isError, true);
});

test("the audit command is classed as a read and listed in command.json; explode is not a write command", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_groups_audit"));
  assert.ok(!WRITE_COMMANDS.has("fmc_groups_audit"));
  assert.ok(!WRITE_COMMANDS.has("fmc_groups_explode"));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(fs.readFileSync(path.resolve(here, "..", "..", "..", "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  assert.ok(manifest.commands.some((row) => row.commandName === "fmc_groups_audit"));
  const source = fs.readFileSync(path.resolve(here, "..", "..", "src", "tools", "fmc_groups.ts"), "utf8");
  assert.ok(source.includes('sendCommand("fmc_groups_audit"'));
  assert.ok(!source.includes("sendRaw"));
  assert.ok(!source.includes("sendCommand(\"fmc_groups_explode"));
});

test("asGroupsRead ignores junk rows", () => {
  const read = asGroupsRead({ types: [{ id: "1", name: "A" }, null], instances: [{ id: "2", type_id: "1", members: "3" }] });
  assert.equal(read.types.length, 1);
  assert.equal(read.instances[0].members, 3);
});
