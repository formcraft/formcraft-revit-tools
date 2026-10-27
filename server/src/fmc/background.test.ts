import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

// Issue #85, phase 0: every tool takes `document` (a title or full path), and every command sent to Revit carries it,
// so Formcraft's commands work on a background document while the owner keeps the screen.

type Reg = { shape: Record<string, unknown>; handler: (a: Record<string, unknown>, e: unknown) => unknown };

async function wrapped() {
  const { withRevitTarget } = await import("../tools/register.js");
  const { documentTarget, revitTarget } = await import("./target.js");
  const registered: Record<string, Reg> = {};
  const server = { tool: (name: string, _d: string, shape: Record<string, unknown>, handler: any) => { registered[name] = { shape, handler }; } };
  withRevitTarget(server as any);
  return { server: server as any, registered, documentTarget, revitTarget };
}

test("every tool gets document; the tool never sees it, and the call runs with it as its target", async () => {
  const { server, registered, documentTarget } = await wrapped();
  let seen: Record<string, unknown> = {}, target: string | undefined;
  server.tool("demo", "d", { x: z.number() }, (args: Record<string, unknown>) => { seen = args; target = documentTarget.getStore(); });
  assert.ok("document" in registered.demo.shape && "revit" in registered.demo.shape);
  await registered.demo.handler({ x: 1, document: "  D:\\Staging\\FMC_Claude_Workbench.rvt " }, {});
  assert.deepEqual(seen, { x: 1 });
  assert.equal(target, "D:\\Staging\\FMC_Claude_Workbench.rvt");
  await registered.demo.handler({ x: 2 }, {});
  assert.equal(target, undefined);
});

test("a tool with its own document argument keeps it, and it is the target too", async () => {
  const { server, registered, documentTarget } = await wrapped();
  const own = z.string().optional().describe("save_as, close: document title or full path");
  let seen: Record<string, unknown> = {}, target: string | undefined;
  server.tool("fmc_file_like", "d", { action: z.string(), document: own }, (args: Record<string, unknown>) => { seen = args; target = documentTarget.getStore(); });
  assert.equal(registered.fmc_file_like.shape.document, own);
  await registered.fmc_file_like.handler({ action: "close", document: "Project1" }, {});
  assert.deepEqual(seen, { action: "close", document: "Project1" });
  assert.equal(target, "Project1");
});

test("the target goes with every command to Revit, unless the command names its own document", async () => {
  const { RevitClientConnection } = await import("../utils/SocketClient.js");
  const { documentTarget } = await import("./target.js");
  const sent: any[] = [];
  const client = new RevitClientConnection("127.0.0.1", 1);
  client.isConnected = true;
  (client.socket as any).write = (s: string) => { sent.push(JSON.parse(s)); return true; };
  await documentTarget.run("Workbench", async () => {
    void client.sendRaw("fmc_qa_facts", { sheet: [] }, 5).catch(() => {});
    void client.sendRaw("fmc_close_document", { document: "Project1" }, 5).catch(() => {});
  });
  void client.sendRaw("fmc_document_info", {}, 5).catch(() => {});
  // Every call also carries its _fmcActivity tag for the ribbon's AI activity strip (policy.ts callActivity).
  const read = process.env.FMC_CALLER === "pane" ? "person" : "read";
  assert.deepEqual(sent.map((s) => s.params), [
    { sheet: [], document: "Workbench", _fmcActivity: read }, { document: "Project1", _fmcActivity: read }, { _fmcActivity: read },
  ]);
  client.socket.destroy();
});
