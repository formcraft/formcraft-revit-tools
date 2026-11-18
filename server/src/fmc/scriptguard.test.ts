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
