import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FilterStore, FilterStoreError, HISTORY_MAX, filterDocKey, safeName, stamp } from "./filterstore.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fmc-filters-"));
}

const Q = { criteria: { all: [{ category: "OST_Walls" }, { level: "Level 2" }] }, scope: { links: "host" } };

test("doc key: the title's key plus a hash of the full path, so two models with one title don't share sets", () => {
  const a = filterDocKey("F26901-FMC-ZZ-ZZ-M3-A-0002", "D:\\P1\\01_WIP\\A\\F26901-FMC-ZZ-ZZ-M3-A-0002.rvt");
  const b = filterDocKey("F26901-FMC-ZZ-ZZ-M3-A-0002", "D:\\P2\\01_WIP\\A\\F26901-FMC-ZZ-ZZ-M3-A-0002.rvt");
  assert.notEqual(a, b);
  assert.match(a, /^f26901-fmc-zz-zz-m3-a-0002-[0-9a-f]{8}$/);
  assert.equal(a, filterDocKey("x", "d:/p1/01_wip/a/F26901-FMC-ZZ-ZZ-M3-A-0002.rvt"));
  assert.equal(safeName('Ext walls: L2 / "fire"'), "Ext walls_ L2 _ _fire_");
  assert.match(stamp(new Date("2026-11-28T06:40:00Z")), /^2026-11-28T\d\d:40:00[+-]\d\d:\d\d$/);
});

test("sets: names unique per document (case-insensitive), overwrite needed, written through temp + rename", () => {
  const root = tmp();
  const s = new FilterStore("doc-1", { root });
  const first = s.save({ name: "Ext walls L2", ...Q, total: 412 }, "Family Types & Placement Bot");
  assert.equal(first.shared, false);
  assert.match(first.share_note, /not in a project folder/);
  assert.throws(() => s.save({ name: "ext WALLS l2", ...Q }, "Family Types & Placement Bot"), (e: unknown) => e instanceof FilterStoreError && e.code === "FMC-FILTER-SET-EXISTS");
  const again = s.save({ name: "EXT walls L2", ...Q, note: "fire QA" }, "Family Types & Placement Bot", true);
  assert.equal(again.set.id, first.set.id);
  assert.equal(s.list("x").length, 1);
  assert.equal(s.find("ext walls l2", "x")?.note, "fire QA");
  assert.equal(s.find(first.set.id, "x")?.name, "EXT walls L2");
  assert.deepEqual(fs.readdirSync(s.dir).filter((f) => f.includes(".tmp")), []);
  const removed = s.remove("ext walls l2", "x");
  assert.equal(removed.removed, "EXT walls L2");
  assert.throws(() => s.remove("nope", "x"), (e: unknown) => e instanceof FilterStoreError && e.code === "FMC-FILTER-SET-NOT-FOUND");
});

test("a sets file that doesn't parse is moved aside and reported, never overwritten", () => {
  const root = tmp();
  const s = new FilterStore("doc-2", { root });
  fs.mkdirSync(s.dir, { recursive: true });
  fs.writeFileSync(s.setsFile, "{ not json", "utf8");
  assert.throws(() => s.list("x"), (e: unknown) => e instanceof FilterStoreError && e.code === "FMC-FILTER-STORE-CORRUPT");
  const aside = fs.readdirSync(s.dir).filter((f) => f.startsWith("sets.json.bad-"));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(s.dir, aside[0]), "utf8"), "{ not json");
  assert.equal(s.list("x").length, 0);   // the next call starts clean
});

test("history keeps the last 200 lines, counts and the query only", () => {
  const root = tmp();
  const s = new FilterStore("doc-3", { root });
  for (let i = 0; i < HISTORY_MAX + 5; i++) s.addHistory({ action: "preview", query_hash: `q_${i}`, total: i, by: "bot", ...Q });
  const lines = s.historyLines();
  assert.equal(lines.length, HISTORY_MAX);
  assert.equal(lines[0].query_hash, "q_5");
  assert.equal(s.latestFor({ query_hash: "q_204" })?.total, 204);
  assert.ok(s.historyById(lines[10].id));
  assert.deepEqual(Object.keys(lines[0]).sort(), ["action", "at", "by", "criteria", "id", "query_hash", "scope", "total"].sort());
});

test("decision 2: a saved set is shared through the project exchange, read-only for other bots", () => {
  const root = tmp();
  const exchange = path.join(tmp(), "01_WIP", "_Exchange");
  const a = new FilterStore("doc-4", { root, exchange, canShare: () => ({ ok: true, reasons: [] }) });
  const saved = a.save({ name: "Doors L2", ...Q }, "Bot A");
  assert.equal(saved.shared, true);
  const file = path.join(exchange, "filters", "doc-4", "Doors L2.json");
  assert.ok(fs.existsSync(file));
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o222, 0);   // read-only on disk
  // another bot on another machine: its own local store, the same exchange
  const b = new FilterStore("doc-4", { root: tmp(), exchange, canShare: () => ({ ok: true, reasons: [] }) });
  const seen = b.list("Bot B");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].shared, true);
  assert.equal(seen[0].read_only, true);
  assert.equal(b.find("doors l2", "Bot B")?.by, "Bot A");
  assert.throws(() => b.save({ name: "Doors L2", ...Q }, "Bot B", true), (e: unknown) => e instanceof FilterStoreError && e.code === "FMC-FILTER-SET-READONLY");
  assert.throws(() => b.remove("Doors L2", "Bot B"), (e: unknown) => e instanceof FilterStoreError && e.code === "FMC-FILTER-SET-READONLY");
  // its owner may replace it, and delete it: the shared file is archived, never deleted
  a.save({ name: "Doors L2", ...Q, note: "v2" }, "Bot A", true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).note, "v2");
  const r = a.remove("Doors L2", "Bot A");
  assert.equal(r.shared_removed, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(path.join(exchange, "filters", "doc-4", "_Archive")).length, 1);
});

test("a share the write rules refuse keeps the set on this machine, with the reasons", () => {
  const root = tmp();
  const s = new FilterStore("doc-5", { root, exchange: path.join(tmp(), "01_WIP", "_Exchange"), canShare: () => ({ ok: false, reasons: ["No write folders are configured"] }) });
  const saved = s.save({ name: "x", ...Q }, "bot");
  assert.equal(saved.shared, false);
  assert.match(saved.share_note, /No write folders/);
  assert.equal(s.list("bot").length, 1);
});

test("a set over 64 KB is refused", () => {
  const s = new FilterStore("doc-6", { root: tmp() });
  const big = { criteria: { ids: Array.from({ length: 20000 }, (_, i) => 100000 + i) } };
  assert.throws(() => s.save({ name: "big", ...big }, "bot"), (e: unknown) => e instanceof FilterStoreError && /64 KB/.test(e.message));
});
