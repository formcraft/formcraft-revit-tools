import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, UI_COMMANDS, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { EXPORT_COLUMNS_MAX, FilterTool, isEngineCall, reasonsCsv, toCsv, type FilterDeps } from "./filter.js";

type Call = { command: string; params: Record<string, unknown> };

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fmc-filter-"));
}

function setup(opts: { reply?: (c: Call, n: number) => any; config?: Partial<GuardConfig>; holder?: { lease: string; client: string } | null; client?: string; active?: boolean; kit?: Record<string, unknown> | null; docPath?: string } = {}) {
  const calls: Call[] = [];
  const root = tmp();
  const reports = tmp();
  const deps: FilterDeps = {
    send: async (command, params) => {
      const c = { command, params };
      calls.push(c);
      if (command === "fmc_select_by" && params.action === "doc") return { ok: true, title: "F26901-FMC-ZZ-ZZ-M3-A-0002", path: opts.docPath ?? "C:\\Staging\\F26901-FMC-ZZ-ZZ-M3-A-0002.rvt", active: opts.active ?? true };
      const n = calls.filter((x) => x.params.action === params.action && x.command === command).length;
      if (opts.reply) { const r = opts.reply(c, n); if (r !== undefined) return r; }
      return { ok: true, result_set: "rs_aaaaaaaaaaaa", query_hash: "q_bbbbbbbbbbbb", total: 3, undetermined: 1, skipped: 0 };
    },
    config: { ...DEFAULT_CONFIG, reports_dir: reports, ...(opts.config ?? {}) },
    caller: () => "Family Types & Placement Bot",
    client: () => opts.client ?? "session-1",
    leaseHolder: () => opts.holder ?? null,
    kit: () => opts.kit ?? null,
    storeRoot: root,
    now: () => new Date("2026-11-28T07:30:00Z"),
    projectOf: () => "",
  };
  return { tool: new FilterTool(deps), calls, root, reports };
}

test("a flat select_by call stays on the old path; an engine argument goes to the filter engine", () => {
  assert.equal(isEngineCall({ category: "Walls", level: "L2" }), false);
  assert.equal(isEngineCall({ category: "Walls", limit: 50 }), false);
  for (const k of ["action", "criteria", "cursor", "result_set", "scope", "invert", "set", "history_id"]) assert.equal(isEngineCall({ [k]: "x" }), true, k);
});

test("preview sends the tree to fmc_select_by and writes a history line (query and counts only)", async () => {
  const { tool, calls } = setup();
  const r = await tool.run({ action: "preview", criteria: { all: [{ category: "OST_Doors" }, { param: "Height", op: ">", value: 2000 }] } });
  assert.equal(r.ok, true);
  const sent = calls.find((c) => c.params.action === "preview")!;
  assert.equal(sent.command, "fmc_select_by");
  assert.deepEqual(sent.params.criteria, { all: [{ category: "OST_Doors" }, { param: "Height", op: ">", value: 2000 }] });
  assert.match(String(r.history_id), /^h_[0-9a-f]{12}$/);
  const h = await tool.run({ action: "history" });
  const line = (h.history as any[])[0];
  assert.equal(line.query_hash, "q_bbbbbbbbbbbb");
  assert.equal(line.result_set, "rs_aaaaaaaaaaaa");
  assert.equal(line.total, 3);
  assert.equal(line.by, "Family Types & Placement Bot");
});

test("exactly one source: none or two are refused before Revit is asked", async () => {
  const { tool, calls } = setup();
  const none = await tool.run({ action: "run" });
  assert.equal(none.code, "FMC-FILTER-BAD-CRITERIA");
  const two = await tool.run({ action: "run", criteria: { category: "OST_Walls" }, set: "x" });
  assert.equal(two.code, "FMC-FILTER-BAD-CRITERIA");
  assert.equal(calls.length, 0);
  const bad = await tool.run({ action: "frobnicate" });
  assert.equal(bad.code, "FMC-FILTER-BAD-CRITERIA");
});

