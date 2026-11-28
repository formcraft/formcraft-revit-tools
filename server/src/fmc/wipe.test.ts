import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";
import { DEFAULT_WIPE_CATEGORIES, planWipe, wipeGate, type ScanRow } from "./wipe.js";
import { FMC_WIPE_SHAPE, runFmcWipe, type FmcWipeArgs } from "../tools/fmc_wipe.js";

const root = new URL("../../../", import.meta.url);
const args = (p: Record<string, unknown>): FmcWipeArgs => z.object(FMC_WIPE_SHAPE).parse({ document: "M", ...p });
const out = (r: { content: Array<{ text: string }>; isError?: boolean }) => ({ ...JSON.parse(r.content[0].text), isError: r.isError === true });

const rows: ScanRow[] = [
  { id: "101", category: "unused_view_templates", name: "Old Template", checkout: "not_owned" },
  { id: "102", category: "unused_view_templates", name: "FMC_Plan_1to100", checkout: "not_owned" },
  { id: "201", category: "unused_filters", name: "Temp filter", checkout: "owned_by_other", owner: "jane" },
  { id: "202", category: "unused_filters", name: "Walls red" },
  { id: "301", category: "unplaced_views", name: "{3D - bob}" },
  { id: "302", category: "unplaced_views", name: "Section 4" },
  { id: "401", category: "cad_imports", name: "survey.dwg" },
  { id: "302", category: "purgeable", name: "Section 4" },
];
const read = async () => ({ title: "M", path: "C:\\Jobs\\P\\01_WIP\\M.rvt", rows });
const guard = { ...DEFAULT_CONFIG, write_roots: ["C:\\Jobs"] };

test("wipe: default categories leave out the deep purge", () => {
  assert.ok(!DEFAULT_WIPE_CATEGORIES.includes("purgeable"));
  assert.equal(DEFAULT_WIPE_CATEGORIES.length, 6);
});

test("wipe: the plan counts per category, skips other users' elements and protected names, and lists ids", () => {
  const p = planWipe(rows, { categories: [...DEFAULT_WIPE_CATEGORIES, "purgeable"] });
  assert.deepEqual(p.counts, { unused_view_templates: 1, unused_filters: 1, unplaced_views: 1, unplaced_schedules: 0, cad_imports: 1, orphan_tags: 0, purgeable: 0 });
  assert.deepEqual(p.ids.unused_filters, ["202"]);
  assert.deepEqual(p.items.map((i) => i.id), ["101", "202", "302", "401"], "302 once though purge found it too");
  assert.deepEqual(p.skipped.map((s) => [s.id, s.reason.split(" ")[0]]), [["102", "protected"], ["201", "owned"], ["301", "protected"]]);
  assert.match(p.skipped[1].reason, /jane/);
});

test("wipe: ids narrow the plan and unknown ids are problems; bad patterns are problems", () => {
  const p = planWipe(rows, { categories: DEFAULT_WIPE_CATEGORIES, onlyIds: ["401", "999"] });
  assert.deepEqual(p.items.map((i) => i.id), ["401"]);
  assert.match(p.problems.join(), /999/);
  assert.equal(planWipe(rows, { categories: ["cad_imports"], protect: ["survey"] }).items.length, 0);
  assert.ok(planWipe(rows, { categories: ["cad_imports"], protect: ["("] }).problems.length);
});

test("wipe: the gate needs confirm, a lease and a count under max", () => {
  assert.deepEqual(wipeGate({ dry_run: true, confirm: false, lease: "", count: 9999, max: 1 }), []);
  const g = wipeGate({ dry_run: false, confirm: false, lease: "", count: 600, max: 500 });
  assert.equal(g.length, 3);
  assert.deepEqual(wipeGate({ dry_run: false, confirm: true, lease: "L", count: 3, max: 500 }), []);
});

test("wipe: scan and the C# side are registered; apply is behind the live-model lock", () => {
  const names = (JSON.parse(fs.readFileSync(new URL("command.json", root), "utf8")) as { commands: Array<{ commandName: string }> }).commands.map((c) => c.commandName);
  assert.ok(names.includes("fmc_wipe_scan") && names.includes("fmc_wipe_apply"));
  assert.ok(WRITE_COMMANDS.has("fmc_wipe_apply"));
  assert.ok(!WRITE_COMMANDS.has("fmc_wipe_scan") && !READ_VIA_SEND_COMMAND.has("fmc_wipe_scan"), "the scan goes through sendRaw");
  const cs = fs.readFileSync(new URL("commandset/Services/Fmc/FmcWipe.cs", root), "utf8");
  assert.ok(cs.includes('"Formcraft: wipe"') && cs.includes("OwnedByOtherUser") && cs.includes("FMC-BATCH-LOCKED"));
  assert.ok(!cs.includes("fmc_fam_purge\"") && !cs.includes("FamilyManager"));
});

test("wipe tool: scan is read-only and reports counts and ids", async () => {
  const r = out(await runFmcWipe(args({ action: "scan" }), { read, guard }));
  assert.equal(r.read_only, true);
  assert.equal(r.total, 4);
  assert.equal(r.skipped_count, 3);
  assert.deepEqual(r.ids.cad_imports, ["401"]);
});

test("wipe tool: apply is a dry run by default and never calls Revit's delete", async () => {
  let called = 0;
  const r = out(await runFmcWipe(args({ action: "apply", confirm: true, batch_lease: "L" }), { read, apply: async () => { called++; return {}; }, guard }));
  assert.equal(r.dry_run, true);
  assert.equal(r.would_delete, 4);
  assert.equal(called, 0);
});

test("wipe tool: dry_run=false without confirm or lease is refused", async () => {
  const io = { read, apply: async () => { throw new Error("must not run"); }, guard };
  assert.equal(out(await runFmcWipe(args({ action: "apply", dry_run: false, batch_lease: "L" }), io)).code, "FMC-WIPE-GATE");
  assert.equal(out(await runFmcWipe(args({ action: "apply", dry_run: false, confirm: true }), io)).code, "FMC-BATCH-LOCKED");
  assert.equal(out(await runFmcWipe(args({ action: "apply", dry_run: false, confirm: true, batch_lease: "L", max: 2 }), io)).code, "FMC-WIPE-GATE");
  assert.equal(out(await runFmcWipe(args({ action: "apply", dry_run: false, confirm: true, batch_lease: "L", ids: ["999"] }), io)).code, "FMC-WIPE-IDS");
});

test("wipe tool: a confirmed delete sends only the planned ids and reports deleted, cascade and skipped", async () => {
  let sent: Record<string, unknown> = {};
  const apply = async (b: Record<string, unknown>) => { sent = b; return { deleted: ["101", "202"], cascade_ids: ["9001"], cascade_count: 1, skipped: [{ id: "302", reason: "no longer unplaced_views" }] }; };
  const r = out(await runFmcWipe(args({ action: "apply", dry_run: false, confirm: true, batch_lease: "L", ids: ["101", "202", "302"] }), { read, apply, guard }));
  assert.deepEqual((sent.items as Array<{ id: string }>).map((i) => i.id), ["101", "202", "302"]);
  assert.equal(sent.batch_lease, "L");
  assert.equal(r.deleted_count, 2);
  assert.equal(r.cascade_count, 1);
  assert.equal(r.skipped_in_revit_count, 1);
});
