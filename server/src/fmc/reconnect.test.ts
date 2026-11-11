import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffMs, isConnectionReset, shouldRetryReset } from "./reconnect.js";

test("a reset on a read is retried once; a write is not", () => {
  const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  assert.equal(shouldRetryReset("fmc_document_info", reset, 0), true);
  assert.equal(shouldRetryReset("get_current_view_info", reset, 0), true);
  assert.equal(shouldRetryReset("fmc_document_info", reset, 1), false);
  assert.equal(shouldRetryReset("fmc_model_edit", reset, 0), false);
  assert.equal(shouldRetryReset("delete_element", reset, 0), false);
  assert.equal(shouldRetryReset("send_code_to_revit", new Error("the connection was reset (ECONNRESET)"), 0), false);
  assert.equal(isConnectionReset(new Error("refused")), false);
});

test("backoff grows and then stops growing", () => {
  assert.equal(backoffMs(0), 200);
  assert.equal(backoffMs(1), 400);
  assert.equal(backoffMs(2), 800);
  assert.equal(backoffMs(3), 1600);
  assert.equal(backoffMs(8), 2000);
});
