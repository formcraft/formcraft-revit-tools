import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "commandset", "Bridge", "DialogPolicy.cs");
const src = fs.readFileSync(file, "utf8");

test("dialog tier 1 never answers the destructive prompts, and the default allow list stays short", () => {
  for (const word of ["delete", "unjoin", "overwrite", "relinquish", "sync", "save as", "save-as", "upgrade", "license", "sign-in", "corrupt"]) {
    assert.match(src, new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(src, /HardDeny always wins|always wins/);
  assert.match(src, /not saved recently/);
  assert.match(src, /duplicate types/);
  assert.match(src, /duplicate mark/);
  assert.match(src, /dialogs\.allow/);
  assert.match(src, /dialogs\.deny/);
  const failures = fs.readFileSync(path.resolve(path.dirname(file), "FmcFailures.cs"), "utf8");
  assert.match(failures, /AllowWarning/);
  const job = fs.readFileSync(path.resolve(path.dirname(file), "FmcAiJob.cs"), "utf8");
  assert.match(job, /DialogPolicy\.DialogResult/);
  assert.match(job, /Log\(_current, "dialog"/);
});
