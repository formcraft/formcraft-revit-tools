import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { FairQueue, StillQueued, documentRequired } from "./fairqueue.js";
import { RevitClientConnection } from "../utils/SocketClient.js";

test("five documents and no name is refused; one document is not", () => {
  const docs = ["Architecture", "Structure", "Electrical", "Plumbing", "Site"];
  assert.match(documentRequired("fmc_model_edit", docs, undefined) ?? "", /5 documents are open.*Refusing to use the active document/);
  assert.match(documentRequired("fmc_model_edit", docs, "e") ?? "", /matches/);
  assert.equal(documentRequired("fmc_model_edit", docs, "Structure"), undefined);
  assert.equal(documentRequired("fmc_model_edit", ["Only"], undefined), undefined);
  assert.equal(documentRequired("fmc_document_info", docs, undefined), undefined);
});

test("unnamed family creation is allowed when several documents are open; other writes are not", () => {
  const docs = ["Architecture", "Structure", "Electrical"];
  assert.equal(documentRequired("fmc_family_new", docs, undefined), undefined);
  assert.match(documentRequired("fmc_model_edit", docs, undefined) ?? "", /3 documents are open.*Refusing to use the active document/);
  assert.match(documentRequired("fmc_create_document", docs, undefined, "project") ?? "", /3 documents are open.*Refusing to use the active document/);
  assert.equal(documentRequired("fmc_create_document", docs, undefined, "family"), undefined);
});

test("recipe new-family open is allowed with several documents open; existing family or project work still needs a name", () => {
  const docs = ["Architecture", "Structure", "Electrical"];
  const template = { template: "C:\\Templates\\Metric Generic Model.rft" };
  const file = { file: "C:\\Staging\\P\\Existing.rfa" };
  assert.equal(documentRequired("fmc_doc_open", docs, undefined, template), undefined);
  assert.match(documentRequired("fmc_doc_open", docs, undefined, file) ?? "", /3 documents are open.*Refusing to use the active document/);
  assert.match(documentRequired("fmc_doc_open", docs, undefined) ?? "", /3 documents are open.*Refusing to use the active document/);
  assert.match(documentRequired("fmc_doc_apply", docs, undefined) ?? "", /3 documents are open.*Refusing to use the active document/);
  assert.match(documentRequired("fmc_model_edit", docs, undefined) ?? "", /3 documents are open.*Refusing to use the active document/);
  assert.match(documentRequired("fmc_create_document", docs, undefined, "project") ?? "", /3 documents are open.*Refusing to use the active document/);
  const family = "FMC_P_PlumbingEq_Tank_Poly_Elevated";
  for (const command of ["fmc_doc_apply", "fmc_doc_flex", "fmc_doc_save", "fmc_doc_close", "fmc_doc_report", "fmc_doc_screenshot", "fmc_family_inspect", "fmc_family_host_test"]) {
    assert.equal(documentRequired(command, docs, family), undefined, command);
    assert.match(documentRequired(command, docs, undefined) ?? "", /3 documents are open/, command);
  }
  // background is a session inventory, like document_info
  assert.equal(documentRequired("fmc_doc_background", docs, undefined), undefined);
});

test("round robin: one client's batch does not finish before the others start", async () => {
  const queue = new FairQueue();
  const started: string[] = [];
  const work = (client: string, n: number) => queue.enqueue(client, client, async () => {
    started.push(client);
    await new Promise((resolve) => setTimeout(resolve, 12));
    return n;
  }, 5000);
  const arch = Promise.all([1, 2, 3, 4, 5, 6].map((n) => work("arch", n)));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const others = ["struct", "elec", "plumb", "site"].map((client) => work(client, 1));
  const t0 = Date.now();
  await Promise.all([arch, ...others]);
  const elapsed = Date.now() - t0;
  const archsBefore = (client: string) => started.slice(0, started.indexOf(client)).filter((name) => name === "arch").length;
  for (const client of ["struct", "elec", "plumb", "site"]) {
    assert.ok(started.includes(client), client);
    assert.ok(archsBefore(client) <= 2, `${client} waited behind ${archsBefore(client)} arch jobs (${started.join(" ")})`);
  }
  assert.ok(elapsed < 400, `expected well under a serial batch, took ${elapsed} ms`);
  console.error(`fair queue 6+4 calls in ${elapsed} ms; start order ${started.join(" ")}`);
});

test("queue wait answers queued, and the call is not run", async () => {
  const queue = new FairQueue();
  let ran = false;
  const blocker = queue.enqueue("arch", "hold", () => new Promise((resolve) => setTimeout(resolve, 200)));
  const waiting = queue.enqueue("struct", "later", async () => { ran = true; }, 30);
  await assert.rejects(waiting, (error: unknown) => error instanceof StillQueued && /Not failed/.test(error.message));
  assert.equal(ran, false);
  await blocker;
});

test("five clients on one fake Revit: no lost, duplicated, or crossed replies", { timeout: 60_000 }, async () => {
  const seen: string[] = [];
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let msg: { id?: string; params?: { who?: string } };
      try { msg = JSON.parse(buf); } catch { return; }
      buf = "";
      const who = msg.params?.who ?? "";
      seen.push(`${msg.id}:${who}`);
      setTimeout(() => {
        socket.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { id: msg.id, who } }));
      }, 5);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const queue = new FairQueue();
  const clients = ["arch", "struct", "elec", "plumb", "site", "coord"];
  const t0 = Date.now();
  const replies = await Promise.all(clients.map(async (client) => {
    const out: Array<{ id?: string; who?: string }> = [];
    for (let i = 0; i < 8; i++) {
      const reply = await queue.enqueue(client, client, async () => {
        const conn = new RevitClientConnection("127.0.0.1", address.port);
        try { return await conn.sendRaw("fmc_document_info", { who: client, document: client }, 5000) as { id?: string; who?: string }; }
        finally { conn.socket.destroy(); }
      });
      out.push(reply);
    }
    return out;
  }));
  const elapsed = Date.now() - t0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const ids = new Set<string>();
  for (let c = 0; c < clients.length; c++) {
    assert.equal(replies[c].length, 8);
    for (const reply of replies[c]) {
      assert.equal(reply.who, clients[c], `crossed reply ${reply.who} on ${clients[c]}`);
      assert.ok(reply.id && !ids.has(reply.id), `duplicated id ${reply.id}`);
      ids.add(reply.id!);
    }
  }
  assert.equal(ids.size, 48);
  console.error(`5 clients x 8 calls: ${elapsed} ms, ${Math.round(48000 / elapsed)} calls/s equivalent wait, ${ids.size} distinct ids`);
});
