import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { classifyRegistrar } from "../tools/register.js";
import * as tool from "../tools/fmc_directshape.js";
import { FMC_DIRECTSHAPE_SHAPE, runFmcDirectshape, type FmcDirectshapeArgs } from "../tools/fmc_directshape.js";
import type { DirectshapeIo } from "./directshape_run.js";
import { RUN_ID_PATTERN } from "./directshape_spec.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DOC = "F26901-FMC-ZZ-ZZ-M3-A-0002_USER";
const BOX = { kind: "box", name: "Door swing", purpose: "clearance", origin_mm: [1000, 2000, 0], size_mm: [900, 900, 2100] };

const parse = (partial: Record<string, unknown>): FmcDirectshapeArgs => z.object(FMC_DIRECTSHAPE_SHAPE).parse(partial);
const body = (r: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> => ({ ...(JSON.parse(r.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: r.isError === true });

function rig(config: Partial<GuardConfig> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-ds-"));
  const calls: Array<{ command: string; body: Record<string, unknown> }> = [];
  const io: DirectshapeIo = {
    config: { ...DEFAULT_CONFIG, reports_dir: dir, protected_paths: ["D:\\Live"], ...config },
    read: async (b) => { calls.push({ command: "fmc_directshape", body: b }); return { read_only: true, count: 2, problems: [] }; },
    apply: async (b) => { calls.push({ command: "fmc_directshape_apply", body: b }); return { ok: true, created: [{ id: 7 }], removed: [7], rolled_back: false }; },
    heldDocuments: (lease) => (lease === "L-1" ? [DOC] : lease === "L-2" ? ["Other_USER"] : []),
  };
  // the tool writes with path.win32.join(reports_dir, ...): the same file on Windows
  const logFile = path.win32.join(dir, "FMC_MCP_FileLog.csv");
  return { dir, calls, io, log: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "") };
}

test("defaults: dry run on, confirm off", () => {
  const a = parse({ action: "create" });
  assert.equal(a.dry_run, true);
  assert.equal(a.confirm, false);
});

test("limits: whitelist and caps, no Revit call", async () => {
  const r = rig();
  const out = body(await runFmcDirectshape(parse({ action: "limits" }), r.io));
  assert.equal(out.isError, false);
  assert.deepEqual((out.whitelist as { allowed: string[] }).allowed, ["Generic Models", "Mass"]);
  assert.match(String(out.run_id), RUN_ID_PATTERN);
  assert.equal(r.calls.length, 0);
});

test("every action but limits needs a document, and the active one is never used", async () => {
  const r = rig();
  for (const action of ["create", "list", "remove"] as const) {
    const out = body(await runFmcDirectshape(parse({ action, ...BOX, all: true }), r.io));
    assert.equal(out.code, "FMC-DOC-REQUIRED");
  }
  assert.equal(r.calls.length, 0);
});

test("create dry run: reports what would be made, hashes the plan, asks Revit to check, writes nothing", async () => {
  const r = rig();
  const out = body(await runFmcDirectshape(parse({ action: "create", document: DOC, ...BOX }), r.io));
  assert.equal(out.isError, false);
  assert.equal(out.dry_run, true);
  assert.match(String(out.run_id), RUN_ID_PATTERN);
  assert.match(String(out.plan_hash), /^[0-9a-f]{12}$/);
  const would = out.would_create as Array<{ category: string; volume_m3: number; name: string }>;
  assert.equal(would[0].category, "Generic Models");
  assert.equal(would[0].volume_m3, 1.701);
  assert.deepEqual(r.calls.map((c) => c.command), ["fmc_directshape"]);
  assert.equal(r.calls[0].body.mode, "check");
  assert.equal(r.calls[0].body.document, DOC);
  assert.deepEqual(r.calls[0].body.protected_roots, ["D:\\Live"]);
  assert.match(r.log(), /fmc_directshape create,true,F26901.*dry run/);
});

test("create: a category off the whitelist is refused before Revit hears of it", async () => {
  const r = rig();
  for (const dry of [true, false]) {
    const out = body(await runFmcDirectshape(parse({ action: "create", document: DOC, ...BOX, category: "Walls", dry_run: dry, confirm: true, batch_lease: "L-1" }), r.io));
    assert.equal(out.code, "FMC-DS-CATEGORY");
    assert.equal(out.isError, true);
    assert.match(String(out.message), /Generic Models, Mass/);
  }
  assert.equal(r.calls.length, 0);
  assert.match(r.log(), /refused FMC-DS-CATEGORY/);
});

test("create: the whitelist can come from the guard file, per shape", async () => {
  const r = rig({ directshape_categories: ["Mass", "Furniture"] });
  const out = body(await runFmcDirectshape(parse({ action: "create", document: DOC, shapes: [{ ...BOX, category: "furniture" }, { ...BOX, category: "Mass" }, { ...BOX }] }), r.io));
  assert.deepEqual((out.would_create as Array<{ category: string }>).map((s) => s.category), ["Furniture", "Mass", "Mass"]);
  const wire = r.calls[0].body.shapes as Array<{ bic: string }>;
  assert.deepEqual(wire.map((s) => s.bic), ["OST_Furniture", "OST_Mass", "OST_Mass"]);
  assert.deepEqual(r.calls[0].body.whitelist, [{ name: "Mass", bic: "OST_Mass" }, { name: "Furniture", bic: "OST_Furniture" }]);
});

test("create: spec problems are refused with the shape number, one shape direct or many, not both", async () => {
  const r = rig();
  let out = body(await runFmcDirectshape(parse({ action: "create", document: DOC, shapes: [BOX, { kind: "box", size_mm: [0, 1, 1] }] }), r.io));
  assert.equal(out.code, "FMC-DS-SPEC");
  assert.match(String(out.message), /shape 2/);
  out = body(await runFmcDirectshape(parse({ action: "create", document: DOC, ...BOX, shapes: [BOX] }), r.io));
  assert.match(String(out.message), /not both/);
  out = body(await runFmcDirectshape(parse({ action: "create", document: DOC }), r.io));
  assert.match(String(out.message), /no shapes/);
  assert.equal(r.calls.length, 0);
});

test("real create: confirm first, then the lease, each refused with nothing sent", async () => {
  const r = rig();
  const real = { action: "create", document: DOC, ...BOX, dry_run: false };
  assert.equal(body(await runFmcDirectshape(parse({ ...real }), r.io)).code, "FMC-DS-CONFIRM");
  assert.equal(body(await runFmcDirectshape(parse({ ...real, confirm: true }), r.io)).code, "FMC-BATCH-LOCKED");
  const notHeld = body(await runFmcDirectshape(parse({ ...real, confirm: true, batch_lease: "nope" }), r.io));
  assert.match(String(notHeld.message), /not held by this server/);
  const wrongDoc = body(await runFmcDirectshape(parse({ ...real, confirm: true, batch_lease: "L-2" }), r.io));
  assert.equal(wrongDoc.code, "FMC-BATCH-LOCKED");
  assert.match(String(wrongDoc.message), /is for Other_USER, not/);
  assert.equal(r.calls.length, 0);
});

test("real create: a lease that covers the document sends one apply call with the run id on it", async () => {
  const r = rig();
  const out = body(await runFmcDirectshape(parse({ action: "create", document: DOC, shapes: [BOX, { ...BOX, name: "Second", category: "Mass" }], dry_run: false, confirm: true, batch_lease: "L-1" }), r.io));
  assert.equal(out.isError, false);
  assert.equal(out.dry_run, false);
  assert.equal(out.saved, false);
  assert.equal(out.synced, false);
  assert.deepEqual(r.calls.map((c) => c.command), ["fmc_directshape_apply"]);
  const sent = r.calls[0].body;
  assert.equal(sent.mode, "create");
  assert.equal(sent.run_id, out.run_id);
  assert.equal((sent.shapes as unknown[]).length, 2);
  assert.match(r.log(), /fmc_directshape create,false,.*created/);
});

test("real create: the lease can come from the call's context and the plan hash is checked", async () => {
  const r = rig();
  const dry = body(await runFmcDirectshape(parse({ action: "create", document: DOC, ...BOX }), r.io));
  const { batchLease } = await import("./target.js");
  const spec = { action: "create", document: DOC, ...BOX, dry_run: false, confirm: true };
  const changed = await batchLease.run("L-1", () => runFmcDirectshape(parse({ ...spec, size_mm: [900, 900, 2200], plan_hash: String(dry.plan_hash) }), r.io));
  assert.equal(body(changed).code, "FMC-DS-PLAN-CHANGED");
  const same = await batchLease.run("L-1", () => runFmcDirectshape(parse({ ...spec, plan_hash: String(dry.plan_hash) }), r.io));
  assert.equal(body(same).isError, false);
  assert.deepEqual(r.calls.map((c) => c.command), ["fmc_directshape", "fmc_directshape_apply"]);
});

test("a Revit refusal comes back as FMC-DIRECTSHAPE with its own text, and is logged", async () => {
  const r = rig();
  r.io.apply = async () => { throw new Error("fmc_directshape_apply: [FMC-DS-DOC] A central model is not written by fmc_directshape."); };
  const out = body(await runFmcDirectshape(parse({ action: "create", document: DOC, ...BOX, dry_run: false, confirm: true, batch_lease: "L-1" }), r.io));
  assert.equal(out.code, "FMC-DIRECTSHAPE");
  assert.match(String(out.message), /central model/);
  assert.match(r.log(), /refused FMC-DIRECTSHAPE/);
});

test("list passes the run filter on and refuses a made-up run id", async () => {
  const r = rig();
  const out = body(await runFmcDirectshape(parse({ action: "list", document: DOC, of_run: "DS-20261128110509-ab12", ids: [5, "6"] }), r.io));
  assert.equal(out.isError, false);
  assert.equal(out.count, 2);
  assert.equal(r.calls[0].body.mode, "list");
  assert.deepEqual(r.calls[0].body.ids, ["5", "6"]);
  assert.equal(body(await runFmcDirectshape(parse({ action: "list", document: DOC, of_run: "all'; drop" }), r.io)).code, "FMC-DS-SELECT");
});

test("remove: needs a selection; the dry run lists; a real one needs confirm and the lease", async () => {
  const r = rig();
  assert.equal(body(await runFmcDirectshape(parse({ action: "remove", document: DOC }), r.io)).code, "FMC-DS-SELECT");
  const dry = body(await runFmcDirectshape(parse({ action: "remove", document: DOC, all: true }), r.io));
  assert.equal(dry.dry_run, true);
  assert.deepEqual(r.calls.map((c) => c.command), ["fmc_directshape"]);
  const spec = { action: "remove", document: DOC, of_run: "DS-20261128110509-ab12", dry_run: false };
  assert.equal(body(await runFmcDirectshape(parse(spec), r.io)).code, "FMC-DS-CONFIRM");
  assert.equal(body(await runFmcDirectshape(parse({ ...spec, confirm: true }), r.io)).code, "FMC-BATCH-LOCKED");
  assert.equal(r.calls.length, 1);
  const done = body(await runFmcDirectshape(parse({ ...spec, confirm: true, batch_lease: "L-1" }), r.io));
  assert.equal(done.isError, false);
  assert.equal(r.calls[1].command, "fmc_directshape_apply");
  assert.equal(r.calls[1].body.mode, "remove");
  assert.equal(r.calls[1].body.of_run, "DS-20261128110509-ab12");
});

test("wiring: policy sets, command.json, registrar, and the 300-line rule", () => {
  assert.ok(WRITE_COMMANDS.has("fmc_directshape_apply"));
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_directshape"));
  assert.ok(!WRITE_COMMANDS.has("fmc_directshape"));
  const names = (JSON.parse(fs.readFileSync(path.join(REPO, "command.json"), "utf8")).commands as Array<{ commandName: string }>).map((c) => c.commandName);
  assert.ok(names.includes("fmc_directshape") && names.includes("fmc_directshape_apply"));
  assert.equal(new Set(names).size, names.length, "no duplicate command names");
  assert.deepEqual(classifyRegistrar(tool as unknown as Record<string, unknown>), { kind: "tool", name: "registerFmcDirectshapeTool" });
  const files = [
    "server/src/fmc/directshape_cats.ts", "server/src/fmc/directshape_spec.ts", "server/src/fmc/directshape_args.ts", "server/src/fmc/directshape_run.ts",
    "server/src/tools/fmc_directshape.ts", "commandset/Commands/Fmc/FmcDirectShapeCommand.cs", "commandset/Services/Fmc/FmcDirectShape.cs",
    "commandset/Services/Fmc/FmcDirectShapeApply.cs", "commandset/Services/Fmc/FmcDirectShapeGeo.cs",
  ];
  for (const f of files) {
    const text = fs.readFileSync(path.join(REPO, f), "utf8");
    assert.ok(text.split("\n").length <= 300, `${f} is over 300 lines`);
  }
});

test("the C# add-in keeps the same ids, whitelist universe and refusals as the server", () => {
  const cs = ["FmcDirectShape.cs", "FmcDirectShapeApply.cs", "FmcDirectShapeGeo.cs"].map((f) => fs.readFileSync(path.join(REPO, "commandset", "Services", "Fmc", f), "utf8")).join("\n");
  assert.match(cs, /Formcraft\.fmc_directshape/);
  assert.match(cs, /fmc_directshape\|/);
  const universe = fs.readFileSync(path.join(REPO, "server", "src", "fmc", "directshape_cats.ts"), "utf8").match(/OST_\w+/g) ?? [];
  for (const bic of new Set(universe)) assert.ok(cs.includes(bic), `${bic} is in the C# universe`);
  for (const code of ["FMC-DS-CATEGORY", "FMC-DS-DOC", "FMC-DS-NOT-OURS", "FMC-DS-SPEC"]) assert.ok(cs.includes(code), code);
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
}

test("fake Revit: create, list and remove touch only this tool's shapes", async () => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-ds-fake-"));
  const log = path.join(dir, "calls.jsonl");
  const child = spawn(process.execPath, [path.join(REPO, "tests", "e2e", "fake_revit.mjs")], { env: { ...process.env, FAKE_PORT: String(port), FAKE_LOG: log }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
  try {
    const { RevitClientConnection } = await import("../utils/SocketClient.js");
    const client = new RevitClientConnection("127.0.0.1", port);
    await new Promise<void>((resolve) => { client.socket.once("connect", () => resolve()); client.connect(); });
    const r = rig();
    r.io.read = (b) => client.sendRaw("fmc_directshape", b, 5000);
    r.io.apply = (b) => client.sendRaw("fmc_directshape_apply", b, 5000);
    const create = body(await runFmcDirectshape(parse({ action: "create", document: DOC, shapes: [BOX, { ...BOX, name: "B" }], dry_run: false, confirm: true, batch_lease: "L-1" }), r.io));
    assert.equal(create.isError, false);
    const made = ((create.applied as { created: Array<{ id: number; application_data_id: string }> }).created);
    assert.equal(made.length, 2);
    assert.match(made[0].application_data_id, new RegExp(`^fmc_directshape\\|${String(create.run_id)}\\|1$`));
    const list = body(await runFmcDirectshape(parse({ action: "list", document: DOC, of_run: String(create.run_id) }), r.io));
    assert.equal(list.count, 2);
    const dry = body(await runFmcDirectshape(parse({ action: "remove", document: DOC, ids: [made[0].id, 1] }), r.io));
    assert.equal((dry.would_remove as { count: number }).count, 1, "id 1 is not ours and is not listed");
    const gone = body(await runFmcDirectshape(parse({ action: "remove", document: DOC, ids: [made[0].id, 1], dry_run: false, confirm: true, batch_lease: "L-1" }), r.io));
    const applied = gone.applied as { removed: number[]; skipped: Array<{ id: string; code: string }> };
    assert.deepEqual(applied.removed, [made[0].id]);
    assert.deepEqual(applied.skipped, [{ id: "1", code: "FMC-DS-NOT-OURS" }]);
    const methods = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).method);
    assert.deepEqual(methods, ["fmc_directshape_apply", "fmc_directshape", "fmc_directshape", "fmc_directshape_apply"]);
    client.socket.destroy();
  } finally {
    child.kill();
  }
});
