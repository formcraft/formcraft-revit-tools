import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  REDACTED_CACHE, cacheHits, checkGuidTriple, gateWrite, mentionsCollaborationCache, normalizeAccGuid, normalizeGuid,
  parseModelPath, planSaveAsCloud, redactCache,
} from "./cloud.js";
import { FMC_CLOUD_SHAPE, runFmcCloud, type FmcCloudArgs } from "../tools/fmc_cloud.js";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function fixtures() {
  for (const p of [path.join(here, "fixtures", "cloud_paths.json"), path.join(here, "..", "..", "src", "fmc", "fixtures", "cloud_paths.json")])
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  throw new Error("cloud_paths.json fixture not found");
}
const FX = fixtures();

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> {
  return { ...(JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: result.isError === true };
}
const args = (partial: Record<string, unknown>) => z.object(FMC_CLOUD_SHAPE).parse(partial) as FmcCloudArgs;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fmc-cloud-"));
const never = async () => { throw new Error("Revit must not be called"); };

const plainDoc = { title: "F26901-FMC-ZZ-ZZ-M3-A-0009", is_family: false, is_cloud: false, is_workshared: false, is_read_only: false };
const goodSave = {
  action: "save_as_cloud", target: plainDoc.title, account_id: "b.0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
  project_id: "b.11223344-5566-7788-99aa-bbccddeeff00", folder_id: "urn:adsk.wipprod:fs.folder:co.AbCdEf123_-x", model_name: "F26901-FMC-ZZ-ZZ-M3-A-0009",
};

// ---- path guard ----
test("CollaborationCache guard catches every spelling in the fixtures and leaves ordinary paths alone", () => {
  for (const p of FX.cache) assert.equal(mentionsCollaborationCache(p), true, p);
  for (const p of FX.not_cache) assert.equal(mentionsCollaborationCache(p), false, p);
  assert.equal(mentionsCollaborationCache(undefined), false);
});

test("cacheHits walks nested arguments, including keys", () => {
  const hits = cacheHits({ a: "ok", b: ["x", { c: FX.cache[0] }], CollaborationCache: 1 });
  assert.deepEqual(hits.map((h) => h.field).sort(), ["args.CollaborationCache", "args.b[1].c"].sort());
});

test("redactCache hides cache paths in a Revit reply", () => {
  const r = redactCache({ path_name: FX.cache[0], cloud: { user_visible_path: "Autodesk Docs://P/M.rvt" }, list: [FX.cache[1]] });
  assert.equal(r.path_name, REDACTED_CACHE);
  assert.equal(r.cloud.user_visible_path, "Autodesk Docs://P/M.rvt");
  assert.deepEqual(r.list, [REDACTED_CACHE]);
});

test("every action refuses an argument naming CollaborationCache before Revit is asked", async () => {
  const dir = tmp();
  const io = { facts: never, cloudPath: never, saveAs: never, reportDir: dir };
  for (const a of [
    { action: "parse", paths: [FX.cache[0]] },
    { action: "facts", documents: [FX.cache[1]] },
    { ...goodSave, folder_id: "urn:adsk.wipprod:fs.folder:CollaborationCache" },
    { ...goodSave, dry_run: false, approved_by: "Emlyn Ogala", model_name: "collaboration cache" },
    { action: "sync", target: FX.cache[2] },
  ]) {
    const r = textOf(await runFmcCloud(args(a), io));
    assert.equal(r.code, "FMC-CLOUD-CACHE", JSON.stringify(a));
    assert.equal(r.isError, true);
  }
});

// ---- parsing ----
test("cloud path parsing matches every fixture", () => {
  for (const f of FX.paths) {
    const p = parseModelPath(f.input);
    assert.equal(p.kind, f.kind, f.input);
    assert.equal(p.cloud, f.cloud, f.input);
    assert.equal(p.project, f.project, f.input);
    assert.deepEqual(p.folders, f.folders, f.input);
    assert.equal(p.model, f.model, f.input);
    assert.equal(p.problems.length, f.problems, f.input + " " + p.problems.join("; "));
  }
});

test("GUIDs and regions", () => {
  for (const g of FX.guids) assert.equal(checkGuidTriple(g).ok, g.ok, JSON.stringify(g));
  const ok = checkGuidTriple(FX.guids[0]);
  assert.ok(ok.ok && ok.value.model_guid === "11223344-5566-7788-99aa-bbccddeeff00" && ok.value.region === "US");
  assert.equal(normalizeGuid("00000000-0000-0000-0000-000000000000"), null);
  assert.equal(normalizeAccGuid("b.0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0"), "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
});

test("parse gives one result per path, offline", async () => {
  const r = textOf(await runFmcCloud(args({ action: "parse", paths: FX.paths.map((p: { input: string }) => p.input) }), { facts: never, cloudPath: never, saveAs: never, reportDir: tmp() }));
  assert.equal(r.count, FX.paths.length);
  assert.equal(r.items.length, FX.paths.length);
  assert.ok(r.items.every((i: { result: string }) => i.result === "ok" || i.result === "problem"));
});

test("cloud_path checks every item and only asks Revit for valid ones", async () => {
  const asked: unknown[] = [];
  const r = textOf(await runFmcCloud(args({ action: "cloud_path", guids: FX.guids.map(({ ok: _ok, ...g }: Record<string, unknown>) => g) }), {
    cloudPath: async (b) => { asked.push(b); return { user_visible_path: "Autodesk Docs://P/M.rvt", cloud_path: true, opened: false }; }, reportDir: tmp(),
  }));
  assert.equal(r.items.length, FX.guids.length);
  assert.equal(asked.length, FX.guids.filter((g: { ok: boolean }) => g.ok).length);
  assert.deepEqual(r.items.map((i: { result: string }) => i.result), FX.guids.map((g: { ok: boolean }) => (g.ok ? "ok" : "refused")));
});

test("facts gives a result for every document, errors included, and redacts cache paths", async () => {
  const r = textOf(await runFmcCloud(args({ action: "facts", documents: ["A", "Missing", "C"] }), {
    facts: async (b) => {
      if (b.document === "Missing") throw new Error("[FMC-DOC-NOT-FOUND] Missing");
      return { title: b.document, is_cloud: b.document === "C", path_name: b.document === "C" ? FX.cache[0] : "C:\\x\\A.rvt" };
    }, reportDir: tmp(),
  }));
  assert.equal(r.items.length, 3);
  assert.deepEqual(r.items.map((i: { result: string }) => i.result), ["ok", "error", "ok"]);
  assert.equal(r.items[2].path_name, REDACTED_CACHE);
  assert.equal(r.isError, false);
});

// ---- write gate ----
test("gateWrite: dry run by default, a real write needs dry_run=false and a named person", () => {
  assert.equal(gateWrite({}).mode, "dry_run");
  assert.equal(gateWrite({ dry_run: true, approved_by: "Emlyn" }).mode, "dry_run");
  assert.equal(gateWrite({ dry_run: false }).mode, "refused");
  for (const bad of ["", " ", "yes", "OK", "AI", "Claude", "grok", "Plugin Bot", "agent 7", "x", "12345"])
    assert.equal(gateWrite({ dry_run: false, approved_by: bad }).mode, "refused", bad);
  const ok = gateWrite({ dry_run: false, approved_by: "Emlyn Ogala" });
  assert.equal(ok.mode, "write");
});

test("save_as_cloud dry run reports exactly what would happen and never calls Revit's save", async () => {
  const r = textOf(await runFmcCloud(args(goodSave), { facts: async () => plainDoc, saveAs: never, reportDir: tmp() }));
  assert.equal(r.dry_run, true);
  assert.equal(r.plan.ok, true);
  assert.equal(r.plan.model_name, "F26901-FMC-ZZ-ZZ-M3-A-0009.rvt");
  assert.equal(r.plan.account_guid, "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
  assert.ok(r.plan.would.some((w: string) => w.includes("SaveAsCloudModel")));
  assert.equal(r.items[0].result, "would save as cloud model");
});

test("save_as_cloud with dry_run=false but no approved_by is refused and never calls Revit's save", async () => {
  for (const approved_by of ["", "yes", "AI"]) {
    const r = textOf(await runFmcCloud(args({ ...goodSave, dry_run: false, approved_by }), { facts: async () => plainDoc, saveAs: never, reportDir: tmp() }));
    assert.equal(r.code, "FMC-CLOUD-APPROVAL", approved_by);
    assert.equal(r.isError, true);
    assert.equal(r.saved, false);
  }
});

test("approved_by without dry_run=false is still only a dry run", async () => {
  const r = textOf(await runFmcCloud(args({ ...goodSave, approved_by: "Emlyn Ogala" }), { facts: async () => plainDoc, saveAs: never, reportDir: tmp() }));
  assert.equal(r.dry_run, true);
  assert.equal(r.saved, false);
});

test("save_as_cloud with dry_run=false and a named person calls Revit once with the planned ids", async () => {
  const sent: Record<string, unknown>[] = [];
  const r = textOf(await runFmcCloud(args({ ...goodSave, dry_run: false, approved_by: "Emlyn Ogala" }), {
    facts: async () => plainDoc, saveAs: async (b) => { sent.push(b); return { saved_as_cloud: true }; }, reportDir: tmp(),
  }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].account_id, "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
  assert.equal(sent[0].project_id, "11223344-5566-7788-99aa-bbccddeeff00");
  assert.equal(sent[0].approved_by, "Emlyn Ogala");
  assert.equal(r.saved, true);
  assert.equal(r.synced, false);
});

test("save_as_cloud refuses workshared, cloud, family and read-only documents and bad ids, even approved", async () => {
  for (const doc of [{ ...plainDoc, is_workshared: true }, { ...plainDoc, is_cloud: true }, { ...plainDoc, is_family: true }, { ...plainDoc, is_read_only: true }]) {
    const r = textOf(await runFmcCloud(args({ ...goodSave, dry_run: false, approved_by: "Emlyn Ogala" }), { facts: async () => doc, saveAs: never, reportDir: tmp() }));
    assert.equal(r.code, "FMC-CLOUD-PLAN", JSON.stringify(doc));
  }
  const bad = planSaveAsCloud(plainDoc, { account_id: "nope", project_id: "", folder_id: "folder", model_name: "a/b" });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.length >= 4);
});

test("sync and publish: dry run describes a person's step; real runs are refused even with approval (rule 6)", async () => {
  for (const action of ["sync", "publish"]) {
    const dry = textOf(await runFmcCloud(args({ action, target: "A" }), { facts: async () => ({ ...plainDoc, is_cloud: true, is_workshared: true }), saveAs: never, reportDir: tmp() }));
    assert.equal(dry.dry_run, true);
    assert.equal(dry.isError, false);
    const noApproval = textOf(await runFmcCloud(args({ action, target: "A", dry_run: false }), { facts: async () => plainDoc, saveAs: never, reportDir: tmp() }));
    assert.equal(noApproval.code, "FMC-CLOUD-APPROVAL");
    const approved = textOf(await runFmcCloud(args({ action, target: "A", dry_run: false, approved_by: "Emlyn Ogala" }), { facts: async () => plainDoc, saveAs: never, reportDir: tmp() }));
    assert.equal(approved.code, "FMC-CLOUD-RULE6");
    assert.equal(approved.synced, false);
    assert.equal(approved.published, false);
  }
});

test("the add-in commands are classed: reads are reads, the save is a write behind the live-model lock", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_cloud_facts"));
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_cloud_path"));
  assert.ok(WRITE_COMMANDS.has("fmc_cloud_save_as"));
  assert.equal(WRITE_COMMANDS.has("fmc_cloud_facts"), false);
});
