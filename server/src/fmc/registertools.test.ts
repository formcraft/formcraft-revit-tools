import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { callRegistrar, classifyRegistrar, registerTools } from "../tools/register.js";

test("a helper named register* is not the tool registrar", () => {
  const registerFile = (projectFolder: unknown) => {
    if (typeof projectFolder !== "string") {
      throw new TypeError('The "path" argument must be of type string. Received an instance of McpServer');
    }
    return projectFolder;
  };
  const registerFmcReviewTool = () => {};
  assert.deepEqual(classifyRegistrar({ registerFile, registerFmcReviewTool }), { kind: "tool", name: "registerFmcReviewTool" });
  assert.equal(classifyRegistrar({ toolFailure: () => {} }).kind, "helper");
  assert.equal(classifyRegistrar({ registerFile }).kind, "bad");
  assert.throws(() => callRegistrar({ registerFile }, {} as McpServer), /register\*Tool/);
});

test("every tool module registers, and fmc_review is one of them", async () => {
  const names: string[] = [];
  const server = { tool: (name: string) => { names.push(name); } };
  let report;
  try {
    report = await registerTools(server as unknown as McpServer);
  } catch (error) {
    assert.fail(error instanceof Error ? error.message : String(error));
  }
  assert.deepEqual(report.failed, []);
  assert.ok(report.registered.includes("fmc_review"), "fmc_review did not register");
  assert.ok(report.registered.includes("fmc_recipe"), "fmc_recipe did not register");
  assert.ok(report.registered.includes("fmc_template"), "fmc_template did not register");
  assert.ok(names.includes("fmc_review"), "fmc_review never called server.tool");
  assert.ok(report.registered.length >= 40, `only ${report.registered.length} modules registered`);
});
