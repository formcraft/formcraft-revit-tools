import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateGraph, scaffoldGraph, TEMPLATES, validateGraphText, writeDraft } from "./author.js";
import { parseDyn } from "../dynamo.js";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------- authoring ----------
test("author: specs compile to Dynamo JSON that inspect and validate accept; templates validate; drafts never overwrite", () => {
  const spec = {
    name: "Sum", nodes: [
      { key: "a", kind: "number" as const, name: "A", value: 2, is_input: true },
      { key: "b", kind: "number" as const, name: "B", value: 3, is_input: true },
      { key: "sum", kind: "code_block" as const, code: "a+b;", inputs: ["a", "b"] },
      { key: "out", kind: "watch" as const, name: "Result" },
    ],
    wires: [{ from: "a", to: "sum:0" }, { from: "b", to: "sum:1" }, { from: "sum", to: "out:0" }],
  };
  const g = generateGraph(spec);
  assert.ok(g.ok);
  if (!g.ok) return;
  const parsed = parseDyn("Sum.dyn", g.text);
  assert.ok(parsed.ok);
  if (parsed.ok) assert.deepEqual(parsed.inspect.inputs.map((i) => i.name).sort(), ["A", "B"]);
  const v = validateGraphText("Sum.dyn", g.text);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.equal(v.python, false);
  const again = generateGraph(spec);
  assert.ok(again.ok && again.text === g.text, "the same spec gives the same file");
  for (const t of Object.keys(TEMPLATES)) {
    const s = scaffoldGraph(t, `T_${t}`);
    assert.ok(s.ok, t);
    if (s.ok) assert.equal(validateGraphText(`${t}.dyn`, s.text).ok, true, t);
  }
  const bad = generateGraph({ name: "../x", nodes: [{ key: "a", kind: "shell" as never }], wires: [{ from: "a", to: "zz:0" }] });
  assert.equal(bad.ok, false);
  const py = generateGraph({ name: "Py", nodes: [{ key: "p", kind: "python", code: "import os" }], wires: [] });
  assert.ok(py.ok && validateGraphText("py.dyn", py.text).python === true);
  const root = tmp("b6proj-");
  const w1 = writeDraft(root, "Sum", g.text);
  const w2 = writeDraft(root, "Sum", g.text);
  assert.ok(w1.ok && w2.ok && w1.file !== w2.file);
  assert.equal(writeDraft("", "Sum", g.text).ok, false);
});

