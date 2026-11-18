import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { queueClient } from "./fairqueue.js";
import { batchLease, documentTarget } from "./target.js";
import { queueFor } from "./fairqueue.js";
import { batchBoard, resetBatchBoard } from "./batchline.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

/**
 * A stand-in for the add-in's socket, same shape as the fake in fairqueue.test.ts and tests/e2e/fake_revit.mjs.
 * One connection carries the live-lock read and then the write.
 */
function fakePlugin(log: Array<{ id: string; who: string; doc: string; n: number; command: string }>) {
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let msg: { id?: string; method?: string; params?: { who?: string; document?: string; n?: number } };
      try { msg = JSON.parse(buf); } catch { return; }
      buf = "";
      const params = msg.params ?? {};
      if (msg.method === "fmc_document_info") {
        const title = params.document || "Architecture";
        socket.write(JSON.stringify({
          jsonrpc: "2.0", id: msg.id,
          result: { active: { title, path: "", isFamily: false, isWorkshared: false, isDetached: false, readOnly: false } },
        }));
        return;
      }
      const row = { id: String(msg.id), who: String(params.who ?? ""), doc: String(params.document ?? ""), n: Number(params.n), command: String(msg.method) };
      log.push(row);
      socket.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: row }));
    });
  });
  return server;
}

const referencesFor = (bot: string, n: number) => ({
  kit: [`FMC_${bot}_Family_${n}`],
  standards: ["rooms.bedroom"],
  rulebook: ["NAM-004", "keynote:S.FND_01"],
});

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

