import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// There is no C# test host without the Revit API, so these read the add-in source (as undostatus.test.ts does) and pin
// the shape of the fix: both view reads resolve the call's document and take that document's own view.
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const read = (...p: string[]) => fs.readFileSync(path.join(repo, "commandset", ...p), "utf8");

const context = read("Services", "Fmc", "FmcCallContext.cs");
const info = read("Services", "GetCurrentViewInfoEventHandler.cs");
const elements = read("Services", "GetCurrentViewElementsEventHandler.cs");
const infoCmd = read("Commands", "Access", "GetCurrentViewInfoCommand.cs");
const elementsCmd = read("Commands", "Access", "GetCurrentViewElementsCommand.cs");

test("FmcCallContext.ViewOf: the document's own view, a refusal code when there is none, never another document's view", () => {
  assert.match(context, /public static View ViewOf\(UIApplication app, Document doc\)/);
  assert.match(context, /FMC-VIEW-NONE/);
  assert.match(context, /GetOpenUIViews\(\)/, "a background document uses its own open windows");
  assert.match(context, /view\.Document\.Equals\(doc\)/, "a view of another document is rejected");
  assert.match(context, /active\.Document\.Equals\(doc\)[\s\S]*active\.ActiveView/, "the active document uses the UI active view");
});

test("get_current_view_info and get_current_view_elements take the view from the resolved document, not doc.ActiveView", () => {
  for (const [name, src] of [["info", info], ["elements", elements]] as const) {
    assert.match(src, /FmcCallContext\.Document\(app\)/, `${name}: resolves the passed document`);
    assert.match(src, /FmcCallContext\.ViewOf\(app, doc\)/, `${name}: uses that document's view`);
    assert.doesNotMatch(src, /=\s*doc\.ActiveView/, `${name}: Document.ActiveView follows the active window and is not used`);
  }
});

test("a failed view read throws its error; a null answer or the previous call's answer is never returned", () => {
  for (const [name, src] of [["info", info], ["elements", elements]] as const) {
    assert.match(src, /ResultInfo = null;\s*\n\s*Error = null;/, `${name}: the result is cleared at the start of every call`);
    assert.match(src, /Error = ex\.Message;/, `${name}: the handler keeps the error`);
  }
  for (const [name, src] of [["info", infoCmd], ["elements", elementsCmd]] as const) {
    assert.match(src, /_handler\.Error/, `${name}: the command throws the handler's error`);
    assert.match(src, /_handler\.ResultInfo == null/, `${name}: the command refuses a null result`);
  }
  assert.match(elementsCmd, /StartsWith\("\[FMC-"\)/, "a coded refusal keeps its code");
});
