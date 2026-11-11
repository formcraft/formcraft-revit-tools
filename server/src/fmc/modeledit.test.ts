import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("modify_model apply echoes the same document title and path as the dry run", () => {
  const edit = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcModelEdit.cs"), "utf8");
  const target = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcTarget.cs"), "utf8");
  const stamp = '["document"] = FmcTarget.DescribeState(doc)';
  const dryAt = edit.indexOf('["dry_run"] = true');
  const applyAt = edit.indexOf('["applied"] = true, ["batch_id"]');
  assert.ok(dryAt > 0 && applyAt > dryAt);
  const dry = edit.slice(dryAt, edit.indexOf("g.Assimilate()", dryAt));
  const apply = edit.slice(applyAt, edit.indexOf("return done;", applyAt));
  assert.match(dry, /FmcTarget\.DescribeState\(doc\)/);
  assert.match(apply, /FmcTarget\.DescribeState\(doc\)/);
  assert.equal(edit.split(stamp).length - 1, 2);
  const describe = target.slice(target.indexOf("public static JObject DescribeState"));
  assert.match(describe, /\["title"\] = doc\?\.Title/);
  assert.match(describe, /\["path"\] = doc\?\.PathName/);
});