test("an add-in refusal comes back structured (code, hint), not as a thrown string", async () => {
  const { tool } = setup({ reply: (c) => c.params.action === "run" ? { ok: false, code: "FMC-FILTER-TOO-BROAD", message: "[FMC-FILTER-TOO-BROAD] x", hint: "narrow it", total: 60000 } : undefined });
  const r = await tool.run({ action: "run", criteria: { category: "OST_Walls" } });
  assert.equal(r.ok, false);
  assert.equal(r.code, "FMC-FILTER-TOO-BROAD");
  assert.equal(r.total, 60000);
});

test("save_set from a result set, then preview by set name re-runs the stored query live", async () => {
  const { tool, calls } = setup();
  await tool.run({ action: "run", criteria: { category: "OST_Walls" }, scope: { links: "both" } });
  const saved = await tool.run({ action: "save_set", result_set: "rs_aaaaaaaaaaaa", set: { name: "Ext walls L2", note: "fire QA" } });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const listed = await tool.run({ action: "sets" });
  assert.equal((listed.sets as any[])[0].name, "Ext walls L2");
  await tool.run({ action: "preview", set: "ext walls l2" });
  const last = calls.filter((c) => c.params.action === "preview").pop()!;
  assert.deepEqual(last.params.criteria, { category: "OST_Walls" });
  assert.deepEqual(last.params.scope, { links: "both" });
  const dup = await tool.run({ action: "save_set", criteria: { category: "OST_Doors" }, set: { name: "EXT WALLS L2" } });
  assert.equal(dup.code, "FMC-FILTER-SET-EXISTS");
  const del = await tool.run({ action: "delete_set", set: "Ext walls L2" });
  assert.equal(del.ok, true);
  const gone = await tool.run({ action: "preview", set: "Ext walls L2" });
  assert.equal(gone.code, "FMC-FILTER-SET-NOT-FOUND");
});

test("a flat query saved as a set comes back flat (the add-in maps it to leaves)", async () => {
  const { tool, calls } = setup();
  await tool.run({ action: "save_set", category: ["Doors"], level: "L2", set: { name: "doors" } });
  await tool.run({ action: "run", set: "doors" });
  const sent = calls.filter((c) => c.params.action === "run").pop()!;
  assert.deepEqual(sent.params.category, ["Doors"]);
  assert.equal(sent.params.level, "L2");
  assert.equal(sent.params.criteria, undefined);
});

test("page: an expired snapshot resumes with the query from history (spec 5.6)", async () => {
  const { tool, calls } = setup({
    reply: (c, n) => c.params.action === "page" && n === 1 ? { ok: false, code: "FMC-FILTER-CURSOR-EXPIRED", query_hash: "q_bbbbbbbbbbbb" } : c.params.action === "page" ? { ok: true, resumed: true, total: 3, cursor: null } : undefined,
  });
  await tool.run({ action: "run", criteria: { category: "OST_Doors" } });
  const r = await tool.run({ action: "page", cursor: "c1.xyz" });
  assert.equal(r.ok, true);
  assert.equal(r.resumed, true);
  const pages = calls.filter((c) => c.params.action === "page");
  assert.equal(pages.length, 2);
  assert.equal(pages[0].params.criteria, undefined);
  assert.deepEqual(pages[1].params.criteria, { category: "OST_Doors" });
  assert.equal(pages[1].params.cursor, "c1.xyz");
  const nocursor = await tool.run({ action: "page" });
  assert.equal(nocursor.code, "FMC-FILTER-BAD-CRITERIA");
});

