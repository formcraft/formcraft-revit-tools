import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { batchHasExtent, wantsAfterPicture } from "../tools/modify_element.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tool = fs.readFileSync(path.join(root, "server", "src", "tools", "modify_element.ts"), "utf8");

test("a picture is off unless picture or snapshot is true, and elements with no extent are skipped", () => {
  assert.equal(wantsAfterPicture({}), false);
  assert.equal(wantsAfterPicture({ picture: false, snapshot: false }), false);
  assert.equal(wantsAfterPicture({ picture: true }), true);
  assert.equal(wantsAfterPicture({ snapshot: true }), true);
  assert.equal(batchHasExtent([{ op: "create_wall" }]), true);
  assert.equal(batchHasExtent([{ op: "create_wall" }, { op: "tag" }]), true);
  assert.equal(batchHasExtent([{ op: "reference_plane" }]), false);
  assert.equal(batchHasExtent([{ op: "tag" }, { op: "create_view" }]), false);
  assert.match(tool, /picture: z\.boolean\(\)\.optional\(\)\.default\(false\)/);
  assert.match(tool, /Default false/);
  assert.match(tool, /wantsAfterPicture\(args\) && ids\.length && batchHasExtent/);
  assert.doesNotMatch(tool, /snapshot \?\? /);
  assert.match(tool, /no extent/);
});
