import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WRITE_COMMANDS } from "./policy.js";
import { ROOM, call, done, fakeRevit, kit, type Kit } from "./casework_testkit.js";

/** remove: the dry run (default) changes nothing; a real removal needs dry_run=false and confirm=true. */

const TAG = "FMC:casework:K-01-Kitchen";

/** A stand-in model: casework instances with their Comments; the add-in's rule, deleting only on a real run. */
function model() {
  const elements = [
    { id: 1, comments: TAG, mark: "K01" }, { id: 2, comments: TAG, mark: "K02" }, { id: 3, comments: "FMC:casework:K-02-Utility", mark: "U01" },
  ];
  const rv = fakeRevit({ fmc_casework_remove: (p: { dry_run: boolean; tag: string }) => {
    const found = elements.filter((e) => e.comments === p.tag);
    if (!p.dry_run) for (const f of found) elements.splice(elements.indexOf(f), 1);
    return { dry_run: p.dry_run, tag: p.tag, count: found.length, removed: p.dry_run ? 0 : found.length, found: found.map((f) => ({ id: f.id, mark: f.mark })) };
  }, fmc_casework_room: ROOM });
  return { elements, rv };
}

/** Every file under the kit, with its bytes, except the file log (a dry run logs a row). */
function snapshot(k: Kit): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (p !== k.log) out[p] = fs.readFileSync(p).toString("base64");
  } };
  walk(k.root);
  return out;
}

test("the dry run is the default: it lists what the label placed and changes nothing in the model or on disk", async () => {
  const k = kit();
  try {
    const m = model();
    const before = JSON.stringify(m.elements);
    const files = snapshot(k);
    const r = await call(k, { action: "remove", label: "K-01 Kitchen" }, m.rv.send);
    assert.equal(r.isError, false, JSON.stringify(r.body));
    assert.equal(r.body.dry_run, true);
    assert.equal(r.body.tag, TAG);
    assert.equal(r.body.found, 2);
    assert.deepEqual(r.body.will_remove.map((x: { mark: string }) => x.mark), ["K01", "K02"]);
    assert.equal(JSON.stringify(m.elements), before, "the model is as it was");
    assert.deepEqual(snapshot(k), files, "no file was written or changed");
    assert.equal(m.rv.calls.length, 1);
    assert.equal(m.rv.calls[0].dry, true, "sent through the read-only path (sendRaw), not the lock");
    assert.equal(m.rv.calls[0].payload.dry_run, true, "the add-in is told it is a dry run");
    const row = fs.readFileSync(k.log, "utf8").split(/\r?\n/).find((l) => l.includes(r.body.run_id));
    assert.match(row!, /casework_remove,true,.*dry run/);
  } finally { done(k); }
});

test("dry_run=false without confirm is refused before Revit is called", async () => {
  const k = kit();
  try {
    const m = model();
    for (const args of [{ dry_run: false }, { dry_run: false, confirm: false }]) {
      const r = await call(k, { action: "remove", label: "K-01 Kitchen", ...args }, m.rv.send);
      assert.equal(r.isError, true);
      assert.ok(r.body.reasons.some((x: string) => /confirm=true/.test(x)));
    }
    assert.equal(m.rv.calls.length, 0);
    assert.equal(m.elements.length, 3);
  } finally { done(k); }
});

test("with confirm the label's units are removed through the write path; other labels stay", async () => {
  const k = kit();
  try {
    const m = model();
    const r = await call(k, { action: "remove", label: "K-01 Kitchen", dry_run: false, confirm: true }, m.rv.send);
    assert.equal(r.isError, false);
    assert.equal(r.body.removed, 2);
    assert.equal(m.rv.calls[0].dry, false, "a real run goes through sendCommand (lease, lock, AI gate)");
    assert.deepEqual(m.elements.map((e) => e.mark), ["U01"]);
  } finally { done(k); }
});

test("no label, a label with nothing in it, or a guard problem on a real run: refused", async () => {
  const k = kit();
  try {
    const m = model();
    for (const label of ["", "  ", "---"]) {
      const r = await call(k, { action: "remove", label }, m.rv.send);
      assert.equal(r.isError, true);
      assert.match(r.body.reasons[0], /label/);
    }
    k.config.problem = "The guard config isn't readable";
    const real = await call(k, { action: "remove", label: "K-01 Kitchen", dry_run: false, confirm: true }, m.rv.send);
    assert.equal(real.isError, true);
    assert.ok(real.body.reasons.includes("The guard config isn't readable"));
    assert.equal(m.rv.calls.length, 0);
    const dry = await call(k, { action: "remove", label: "K-01 Kitchen" }, m.rv.send);
    assert.equal(dry.isError, false, "a dry run still works: it only reads");
  } finally { done(k); }
});

test("the tag is the one place writes for the same label", async () => {
  const k = kit();
  try {
    const rv = fakeRevit({ fmc_casework_place: (p: unknown) => ({ placed: [], payload: p }), fmc_casework_room: ROOM });
    const room = await call(k, { action: "room", room: "G05" }, rv.send);
    await call(k, { action: "place", run_id: room.body.run_id, modules: [600, 450, 300], label: "K-01 Kitchen", level: "Ground", wall_unit_bottom: 1450 }, rv.send);
    const place = rv.calls.find((c) => c.command === "fmc_casework_place");
    assert.equal(place?.payload.tag, TAG);
  } finally { done(k); }
});

test("the removal is a write command and is in the add-in's command manifest", () => {
  assert.ok(WRITE_COMMANDS.has("fmc_casework_remove"));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  assert.ok(manifest.commands.some((c) => c.commandName === "fmc_casework_remove"));
  const cs = fs.readFileSync(path.join(root, "commandset", "Commands", "Fmc", "FmcCaseworkCommands.cs"), "utf8");
  assert.match(cs, /CommandName => "fmc_casework_remove"/);
  const svc = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcCasework.cs"), "utf8");
  const body = svc.slice(svc.indexOf("private JObject Remove("), svc.indexOf("// place", svc.indexOf("private JObject Remove(")));
  assert.match(body, /if \(!dry && found\.Count > 0\)/, "the add-in deletes only on a real run");
  assert.equal((body.match(/new Transaction\(/g) ?? []).length, 1, "one transaction, opened only inside the real-run branch");
  assert.ok(body.indexOf("new Transaction(") > body.indexOf("if (!dry && found.Count > 0)"));
});