test("decision 3: show is refused while another bot holds the lease; the owner may; a background model is refused", async () => {
  const busy = setup({ holder: { lease: "L1", client: "other-session" } });
  const r = await busy.tool.run({ action: "show", result_set: "rs_aaaaaaaaaaaa" });
  assert.equal(r.code, "FMC-FILTER-SHOW-BUSY");
  assert.equal(busy.calls.some((c) => c.command === "fmc_select_by_show"), false);
  const mine = setup({ holder: { lease: "L1", client: "session-1" } });
  const ok = await mine.tool.run({ action: "show", result_set: "rs_aaaaaaaaaaaa", show: { zoom: false, max: 100 } });
  assert.equal(ok.activity, "ui");
  const sent = mine.calls.find((c) => c.command === "fmc_select_by_show")!;
  assert.deepEqual(sent.params.show, { zoom: false, max: 100 });
  const bg = setup({ active: false });
  assert.equal((await bg.tool.run({ action: "show", ids: [1] })).code, "FMC-FILTER-UI-NEEDS-ACTIVE");
  assert.equal((await setup().tool.run({ action: "show" })).code, "FMC-FILTER-BAD-CRITERIA");
});

function rowsReply(total: number) {
  return (c: Call) => {
    if (c.params.action !== "rows") return undefined;
    const from = Number(c.params.from);
    const n = Math.max(0, Math.min(500, total - from));
    const elements = Array.from({ length: n }, (_, i) => ({ id: from + i + 1, name: `D${from + i}`, category: "Doors", doc: "A-0002", link: null, params: { Mark: `M${from + i}`, Width: 900, "type.Fire Rating": i % 2 ? "60" : null, Notes: 'say "hi", ok' } }));
    return {
      ok: true, total, from, elements, done: from + n >= total, skipped: from === 0 ? [{ id: 99, reason: "ELEMENT_DELETED" }] : [],
      ...(from === 0 ? { meta: { query: { criteria: { category: "OST_Doors" } }, docs: [] }, all_undetermined: [{ id: 7, reason: "PARAM_MISSING", param: "Fire Rating" }], all_skipped: [{ id: 8, reason: "NO_LOCATION" }] } : {}),
    };
  };
}

