import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { RevitInstance, probePort, resolvePort, stalePortMessage } from "./connect.js";

const env = { APPDATA: "C:\\Users\\X\\AppData\\Roaming", REVIT_PORT: "" } as NodeJS.ProcessEnv;
const one = (port: number): RevitInstance => ({
  pid: 12296, port, revit: "2025", user: "USER", started: "2026-11-11T00:00:00Z", updated: "2026-11-11T00:00:00Z", build: "d3a3fa5",
  documents: [{ title: "Model", path: "Z:\\Model.rvt", active: true, family: false, workshared: false }],
});

function listen(handler: (socket: net.Socket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { reject(new Error("no port")); return; }
      resolve({
        port: address.port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test("a port that accepts is ok, and one that resets is not", async () => {
  const open = await listen((socket) => { socket.on("error", () => {}); });
  try { assert.equal(await probePort("127.0.0.1", open.port), "ok"); }
  finally { await open.close(); }
  const reset = await listen((socket) => { socket.destroy(); });
  try { assert.notEqual(await probePort("127.0.0.1", reset.port), "ok"); }
  finally { await reset.close(); }
  assert.equal(await probePort("127.0.0.1", 1), "refused");
});

test("resolvePort rejects a stale instance file instead of returning its port", () => {
  const forgotten: number[] = [];
  assert.throws(
    () => resolvePort(undefined, [one(8080)], env, undefined, {
      probe: () => "reset",
      forget: (instance) => forgotten.push(instance.pid),
    }),
    /pid 12296.*8080.*ECONNRESET.*stale/s,
  );
  assert.deepEqual(forgotten, [12296]);
  assert.match(stalePortMessage(8080, "refused", one(8080)), /nothing is accepting/);
});

test("resolvePort without a probe keeps the previous selection", () => {
  assert.equal(resolvePort(undefined, [one(8083)], env, undefined), 8083);
});
