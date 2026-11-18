import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { RevitClientConnection } from "../utils/SocketClient.js";

/**
 * A stand-in for the Revit listener: one socket stays up. Every 7th connection accepts the handshake
 * and then resets, the way an empty probe or a half-closed client does. The next connection answers.
 */
function fakePlugin(): Promise<{ port: number; drops: () => number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    let n = 0;
    let dropped = 0;
    const server = net.createServer((socket) => {
      n += 1;
      const drop = n % 7 === 0;
      let buf = "";
      socket.on("error", () => { /* the reset is the test */ });
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        if (drop) { dropped += 1; socket.destroy(); return; }
        let msg: { id?: string };
        try { msg = JSON.parse(buf); } catch { return; }
        socket.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { reject(new Error("no port")); return; }
      resolve({
        port: address.port,
        drops: () => dropped,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test("a thousand reads survive random disconnects on one listener", { timeout: 120_000 }, async () => {
  const plugin = await fakePlugin();
  let ok = 0;
  let failed = 0;
  const t0 = Date.now();
  try {
    for (let i = 0; i < 1000; i++) {
      const client = new RevitClientConnection("127.0.0.1", plugin.port);
      try {
        const result = await client.sendRaw("fmc_document_info", {}, 5000) as { ok?: boolean };
        if (result?.ok) ok += 1;
        else failed += 1;
      } catch {
        failed += 1;
      } finally {
        client.socket.destroy();
      }
    }
  } finally {
    await plugin.close();
  }
  console.error(`soak 1000 calls in ${Date.now() - t0} ms, ok ${ok}, failed ${failed}, drops ${plugin.drops()}`);
  assert.ok(plugin.drops() > 50, `expected disconnects, saw ${plugin.drops()}`);
  assert.equal(ok, 1000, `${failed} calls failed`);
  assert.equal(failed, 0);
});