test("export CSV streams 500-row chunks, writes every row and a _skipped.csv, default into reports\\Filters", async () => {
  const { tool, calls, reports } = setup({ reply: rowsReply(1203) });
  const r = await tool.run({ action: "export", result_set: "rs_aaaaaaaaaaaa", export: { format: "csv" } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rows, 1203);
  assert.equal(calls.filter((c) => c.params.action === "rows").length, 3);
  assert.equal(calls.find((c) => c.params.action === "rows")!.params.params, "all");
  const [csv, side] = r.files as string[];
  assert.ok(csv.startsWith(path.join(reports, "Filters")));
  assert.match(path.basename(csv), /^\d{8}-\d{6}_rs_aaaaaaaaaaaa\.csv$/);
  const lines = fs.readFileSync(csv, "utf8").trim().split("\r\n");
  assert.equal(lines.length, 1204);
  assert.ok(lines[0].startsWith("id,unique_id,name,category"));
  assert.ok(lines[0].includes("type.Fire Rating"));
  assert.ok(lines[1].includes('"say ""hi"", ok"'));
  const skippedLines = fs.readFileSync(side, "utf8").trim().split("\r\n");
  assert.equal(skippedLines.length, 4);   // header, 1 undetermined, 2 skipped
  assert.deepEqual(r.skipped_by_reason, { NO_LOCATION: 1, ELEMENT_DELETED: 1 });
});

test("export JSON carries meta (query, totals, exported_at with offset) and the skipped and undetermined rows", async () => {
  const { tool } = setup({ reply: rowsReply(3) });
  const r = await tool.run({ action: "export", result_set: "rs_aaaaaaaaaaaa", export: { format: "json" } });
  const body = JSON.parse(fs.readFileSync((r.files as string[])[0], "utf8"));
  assert.equal(body.elements.length, 3);
  assert.equal(body.undetermined.length, 1);
  assert.equal(body.skipped.length, 2);
  assert.match(body.meta.exported_at, /[+-]\d\d:\d\d$/);
  assert.deepEqual(body.meta.query, { criteria: { category: "OST_Doors" } });
});

test("export: a path outside write_roots is refused; one inside is used; over 100k rows is refused", async () => {
  const { tool } = setup({ reply: rowsReply(10) });
  const refused = await tool.run({ action: "export", result_set: "rs_aaaaaaaaaaaa", export: { path: "D:\\Fomcraft\\FMC_PROJECTS_27\\x.csv" } });
  assert.equal(refused.code, "FMC-FILTER-EXPORT-PATH");
  const relative = await tool.run({ action: "export", result_set: "rs_aaaaaaaaaaaa", export: { path: "x.csv" } });
  assert.equal(relative.code, "FMC-FILTER-EXPORT-PATH");
  const dir = tmp();
  const allowed = setup({ reply: rowsReply(10), config: { write_roots: [dir] } });
  const target = path.join(dir, "doors.csv");
  if (process.platform === "win32") {
    const ok = await allowed.tool.run({ action: "export", result_set: "rs_aaaaaaaaaaaa", export: { path: target } });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.ok(fs.existsSync(target));
  }
  const big = setup({ reply: (c) => c.params.action === "rows" ? { ok: true, total: 100001, elements: [], done: false } : undefined });
  assert.equal((await big.tool.run({ action: "export", result_set: "rs_aaaaaaaaaaaa" })).code, "FMC-FILTER-EXPORT-TOO-LARGE");
});

test("export with criteria previews first, then streams that result set", async () => {
  const { tool, calls } = setup({ reply: rowsReply(2) });
  const r = await tool.run({ action: "export", criteria: { category: "OST_Doors" }, export: { format: "csv", params: ["Mark"] } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(calls.filter((c) => c.command === "fmc_select_by").map((c) => c.params.action), ["doc", "doc", "preview", "rows"]);
  assert.deepEqual(calls.find((c) => c.params.action === "rows")!.params.params, ["Mark"]);
});

test("the kit's filter.key_params and filter.scan_cap travel to the add-in", async () => {
  const { tool, calls } = setup({ kit: { "filter.key_params": { value: { Doors: ["Mark", "FMC_DoorCode"] } }, "filter.scan_cap": { value: 50000 } } });
  await tool.run({ action: "run", criteria: { category: "OST_Doors" } });
  const sent = calls.find((c) => c.params.action === "run")!;
  assert.deepEqual(sent.params.key_params, { Doors: ["Mark", "FMC_DoorCode"] });
  assert.equal(sent.params.scan_cap, 50000);
});

test("CSV columns: fixed fields, the union of params, capped at 500 with the overflow named", () => {
  const params: Record<string, number> = {};
  for (let i = 0; i < 600; i++) params[`P${i}`] = i;
  const { text, dropped } = toCsv([{ id: 1, name: "a", link: { instance_id: 5, name: "S : 1" }, params }]);
  const header = text.split("\r\n")[0].split(",");
  assert.equal(header.length, EXPORT_COLUMNS_MAX);
  assert.equal(dropped.length, 600 - (EXPORT_COLUMNS_MAX - 12));
  assert.ok(text.split("\r\n")[1].includes("S : 1"));
  assert.match(reasonsCsv([{ id: 1, reason: "PARAM_MISSING", param: "Fire Rating" }], []), /undetermined,1,,,,PARAM_MISSING,Fire Rating/);
});

test("policy: the query is a read, show is UI only, neither is a write; every command filter.ts sends is listed", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_select_by"));
  assert.ok(UI_COMMANDS.has("fmc_select_by_show"));
  assert.ok(!WRITE_COMMANDS.has("fmc_select_by") && !WRITE_COMMANDS.has("fmc_select_by_show"));
  const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "fmc", "filter.ts"), "utf8");
  const sent = [...src.matchAll(/send\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(sent.length >= 2);
  for (const c of sent) assert.ok(READ_VIA_SEND_COMMAND.has(c) || UI_COMMANDS.has(c), c);
  const manifest = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  const names = manifest.commands.map((c) => c.commandName);
  assert.ok(names.includes("fmc_select_by") && names.includes("fmc_select_by_show"));
});
