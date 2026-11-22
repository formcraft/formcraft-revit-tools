import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { screenScript } from "./scriptguard.js";

const ok = (code: string) => assert.equal(screenScript(code, 1_000_000), null, code.slice(0, 80));

test("a method that calls itself is refused, with a fix", () => {
  const hit = screenScript("void Boom() {\n  Boom();\n}\nBoom();\nreturn null;", 1000);
  assert.equal(hit?.code, "FMC-CODE-RECURSION");
  assert.match(hit?.message ?? "", /Boom calls itself/);
  assert.match(hit?.message ?? "", /Fix:/);
  assert.match(hit?.message ?? "", /Nothing was sent to Revit/);
  ok("int Fact(int n) {\n  if (n <= 1) return 1;\n  return n * Fact(n - 1);\n}\nreturn Fact(4);");
  ok("void Walk(Element e) {\n  foreach (Element c in Kids(e)) Walk(c);\n}\nreturn null;");
});

test("while(true) and for(;;) without a break are refused; a break or a bounded loop is kept", () => {
  const endless = screenScript("while (true) {\n  Do();\n}\nreturn null;", 1000);
  assert.equal(endless?.code, "FMC-CODE-LOOP");
  assert.match(endless?.message ?? "", /while\(true\) at line 1/);
  assert.match(endless?.message ?? "", /Fix:/);
  const forever = screenScript("for (;;) {\n  Do();\n}\nreturn null;", 1000);
  assert.equal(forever?.code, "FMC-CODE-LOOP");
  assert.match(forever?.message ?? "", /for\(;;\)/);
  ok("int n = 0;\nwhile (true) { if (++n > 10) break; }\nreturn n;");
  ok("for (int i = 0; i < 3; i++) n++;\nreturn n;");
  ok("while (n < 9) n++;\nreturn n;");
  ok("// while (true) { never(); }\nreturn null;");
  ok("string note = \"while (true) { }\";\nreturn note;");
  const nested = screenScript("while (true) {\n  for (;;) { break; }\n}\nreturn null;", 1000);
  assert.equal(nested?.code, "FMC-CODE-LOOP");
  assert.match(nested?.message ?? "", /while\(true\)/);
});

test("an unscoped collector that reads every parameter is refused; a category or a named parameter is not", () => {
  const crash = [
    "foreach (Element e in new FilteredElementCollector(document)) {",
    "  foreach (Parameter p in e.Parameters) {",
    "    var t = p.StorageType;",
    "    var s = p.AsValueString();",
    "  }",
    "}",
    "return null;",
  ].join("\n");
  const hit = screenScript(crash, 1_000_000);
  assert.equal(hit?.code, "FMC-SEND-CODE-UNSCOPED");
  assert.match(hit?.message ?? "", /OfCategory or OfClass/);
  assert.match(hit?.message ?? "", /LookupParameter/);
  assert.match(hit?.message ?? "", /Nothing was sent to Revit/);
  assert.equal(screenScript(crash, 1_000_000, { allowFullScan: true }), null);
  ok("foreach (Element e in new FilteredElementCollector(document).OfCategory(BuiltInCategory.OST_Walls)) {\n  foreach (Parameter p in e.Parameters) { var t = p.StorageType; }\n}\nreturn null;");
  ok("foreach (Wall w in new FilteredElementCollector(document).OfClass(typeof(Wall)).Cast<Wall>()) {\n  var p = w.get_Parameter(BuiltInParameter.ALL_MODEL_MARK);\n  if (p != null && p.StorageType == StorageType.String) return p.AsString();\n}\nreturn null;");
  ok("var col = new FilteredElementCollector(document);\ncol.OfClass(typeof(Wall));\nforeach (Element e in col) {\n  foreach (Parameter p in e.GetOrderedParameters()) { var t = p.StorageType; }\n}\nreturn null;");
  ok("foreach (Element e in new FilteredElementCollector(document).WhereElementIsNotElementType()) {\n  var p = e.LookupParameter(\"Mark\");\n  return p == null ? \"\" : p.AsString();\n}");
  const ordered = "var all = new FilteredElementCollector(document).ToElements();\nforeach (Element e in all) {\n  foreach (Parameter p in e.ParametersMap) { var s = p.AsValueString(); }\n}\nreturn null;";
  assert.equal(screenScript(ordered, 1_000_000)?.code, "FMC-SEND-CODE-UNSCOPED");
});

test("a script over the size limit is refused before anything else", () => {
  const hit = screenScript("return null;", 5);
  assert.equal(hit?.code, "FMC-CODE-TOO-LARGE");
  assert.match(hit?.message ?? "", /5 characters/);
  assert.match(hit?.message ?? "", /Fix:/);
});

test("the saved add-ons are not refused", () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "addons");
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".cs"));
  assert.ok(files.length >= 3);
  for (const name of files) ok(fs.readFileSync(path.join(dir, name), "utf8"));
});
