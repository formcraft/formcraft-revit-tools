import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Every tool's input schema, converted the way the MCP SDK's tools/list does (strictUnions, pipeStrategy "input").
// The Claude API rejects a tool whose schema has "items" as an array (what z.tuple produces), and the client then drops
// the whole tool: that hid fmc_doc from Claude (issue #85). This walks every schema for that and other forms it rejects.
async function allToolSchemas(): Promise<Record<string, unknown>> {
  const { registerTools } = await import("../tools/register.js");
  const schemas: Record<string, unknown> = {};
  const server = {
    tool: (name: string, _description: string, shape: Record<string, z.ZodTypeAny>) => {
      schemas[name] = zodToJsonSchema(z.object(shape), { strictUnions: true, pipeStrategy: "input" });
    },
  };
  const quiet = console.error;
  console.error = () => {};
  try { await registerTools(server as any); } finally { console.error = quiet; }
  return schemas;
}

function problems(node: unknown, at: string, out: string[]) {
  if (Array.isArray(node)) { node.forEach((n, i) => problems(n, `${at}/${i}`, out)); return; }
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "items" && Array.isArray(v)) out.push(`${at}/items is an array (a tuple): use z.array(...).length(n)`);
    if (k === "additionalItems") out.push(`${at}/additionalItems (a tuple)`);
    problems(v, `${at}/${k}`, out);
  }
}

test("every tool's input schema is one the Claude API accepts (no tuple items)", async () => {
  const schemas = await allToolSchemas();
  assert.ok(Object.keys(schemas).length >= 30, `only ${Object.keys(schemas).length} tools registered`);
  assert.ok("fmc_doc" in schemas, "fmc_doc is registered");
  const found: string[] = [];
  for (const [name, s] of Object.entries(schemas)) problems(s, name, found);
  assert.deepEqual(found, []);
});

test("fmc_doc's points and plane pairs still demand exactly two values", async () => {
  const { OP } = await import("./ops.js");
  assert.ok(OP.safeParse({ op: "add_ref_plane", name: "Left", from: [0, 0], to: [0, 100] }).success);
  assert.ok(!OP.safeParse({ op: "add_ref_plane", name: "Left", from: [0], to: [0, 100] }).success);
  assert.ok(!OP.safeParse({ op: "add_ref_plane", name: "Left", from: [0, 0, 0], to: [0, 100] }).success);
  assert.ok(OP.safeParse({ op: "add_dimension", name: "Width", between: ["Left", "Right"] }).success);
  assert.ok(!OP.safeParse({ op: "add_dimension", name: "Width", between: ["Left"] }).success);
});

test("the check itself catches a tuple", () => {
  const found: string[] = [];
  problems(zodToJsonSchema(z.object({ p: z.tuple([z.number(), z.number()]) }), { strictUnions: true, pipeStrategy: "input" }), "t", found);
  assert.equal(found.length, 1);
});
