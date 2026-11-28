import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { appliedSummary, catalogueOk, filterDetails, latestDetailsReport, loadCatalogue, planDetails, readBatchFile, writeOrReuseDetailsReport } from "./detailcat.js";
import { FMC_DETAILS_SHAPE, runFmcDetails, type FmcDetailsArgs } from "../tools/fmc_details.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function args(partial: Record<string, unknown>): FmcDetailsArgs {
  return z.object(FMC_DETAILS_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, unknown> & { isError: boolean } {
  const body = JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>;
  return { ...body, isError: result.isError === true };
}

function kitDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-details-"));
  fs.writeFileSync(path.join(dir, "D-A-001.rvt"), "");
  fs.writeFileSync(path.join(dir, "D-A-002.rfa"), "");
  fs.writeFileSync(path.join(dir, "FMC_Details.json"), JSON.stringify({
    details: [
      { id: "D-A-001", name: "Window head", source: "D-A-001.rvt", view: "Head", kind: "drafting", sheet: "A-501" },
      { id: "D-A-010", name: "Missing", source: "no-such.rvt", view: "Head" },
    ],
  }));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-details-state-"));
  const guard: GuardConfig = { ...DEFAULT_CONFIG, protected_paths: ["D:\\Live"], save_exclude: ["HEBERT HOSTELS"], sync_exclude: [] };
  const env = { ...process.env, APPDATA: state, LOCALAPPDATA: state, FMC_DETAILS_DIR: dir, FMC_DETAILS_REPORT: path.join(state, "details") } as NodeJS.ProcessEnv;
  return { dir, env, guard, reportDir: path.join(state, "details") };
}

