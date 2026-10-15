import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ClashRow, groupClashes, navisCall, readState } from "./navis.js";

/** A stand-in for the bridge: one JSON line in, one JSON line out. */
function fakeBridge(answer: (req: { id: number; method: string; params: Record<string, unknown> }) => object): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (c: string) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const req = JSON.parse(buf.slice(0, nl));
        sock.write(JSON.stringify({ id: req.id, ...answer(req) }) + "\n");
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() }));
  });
}

test("a call sends one line and returns the result", async () => {
  const b = await fakeBridge((req) => ({ result: { method: req.method, test: req.params.test } }));
  try {
    assert.deepEqual(await navisCall(b.port, "navis_clash_results", { test: "S vs M" }), { method: "navis_clash_results", test: "S vs M" });
  } finally { b.close(); }
});

test("the bridge's error comes back as the error", async () => {
  const b = await fakeBridge(() => ({ error: "No clash test named 'X'" }));
  try {
    await assert.rejects(navisCall(b.port, "navis_clash_results", { test: "X" }), /No clash test named 'X'/);
  } finally { b.close(); }
});

test("nothing listening is a clear refusal, not a hang", async () => {
  const b = await fakeBridge(() => ({}));
  const port = b.port;
  b.close();
  await assert.rejects(navisCall(port, "navis_info", {}, 3000), /Can't reach the Formcraft bridge/);
});

test("the state file is read, with or without a BOM", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-navis-"));
  const f = path.join(dir, "navis.json");
  fs.writeFileSync(f, "\uFEFF" + JSON.stringify({ port: 8190, pid: 42, started: "2026-10-15T08:00:00Z" }));
  assert.equal(readState(f)?.port, 8190);
  fs.writeFileSync(f, "{}");
  assert.equal(readState(f), null);
  assert.equal(readState(path.join(dir, "missing.json")), null);
});

test("clashes group by model and category pair, either way round", () => {
  const item = (source: string, category: string) => ({ name: "", category, revit_id: "1", source });
  const S = "D:\\P\\F26001-FMC-ZZ-ZZ-M3-S-0001.nwc", M = "D:\\P\\F26001-FMC-ZZ-ZZ-M3-M-0001.nwc";
  const rows: ClashRow[] = [
    { name: "1", status: "New", distance_mm: -40, item1: item(S, "Structural Framing"), item2: item(M, "Ducts") },
    { name: "2", status: "New", distance_mm: -120, item1: item(M, "Ducts"), item2: item(S, "Structural Framing") },
    { name: "3", status: "Active", distance_mm: -5, item1: item(M, "Ducts"), item2: item(M, "Pipes") },
  ];
  const g = groupClashes(rows);
  assert.equal(g.length, 2);
  assert.equal(g[0].count, 2);
  assert.equal(g[0].deepest_mm, -120);
  assert.equal(g[0].within_one_model, false);
  assert.equal(g[1].within_one_model, true);
});
