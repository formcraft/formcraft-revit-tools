import { test } from "node:test";
import assert from "node:assert/strict";

test("UB-2: the undo dry run lists the plan and posts nothing; an older add-in's plain status is not passed off as a plan", async () => {
  const { undoPlanReply } = await import("../tools/modify_element.js");
  const plan = undoPlanReply({ dry_run: true, posted: false, undoing: [{ id: "b1", label: "Walls", at: "10:00:00" }] }) as Record<string, unknown>;
  assert.equal(plan.posted, false);
  assert.equal((plan.undoing as unknown[]).length, 1);
  const old = undoPlanReply({ undo_list: [] }) as Record<string, unknown>;
  assert.equal(old.plan_supported, false);
  assert.equal(old.posted, false);
  assert.match(String(old.message), /Nothing was undone/);
});