describe("batch line against the fake plugin", { concurrency: 1 }, () => {
  const savedPort = process.env.REVIT_PORT;
  before(() => { resetBatchBoard({ autoSweep: false, idleMs: 120_000, maxMs: 30 * 60_000 }); });
  after(() => {
    if (savedPort === undefined) delete process.env.REVIT_PORT;
    else process.env.REVIT_PORT = savedPort;
    resetBatchBoard({ autoSweep: false }).close();
  });

  test("five documents and three bots on one document: no interleaving, every batch runs", { timeout: 120_000 }, async () => {
    const log: Array<{ id: string; who: string; doc: string; n: number; command: string }> = [];
    const server = fakePlugin(log);
    const port = await listen(server);
    process.env.REVIT_PORT = String(port);
    const board = resetBatchBoard({ autoSweep: false, idleMs: 120_000, maxMs: 30 * 60_000 });
    const t0 = Date.now();
    try {
      const gate = await board.request({
        document: "Architecture", label: "gate", bot: "arch", client: "arch", references: referencesFor("arch", 0), estOps: 1,
      });
      await queueClient.run("reader", () => withRevitConnection((client) => client.sendCommand("fmc_document_info", { document: "Architecture" })));
      await assert.rejects(
        queueClient.run("rogue", () => documentTarget.run("Architecture", () => withRevitConnection((client) => client.sendCommand("fmc_model_edit", { document: "Architecture", who: "rogue", n: -1 })))),
        /FMC-BATCH-LOCKED/,
      );
      await assert.rejects(
        queueClient.run("thief", () => batchLease.run(String(gate.lease), () => documentTarget.run("Architecture", () =>
          withRevitConnection((client) => client.sendCommand("fmc_model_edit", { document: "Architecture", who: "thief", n: -1 }))))),
        /FMC-BATCH-LOCKED/,
      );
      const held = await queueClient.run("arch", () => batchLease.run(String(gate.lease), () => documentTarget.run("Architecture", () =>
        withRevitConnection((client) => client.sendCommand("fmc_model_edit", { document: "Architecture", who: "arch", n: 0 }))))) as { who?: string };
      assert.equal(held.who, "arch");
      board.release(String(gate.lease), "ok", "arch", "gate");
      log.length = 0;

      const docs = ["Architecture", "Structure", "Electrical", "Plumbing", "Mechanical"];
      const solo = docs.map((doc) => ({ bot: doc.toLowerCase(), doc }));
      const shared = ["share-a", "share-b", "share-c"].map((bot) => ({ bot, doc: "Shared" }));
      const runs = [...solo, ...shared];
      const ids = new Set<string>();
      await Promise.all(runs.map(async ({ bot, doc }) => {
        await queueClient.run(bot, async () => {
          let ticket = await board.request({ document: doc, label: `${bot}-batch`, bot, client: bot, references: referencesFor(bot, 1), estOps: 20 });
          for (let spin = 0; ticket.state === "queued" && spin < 50; spin++) ticket = await board.wait(String(ticket.lease), 2);
          assert.equal(ticket.state, "granted", `${bot} was not granted`);
          const lease = String(ticket.lease);
          for (let n = 0; n < 20; n++) {
            const reply = await batchLease.run(lease, () => documentTarget.run(doc, () =>
              withRevitConnection((client) => client.sendCommand("fmc_model_edit", { document: doc, who: bot, n })))) as { id?: string; who?: string; n?: number };
            assert.equal(reply.who, bot);
            assert.equal(reply.n, n);
            assert.ok(reply.id && !ids.has(reply.id), `duplicated id ${reply.id}`);
            ids.add(reply.id!);
          }
          board.release(lease, "ok", bot, "20 writes");
        });
      }));
      const elapsed = Date.now() - t0;
      assert.equal(ids.size, runs.length * 20);
      for (const doc of [...docs, "Shared"]) {
        const rows = log.filter((row) => row.doc === doc);
        const groups: Array<{ who: string; n: number }> = [];
        for (const row of rows) {
          const last = groups[groups.length - 1];
          if (last && last.who === row.who) last.n += 1;
          else groups.push({ who: row.who, n: 1 });
        }
        for (const group of groups) assert.equal(group.n, 20, `${doc} interleaved: ${groups.map((group) => `${group.who}:${group.n}`).join(" ")}`);
        assert.equal(rows.length, doc === "Shared" ? 60 : 20);
      }
      const queue = queueFor(port).snapshot();
      assert.equal(queue.waiting, 0);
      assert.equal(queue.running, null);
      console.error(`batch line ${runs.length} bots x 20 writes: ${elapsed} ms wall, ${ids.size} distinct replies`);
    } finally {
      board.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("soak: six bots, random failures and disconnects, one silent lease", { timeout: 180_000 }, async () => {
    const log: Array<{ id: string; who: string; doc: string; n: number; command: string; lease: string }> = [];
    const server = fakePlugin(log as unknown as Array<{ id: string; who: string; doc: string; n: number; command: string }>);
    // The fake above doesn't record lease. Record who+doc+n; the client checks its own reply.
    const port = await listen(server);
    process.env.REVIT_PORT = String(port);
    const idleMs = 4_000;
    const board = resetBatchBoard({ autoSweep: true, idleMs, maxMs: 30 * 60_000, sweepEveryMs: 100 });
    const t0 = Date.now();
    let rngState = 0xC0FFEE;
    const rng = () => {
      rngState = Math.imul(rngState ^ (rngState >>> 15), 0x6D2B79F5);
      return ((rngState ^ (rngState >>> 13)) >>> 0) / 4294967296;
    };
    const heapAt = () => process.memoryUsage().heapUsed;
    let warmHeap = 0;
    let maxLine = 0;
    const ids = new Set<string>();
    try {
      const bots = ["architecture", "structure", "electrical", "plumbing", "mechanical", "coordination"].map((name, index) => ({
        name,
        doc: index < 3 ? "Architecture" : "Structure",
        client: name,
        generation: 0,
        label: `${name}-0`,
        seq: 0,
        fails: 0,
        ok: 0,
        steps: 0,
        forceFails: index === 5 ? 4 : 0,
        sawExpiry: false,
        sawStruggling: false,
      }));

      const step = async (bot: typeof bots[number]) => {
        bot.steps += 1;
        let ticket: Record<string, unknown>;
        try {
          ticket = await board.request({
            document: bot.doc, label: bot.label, bot: bot.name, client: bot.client,
            references: { ...referencesFor(bot.name, bot.seq), kit: [`FMC_${bot.name}_${bot.fails}_${bot.seq}`] },
            estOps: 2,
            correction: bot.fails > 0 ? `changed the kit id after failure ${bot.fails}` : undefined,
          });
        } catch (error) {
          if (error instanceof Error && error.message.includes("FMC-BATCH-SAMEFIX")) {
            bot.fails += 1;
            return;
          }
          throw error;
        }
        if (ticket.struggling) bot.sawStruggling = true;
        for (let spin = 0; ticket.state === "queued" && spin < 40; spin++) ticket = await board.wait(String(ticket.lease), 2);
        if (ticket.state !== "granted") return;
        const lease = String(ticket.lease);
        if (!bot.sawExpiry && bot.name === "architecture" && bot.ok === 4) {
          await new Promise((resolve) => setTimeout(resolve, idleMs + 700));
          const after = board.status(lease);
          assert.notEqual(after.state, "granted");
          assert.equal(after.outcome, "failed");
          bot.sawExpiry = true;
          bot.label = `${bot.name}-${++bot.seq}`;
          return;
        }
        await queueClient.run(bot.client, async () => {
          for (let n = 0; n < 2; n++) {
            const reply = await batchLease.run(lease, () => documentTarget.run(bot.doc, () =>
              withRevitConnection((client) => client.sendCommand("fmc_model_edit", { document: bot.doc, who: bot.name, n })))) as { id?: string; who?: string; n?: number; doc?: string };
            assert.equal(reply.who, bot.name, `crossed reply on ${bot.name}`);
            assert.equal(reply.n, n);
            assert.equal(reply.doc, bot.doc);
            assert.ok(reply.id && !ids.has(reply.id));
            ids.add(reply.id!);
            log.push({ id: reply.id!, who: bot.name, doc: bot.doc, n, command: "fmc_model_edit", lease });
          }
        });
        if (bot.forceFails > 0) {
          bot.forceFails -= 1;
          bot.fails += 1;
          board.release(lease, "failed", bot.client, "forced miss", "forced");
          return;
        }
        const roll = rng();
        if (roll < 0.02) {
          board.disconnect(bot.client);
          bot.client = `${bot.name}-${++bot.generation}`;
          bot.fails += 1;
          return;
        }
        if (roll < 0.07) {
          board.release(lease, "failed", bot.client, "random miss", "check failed");
          bot.fails += 1;
          return;
        }
        board.release(lease, "ok", bot.client, "placed");
        bot.ok += 1;
        bot.fails = 0;
        bot.label = `${bot.name}-${++bot.seq}`;
      };

      await Promise.all(bots.map(async (bot) => {
        while (bot.ok < 90 && bot.steps < 220) {
          await step(bot);
          const snap = board.snapshot() as { documents: Array<{ line: unknown[] }> };
          for (const doc of snap.documents) maxLine = Math.max(maxLine, doc.line.length);
          const finished = bots.reduce((sum, row) => sum + row.ok, 0);
          if (finished === 30 && warmHeap === 0) warmHeap = heapAt();
        }
      }));

      const elapsed = Date.now() - t0;
      const snap = board.snapshot() as {
        documents: Array<{ holder: unknown; line: unknown[]; history: Array<{ references?: { kit?: string[] } }> }>;
        bots: Array<{ bot: string; batches: number; failures: number; retries: number; last_references: { kit?: string[] } | null }>;
        struggling: Array<{ attempts: number; struggling: boolean }>;
      };
      const oks = bots.reduce((sum, bot) => sum + bot.ok, 0);
      assert.ok(oks >= 500, `only ${oks} ok batches`);
      for (const bot of bots) assert.ok(bot.ok >= 40, `${bot.name} starved at ${bot.ok}`);
      assert.equal(bots[0].sawExpiry, true);
      assert.equal(bots[5].sawStruggling, true);
      assert.ok(bots[5].ok >= 40, "a struggling bot is not blocked");
      assert.ok(snap.bots.some((row) => row.failures > 0 && row.retries > 0));
      for (const row of snap.bots) {
        if (row.batches > 0) assert.ok((row.last_references?.kit ?? []).length > 0, `${row.bot} stats dropped references`);
      }
      for (const doc of snap.documents) {
        assert.equal(doc.holder, null);
        assert.equal(doc.line.length, 0);
        if (doc.history[0]) assert.ok((doc.history[0].references?.kit ?? []).length > 0);
      }
      assert.ok(maxLine <= 6, `line grew to ${maxLine}`);
      const queue = queueFor(port).snapshot();
      assert.equal(queue.waiting, 0);
      assert.equal(queue.running, null);
      const byDoc = new Map<string, string[]>();
      for (const row of log) {
        if (!row.lease) continue;
        const list = byDoc.get(row.doc) ?? [];
        list.push(row.lease);
        byDoc.set(row.doc, list);
      }
      for (const [doc, leases] of byDoc) {
        let current = "";
        let count = 0;
        const flush = () => { if (current) assert.equal(count, 2, `${doc} lease ${current} interleaved (${count})`); };
        for (const lease of leases) {
          if (lease !== current) { flush(); current = lease; count = 1; }
          else count += 1;
        }
        flush();
      }
      const endHeap = heapAt();
      const growth = warmHeap ? endHeap - warmHeap : 0;
      assert.ok(growth < 40 * 1024 * 1024, `heap grew ${growth} bytes after the warmup`);
      console.error(`soak ${oks} ok batches, ${ids.size} writes, struggling seen, wall ${elapsed} ms, heap growth ${growth} bytes, max line ${maxLine}`);
    } finally {
      board.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