const project = {
  title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  path: "D:\\Jobs\\_Staging\\F26901-FMC-ZZ-ZZ-M3-A-0002_USER.rvt",
  is_central: false,
  resolved_document: { title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", path: "D:\\Jobs\\_Staging\\F26901-FMC-ZZ-ZZ-M3-A-0002_USER.rvt" },
};

test("catalogue merges the Details folder and FMC_Details.json and does not invent a missing folder", () => {
  const io = kitDir();
  const catalogue = loadCatalogue(io.dir);
  const ids = catalogue.details.map((row) => row.id);
  assert.ok(ids.includes("D-A-001"));
  assert.ok(ids.includes("D-A-002"));
  const head = catalogue.details.find((row) => row.id === "D-A-001");
  assert.equal(head?.name, "Window head");
  assert.equal(head?.from, "both");
  assert.equal(head?.kind, "drafting");
  const family = catalogue.details.find((row) => row.id === "D-A-002");
  assert.equal(family?.kind, "family");
  assert.equal(loadCatalogue(path.join(io.dir, "missing")).details.length, 0);
  assert.match(loadCatalogue(path.join(io.dir, "missing")).problems[0], /Kit change/);
});

test("a batch file lists detail ids and place stays a dry run until the lease and references are present", async () => {
  const io = kitDir();
  const batch = path.join(io.dir, "batch.json");
  fs.writeFileSync(batch, JSON.stringify({ detail_ids: ["D-A-001"], details: [{ detail_id: "D-A-002", view_name: "DET Sill", sheet: "A-502" }] }));
  assert.equal(readBatchFile(batch).length, 2);
  const listed = textOf(await runFmcDetails(args({ action: "list" }), { ...io, catalogueFolder: io.dir }));
  assert.equal(listed.isError, false);
  assert.equal(listed.read_only, true);
  assert.ok((listed.count as number) >= 2);

  const dry = textOf(await runFmcDetails(args({ action: "place", document: project.title, batch_file: batch, dry_run: true }), {
    ...io, catalogueFolder: io.dir, read: async () => project,
  }));
  assert.equal(dry.isError, false);
  assert.equal(dry.dry_run, true);
  assert.equal(dry.read_only, true);
  const ops = dry.ops as Array<{ detail_id: string; view_name: string; sheet: string }>;
  assert.equal(ops.length, 2);
  assert.equal(ops[1].view_name, "DET Sill");
  assert.equal(ops[0].sheet, "A-501");

  const locked = textOf(await runFmcDetails(args({ action: "place", document: project.title, detail_id: "D-A-001", dry_run: false }), {
    ...io, catalogueFolder: io.dir, read: async () => project,
  }));
  assert.equal(locked.code, "FMC-BATCH-LOCKED");
  const refs = textOf(await runFmcDetails(args({
    action: "place", document: project.title, detail_id: "D-A-001", dry_run: false, batch_lease: "lease-1",
  }), { ...io, catalogueFolder: io.dir, read: async () => project }));
  assert.equal(refs.code, "FMC-DETAIL-REFERENCES");
});

test("place apply sends the plan once, and a kit original or an unknown id is refused", async () => {
  const io = kitDir();
  const sent: { body: Record<string, unknown> | null } = { body: null };
  const applied = textOf(await runFmcDetails(args({
    action: "place", document: project.title, detail_id: "D-A-001", dry_run: false, batch_lease: "lease-1",
    references: { kit: ["FMC-BIM-MAN-001"], standards: ["FMC-BIM-STD-002"], rulebook: ["AI modeller copies details"] },
  }), {
    ...io,
    catalogueFolder: io.dir,
    read: async () => project,
    apply: async (body) => { sent.body = body; return { ok: true, kit_saved: false, placed: [{ detail_id: "D-A-001" }] }; },
  }));
  assert.equal(applied.isError, false);
  assert.equal(applied.dry_run, false);
  assert.equal(applied.kit_saved, false);
  assert.equal((sent.body?.ops as unknown[]).length, 1);

  const missing = textOf(await runFmcDetails(args({ action: "place", document: project.title, detail_id: "NOPE" }), {
    ...io, catalogueFolder: io.dir, read: async () => project,
  }));
  assert.equal(missing.code, "FMC-DETAIL-NOT-FOUND");

  const kit = textOf(await runFmcDetails(args({ action: "place", document: "FMC_A_Titleblock", detail_id: "D-A-001" }), {
    ...io,
    catalogueFolder: io.dir,
    read: async () => ({ title: "FMC_A_Titleblock", path: "Z:\\00_Standards\\04_Families\\A\\FMC_A_Titleblock.rfa", is_central: false, resolved_document: { title: "FMC_A_Titleblock", path: "Z:\\00_Standards\\04_Families\\A\\FMC_A_Titleblock.rfa" } }),
  }));
  assert.equal(kit.code, "FMC-DETAIL-GUARD");

  const planned = planDetails(loadCatalogue(io.dir), Array.from({ length: 51 }, (_, i) => ({ detail_id: "D-A-001", view_name: "V" + i })));
  assert.equal(planned.ops.length, 51);
  const cap = textOf(await runFmcDetails(args({
    action: "place", document: project.title, details: planned.ops.map((op) => ({ detail_id: op.detail_id, view_name: op.view_name })),
  }), { ...io, catalogueFolder: io.dir, read: async () => project }));
  assert.equal(cap.code, "FMC-DETAIL-CAP");

  const apply = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcDetailsApply.cs"), "utf8");
  assert.match(apply, /Close\(false\)/);
  assert.equal(apply.includes(".Save("), false);
  assert.equal(apply.includes("SaveAs"), false);
  assert.ok(WRITE_COMMANDS.has("fmc_details_apply"));
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_details"));
  assert.equal(WRITE_COMMANDS.has("fmc_details"), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  const names = new Set(manifest.commands.map((row) => row.commandName));
  assert.ok(names.has("fmc_details") && names.has("fmc_details_apply"));
});

test("P-fmc_details-01: an unreadable catalogue is catalogue_ok false, and an empty one is an error", async () => {
  const io = kitDir();
  const missingFolder = path.join(io.dir, "no-such-Details");
  const empty = textOf(await runFmcDetails(args({ action: "list" }), { ...io, catalogueFolder: missingFolder }));
  assert.equal(empty.catalogue_ok, false);
  assert.equal(empty.count, 0);
  assert.equal(empty.isError, true);
  assert.match((empty.problems as string[])[0], /FMC-DETAILS-CATALOGUE/);
  // a readable catalogue with one row whose source is missing is still ok, and not an error
  const ok = textOf(await runFmcDetails(args({ action: "list" }), { ...io, catalogueFolder: io.dir }));
  assert.equal(ok.catalogue_ok, true);
  assert.equal(ok.isError, false);
  assert.ok((ok.problems as string[]).some((p) => p.startsWith("FMC-DETAIL-SOURCE")));
  // folder files but no FMC_Details.json: listed, catalogue_ok false, not an error (rows are usable)
  fs.rmSync(path.join(io.dir, "FMC_Details.json"));
  const noJson = textOf(await runFmcDetails(args({ action: "list" }), { ...io, catalogueFolder: io.dir }));
  assert.equal(noJson.catalogue_ok, false);
  assert.ok((noJson.count as number) >= 2);
  assert.equal(noJson.isError, false);
  assert.equal(catalogueOk(loadCatalogue(io.dir)), false);
});

test("P-fmc_details-02: list writes its report only when the list changed", async () => {
  const io = kitDir();
  const first = textOf(await runFmcDetails(args({ action: "list" }), { ...io, catalogueFolder: io.dir }));
  const second = textOf(await runFmcDetails(args({ action: "list" }), { ...io, catalogueFolder: io.dir }));
  assert.equal(first.report_reused, false);
  assert.equal(second.report_reused, true);
  assert.equal(second.report, first.report);
  assert.equal(fs.readdirSync(io.reportDir).filter((n) => n.startsWith("details-list-")).length, 1);
  fs.writeFileSync(path.join(io.dir, "D-A-003.rvt"), "");
  const third = textOf(await runFmcDetails(args({ action: "list" }), { ...io, catalogueFolder: io.dir }));
  assert.equal(third.report_reused, false);
  assert.equal(fs.readdirSync(io.reportDir).filter((n) => n.startsWith("details-list-")).length, 2);
  assert.equal(latestDetailsReport("list", io.reportDir), third.report);
  assert.equal(writeOrReuseDetailsReport(io.env, "list", { x: 1 }, path.join(io.reportDir, "fresh")).reused, false);
});

test("list filters by kind and by words in the id or name, and keeps the total", async () => {
  const io = kitDir();
  const fam = textOf(await runFmcDetails(args({ action: "list", kind: "family" }), { ...io, catalogueFolder: io.dir }));
  assert.deepEqual((fam.details as Array<{ id: string }>).map((d) => d.id), ["D-A-002"]);
  assert.equal(fam.total, 3);
  assert.deepEqual(fam.filter, { kind: "family" });
  const head = textOf(await runFmcDetails(args({ action: "list", query: "window HEAD" }), { ...io, catalogueFolder: io.dir }));
  assert.deepEqual((head.details as Array<{ id: string }>).map((d) => d.id), ["D-A-001"]);
  const all = textOf(await runFmcDetails(args({ action: "list" }), { ...io, catalogueFolder: io.dir }));
  assert.equal(all.total, undefined, "no filter: no total field, as before");
  assert.equal(filterDetails(loadCatalogue(io.dir).details, {}).length, 3);
});

test("source_view chooses the source drafting view per call; the catalogue view stays the default", async () => {
  const io = kitDir();
  const cat = loadCatalogue(io.dir);
  assert.equal(planDetails(cat, [{ detail_id: "D-A-001" }]).ops[0].view, "Head");
  assert.equal(planDetails(cat, [{ detail_id: "D-A-001", source_view: "Sill" }]).ops[0].view, "Sill");
  const batch = path.join(io.dir, "batch-sv.json");
  fs.writeFileSync(batch, JSON.stringify({ details: [{ detail_id: "D-A-001", source_view: "Jamb" }] }));
  assert.equal(readBatchFile(batch)[0].source_view, "Jamb");
  const dry = textOf(await runFmcDetails(args({ action: "place", document: project.title, detail_id: "D-A-001", source_view: "Sill" }), {
    ...io, catalogueFolder: io.dir, read: async () => project,
  }));
  assert.equal((dry.ops as Array<{ view: string }>)[0].view, "Sill");
  const rows = textOf(await runFmcDetails(args({ action: "place", document: project.title, details: [{ detail_id: "D-A-001", source_view: "Jamb" }], source_view: "Sill" }), {
    ...io, catalogueFolder: io.dir, read: async () => project,
  }));
  assert.equal((rows.ops as Array<{ view: string }>)[0].view, "Jamb", "a row's own source_view wins");
});

test("a real place returns per-detail status and created_ids from the add-in's reply", async () => {
  const io = kitDir();
  const applied = textOf(await runFmcDetails(args({
    action: "place", document: project.title, detail_ids: ["D-A-001", "D-A-002"], dry_run: false, batch_lease: "lease-1",
    references: { kit: ["FMC-BIM-MAN-001"], standards: ["FMC-BIM-STD-002"], rulebook: ["AI modeller copies details"] },
  }), {
    ...io, catalogueFolder: io.dir, read: async () => project,
    apply: async () => ({ ok: true, placed: [{ detail_id: "D-A-001", view_id: "501", created_view: true }, { detail_id: "D-A-002", view_id: "502", created_view: false }],
      skipped: [{ detail_id: "D-A-009", code: "FMC-DETAIL-EMPTY" }] }),
  }));
  assert.deepEqual(applied.created_ids, ["501"]);
  assert.deepEqual(applied.status, [
    { detail_id: "D-A-001", status: "created", view_id: "501" },
    { detail_id: "D-A-002", status: "reused", view_id: "502" },
    { detail_id: "D-A-009", status: "skipped", code: "FMC-DETAIL-EMPTY" },
  ]);
  assert.deepEqual(appliedSummary(undefined), { status: [], created_ids: [] });
});
