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

test("GT-1: verbose family types are one object like compact, so the document can be attached", async () => {
  const { fullReply } = await import("./readcache.js");
  const { attachResolvedDocument } = await import("./docresolve.js");
  const { familyTypesShape } = await import("../tools/get_available_family_types.js");
  const full = attachResolvedDocument(fullReply("get_available_family_types", []), { title: "Project1", path: "C:\\P\\Project1.rvt" }) as Record<string, unknown>;
  assert.deepEqual(full, { count: 0, verbose: true, types: [], resolved_document: { title: "Project1", path: "C:\\P\\Project1.rvt" } });
  assert.deepEqual(fullReply("get_current_view_elements", [1]), [1], "other reads keep their shape");
  const shaped = familyTypesShape({ count: 100, ids: [1] }, 100, false) as Record<string, unknown>;
  assert.equal(shaped.truncated, true);
  assert.equal(shaped.verbose, false);
  assert.equal((familyTypesShape([{ id: 1 }], 100, true) as Record<string, unknown>).count, 1);
});
