import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EDITING_REQUESTS, CENTRAL_BUSY, appendConflict, centralBusyReason, conflictCounts, conflictLogPath, namedElementIds, splitCheckout, withoutIds } from "./coordination.js";
import { runDocumentSync } from "./batchsync.js";

test("a locked central defers once and is not a batch failure", async () => {
  assert.equal(centralBusyReason("central model is locked by another user"), CENTRAL_BUSY);
  assert.equal(centralBusyReason("[FMC-CENTRAL-BUSY] currently being accessed"), CENTRAL_BUSY);
  assert.equal(centralBusyReason("Stop AI is on"), null);
  assert.equal(centralBusyReason("[FMC-DOC-BUSY] open transaction"), null);
  const calls: string[] = [];
  const deferred = await runDocumentSync("A-0002_USER", async (_command, params) => {
    calls.push(String(params.action));
    throw new Error("The central model is locked by another user");
  }, { record: () => {} });
  assert.deepEqual(calls, ["reload_latest"]);
  assert.equal(deferred.defer_reason, "central busy");
  assert.equal(deferred.ok, true);
  assert.equal(deferred.synced, false);
  assert.equal(deferred.error, undefined);
});

test("checkout splits owned and stale elements and never asks for the rest", () => {
  const split = splitCheckout(["1", "2", "3", "4"], [
    { id: "1", checkout: "OwnedByOtherUser", owner: "Ada", updates: "CurrentWithCentral" },
    { id: "2", checkout: "OwnedByCurrentUser", owner: "me", updates: "UpdatedInCentral" },
    { id: "3", checkout: "NotOwned", owner: "", updates: "CurrentWithCentral" },
  ]);
  assert.deepEqual(split.kept, ["3", "4"]);
  assert.equal(split.skipped[0].code, "FMC-ELEM-OWNED-BY-OTHER");
  assert.equal(split.skipped[0].owner, "Ada");
  assert.equal(split.skipped[1].code, "FMC-ELEM-NOT-CURRENT");
  const params = { document: "A-0002_USER", ops: [{ op: "move", ids: [1, 3], host: 2 }] };
  const next = withoutIds(params, split.skipped) as { ops: Array<{ ids: number[]; host: number | null }> };
  assert.deepEqual(next.ops[0].ids, [3]);
  assert.equal(next.ops[0].host, null);
  assert.deepEqual(namedElementIds(params).sort(), ["1", "2", "3"]);
});

test("conflicts sit beside the ledger and editing requests are never granted", () => {
  assert.equal(EDITING_REQUESTS.granted, false);
  assert.equal(EDITING_REQUESTS.pending, null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-coord-"));
  const env = { ...process.env, FMC_LEDGER_DIR: dir } as NodeJS.ProcessEnv;
  appendConflict({ at: "2026-11-22T14:11:00Z", document: "A-0002_USER", kind: "central_busy", detail: "locked", code: "FMC-CENTRAL-BUSY" }, env);
  appendConflict({ at: "2026-11-22T14:12:00Z", document: "A-0002_USER", kind: "owned_by_other", detail: "9 Ada", code: "FMC-ELEM-OWNED-BY-OTHER" }, env);
  appendConflict({ at: "2026-11-22T14:12:00Z", document: "S-0001", kind: "not_current", detail: "4", code: "FMC-ELEM-NOT-CURRENT" }, env);
  const counts = conflictCounts(fs.readFileSync(conflictLogPath(env), "utf8"));
  const arch = counts.find((row) => row.document === "A-0002_USER");
  assert.equal(arch?.central_busy, 1);
  assert.equal(arch?.owned_by_other, 1);
  assert.equal(counts.find((row) => row.document === "S-0001")?.not_current, 1);
  assert.match(conflictLogPath(env), /FMC_SyncConflicts\.jsonl$/);
});
