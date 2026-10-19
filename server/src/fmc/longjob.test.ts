import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jobFiles } from "./jobs.js";

// F-064 long-job route (sendLong), first used by Gate A's host test: TR-20261019-1635 04_host_tests timed out at a fixed
// 180 s while Revit was still busy. No fixed cap while Revit's heartbeats come; a clear error when they stop or the
// ceiling passes; Revit's own kept result answers when the socket lost it.

const line = (file: string, o: object) => fs.appendFileSync(file, JSON.stringify(o) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withHome<T>(run: (files: ReturnType<typeof jobFiles>) => Promise<T>): Promise<T> {
  const appdata = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-longjob-"));
  fs.mkdirSync(path.join(appdata, "Formcraft"), { recursive: true });
  const before = process.env.APPDATA;
  process.env.APPDATA = appdata;
  try { return await run(jobFiles()); } finally { process.env.APPDATA = before; }
}

async function client() {
  const { RevitClientConnection } = await import("../utils/SocketClient.js");
  const c = new RevitClientConnection("127.0.0.1", 1);
  c.isConnected = true;
  let id = "";
  (c.socket as any).write = (s: string) => { id = JSON.parse(s).id; return true; };
  return { c, id: () => id };
}

const beat = (file: string, job: string) => line(file, { at: new Date().toISOString(), job, command: "fmc_family_host_test", event: "heartbeat" });

test("F-064: a long job keeps waiting past its stale limit while Revit's heartbeats come, then takes Revit's answer", async () => {
  await withHome(async (f) => {
    const { c, id } = await client();
    const p = c.sendLong("fmc_family_host_test", { path: "x.rfa", host: "wall" }, { ceilingMs: 5000, staleMs: 150, pollMs: 20 });
    for (let i = 0; i < 10; i++) { await sleep(50); beat(f.revit, id()); } // 500 ms: over three times the stale limit
    c.socket.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: id(), result: { state: "Pass", followed: true } })));
    assert.deepEqual(await p, { state: "Pass", followed: true });
    c.socket.destroy();
  });
});

test("F-064: when Revit's heartbeats stop, the long job fails with a clear message and the server records it gave up", async () => {
  await withHome(async (f) => {
    const { c, id } = await client();
    const p = c.sendLong("fmc_family_host_test", {}, { ceilingMs: 5000, staleMs: 150, pollMs: 20 });
    await sleep(10);
    beat(f.revit, id());
    const err = await p.catch((e: unknown) => e) as Error;
    assert.match(err.message, /\[FMC-BRIDGE-NO-HEARTBEAT\] fmc_family_host_test: Revit stopped sending heartbeats for job \d+ \(last one \d+ s ago\): Revit may have closed or crashed/);
    const server = fs.readFileSync(f.server, "utf8");
    assert.match(server, new RegExp(`"job":"${id()}","event":"gave_up"`));
    c.socket.destroy();
  });
});

test("F-064: no heartbeat ever (an add-in too old to send them) ends after the stale limit, not at once", async () => {
  await withHome(async () => {
    const { c } = await client();
    const t0 = Date.now();
    const err = await c.sendLong("fmc_family_host_test", {}, { ceilingMs: 5000, staleMs: 120, pollMs: 20 }).catch((e: unknown) => e) as Error;
    assert.ok(Date.now() - t0 >= 110);
    assert.match(err.message, /\[FMC-BRIDGE-NO-HEARTBEAT\].*\(none in \d+ s\)/);
    c.socket.destroy();
  });
});

test("F-064: fresh heartbeats don't wait forever: the ceiling ends the wait and says Revit is still busy", async () => {
  await withHome(async (f) => {
    const { c, id } = await client();
    const p = c.sendLong("fmc_family_host_test", {}, { ceilingMs: 300, staleMs: 150, pollMs: 20 });
    const timer = setInterval(() => id() && beat(f.revit, id()), 30);
    const err = await p.catch((e: unknown) => e) as Error;
    clearInterval(timer);
    assert.match(err.message, /\[FMC-BRIDGE-CEILING\] fmc_family_host_test didn't finish in 0 s \(job \d+, last heartbeat \d+ s ago\): Revit is still busy/);
    // a late answer after the ceiling is kept, never dropped
    c.socket.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: id(), result: { state: "Pass" } })));
    c.socket.destroy();
  });
});

test("F-064: the socket lost the answer but Revit kept it in the late-results file: that is the answer (result or error)", async () => {
  await withHome(async (f) => {
    const { c, id } = await client();
    const ok = c.sendLong("fmc_family_host_test", {}, { ceilingMs: 5000, staleMs: 1000, pollMs: 20 });
    await sleep(30);
    line(f.late, { at: new Date().toISOString(), job: id(), command: "fmc_family_host_test", from: "revit", result: { result: { state: "Pass", upright: true } } });
    assert.deepEqual(await ok, { state: "Pass", upright: true });

    const bad = c.sendLong("fmc_family_host_test", {}, { ceilingMs: 5000, staleMs: 1000, pollMs: 20 });
    await sleep(30);
    line(f.late, { at: new Date().toISOString(), job: id(), command: "fmc_family_host_test", from: "revit", result: { error: { message: "fmc_family_host_test: The family has no types" } } });
    assert.match(((await bad.catch((e: unknown) => e)) as Error).message, /The family has no types/);
    c.socket.destroy();
  });
});

test("F-061/F-064: the host test's ceiling is 15 min, FMC_HOST_TEST_MAX_MS overrides it", async () => {
  const { hostTestCeilingMs } = await import("../tools/fmc_recipe.js");
  assert.equal(hostTestCeilingMs({}), 15 * 60 * 1000);
  assert.equal(hostTestCeilingMs({ FMC_HOST_TEST_MAX_MS: "600000" }), 600000);
  assert.equal(hostTestCeilingMs({ FMC_HOST_TEST_MAX_MS: "nope" }), 15 * 60 * 1000);
  assert.equal(hostTestCeilingMs({ FMC_HOST_TEST_MAX_MS: "0" }), 15 * 60 * 1000);
});
