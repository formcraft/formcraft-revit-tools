import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("see_view exports a named view from the named document and is a read during a batch", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_view_image"));
  assert.ok(!WRITE_COMMANDS.has("fmc_view_image"));
  const src = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcVision.cs"), "utf8");
  const handler = src.slice(src.indexOf("class FmcViewImageHandler"), src.indexOf("class FmcModelCheckHandler"));
  assert.match(handler, /FmcTarget\.Resolve\(app, Parameters, mayOpen: false\)/);
  assert.match(handler, /doc\.ExportImage\(o\)/);
  assert.match(handler, /InternalException/);
  assert.match(handler, /SetViewsAndSheets\(new List<ElementId> \{ v\.Id \}\)/);
  assert.match(handler, /\["title"\] = doc\.Title/);
  assert.match(handler, /\["path"\] = doc\.PathName/);
  assert.match(handler, /\["view"\] = viewName/);
  assert.doesNotMatch(handler, /RequestViewChange/);
  assert.doesNotMatch(handler, /ActiveUIDocument \?\?/);
  const tool = fs.readFileSync(path.join(root, "server", "src", "tools", "see_view.ts"), "utf8");
  assert.match(tool, /sendCommand\("fmc_view_image"/);
  assert.match(tool, /active window is not switched/);
});
