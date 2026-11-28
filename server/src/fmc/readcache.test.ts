import { test } from "node:test";
import assert from "node:assert/strict";
import { WRITE_COMMANDS } from "./policy.js";
import {
  CACHED_READS, compactReply, invalidateIfWrite, invalidateReads, putCachedRead, resetReadCache, takeCachedRead, wantsFull,
} from "./readcache.js";

test("levels, types and views are cached until a write or a lease release; document info always goes to Revit", () => {
  resetReadCache();
  assert.equal("fmc_document_info" in CACHED_READS, false);
  const probe = { id: "1794375937414963421", who: "arch" };
  putCachedRead("fmc_document_info", { who: "arch", document: "arch" }, "arch", probe);
  assert.equal(takeCachedRead("fmc_document_info", { who: "arch", document: "arch" }, "arch"), undefined);
  const info = { active: { title: "Plumbing", path: "D:\\P.rvt", isWorkshared: true, levels: [{ id: 1, name: "GF" }, { id: 2, name: "FF" }] } };
  assert.equal(CACHED_READS.analyze_model_statistics, "levels");
  assert.equal(CACHED_READS.get_available_family_types, "types");
  assert.equal(CACHED_READS.fmc_type_facts, "types");
  assert.equal(CACHED_READS.get_current_view_info, "views");
  putCachedRead("analyze_model_statistics", {}, "Plumbing", info);
  const compact = compactReply(takeCachedRead("analyze_model_statistics", {}, "Plumbing")) as { active: { title: string; path: string; levels: { count: number; ids: number[] } } };
  assert.equal(compact.active.title, "Plumbing");
  assert.equal(compact.active.path, "D:\\P.rvt");
  assert.deepEqual(compact.active.levels, { count: 2, ids: [1, 2] });
  assert.equal(wantsFull({ verbose: true }), true);
  assert.equal(wantsFull({}), false);
  invalidateIfWrite("fmc_model_edit", "Plumbing");
  assert.equal(takeCachedRead("analyze_model_statistics", {}, "Plumbing"), undefined);
  assert.ok(WRITE_COMMANDS.has("fmc_model_edit"));
  putCachedRead("get_current_view_info", {}, "Plumbing", { name: "L1", id: 9 });
  const first = takeCachedRead("get_current_view_info", {}, "Plumbing") as { id: number };
  const second = takeCachedRead("get_current_view_info", {}, "Plumbing") as { id: number };
  first.id = 1;
  assert.equal(second.id, 9);
  invalidateReads("Plumbing");
  assert.equal(takeCachedRead("get_current_view_info", {}, "Plumbing"), undefined);
});
