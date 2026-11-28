import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASELINE_ARCHIVE_FAILED, BASELINE_CONFIRM, archivePath, realIo, saveBaseline, type BaselineIo } from "./baselinesave.js";
import { FMC_BUILD_SHAPE } from "../tools/fmc_build.js";
import { z } from "zod";

const file = "C:\\Projects\\F26001\\01_WIP\\_Build\\FMC_Quantities_Baseline_Ogala-S.json";
const now = new Date("2026-11-28T06:45:30.123Z");

function memory(initial: Record<string, string> = {}, failArchive = false) {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const io: BaselineIo = {
    exists: (f) => files.has(f),
    read: (f) => { const v = files.get(f); if (v === undefined) throw new Error("ENOENT"); return v; },
    write: (f, t) => { if (failArchive && f.includes("_Archive")) throw new Error("disk full"); writes.push(f); files.set(f, t); },
    mkdir: () => undefined,
  };
  return { io, files, writes };
}

test("fmc_build baseline is a dry run by default and confirm is off by default", () => {
  const shape = z.object(FMC_BUILD_SHAPE).parse({ action: "baseline", kit_folder: "K" });
  assert.equal(shape.dry_run, true);
  assert.equal(shape.confirm, false);
});

test("a dry run writes nothing, new baseline or existing", () => {
  const fresh = memory();
  const r1 = saveBaseline(file, "NEW", {}, fresh.io);
  assert.deepEqual([r1.ok, r1.dry_run, r1.written, r1.existed], [true, true, false, false]);
  assert.equal(fresh.writes.length, 0);
  assert.equal(fresh.files.size, 0);
  const have = memory({ [file]: "OLD" });
  const r2 = saveBaseline(file, "NEW", { dryRun: true, confirm: true, now }, have.io);
  assert.deepEqual([r2.ok, r2.written, r2.existed], [true, false, true]);
  assert.equal(r2.would_archive, archivePath(file, now), "it says where the old one would go");
  assert.equal(have.writes.length, 0);
  assert.equal(have.files.get(file), "OLD", "the existing baseline is untouched");
});

test("a first baseline is written with dry_run false, no confirm needed, no archive", () => {
  const m = memory();
  const r = saveBaseline(file, "NEW", { dryRun: false, now }, m.io);
  assert.deepEqual([r.ok, r.written, r.existed, r.archived], [true, true, false, undefined]);
  assert.equal(m.files.get(file), "NEW");
  assert.equal(m.files.size, 1);
});

test("an existing baseline is not overwritten without confirm: FMC-BUILD-BASELINE-CONFIRM, nothing changes, no archive", () => {
  const m = memory({ [file]: "OLD" });
  const r = saveBaseline(file, "NEW", { dryRun: false, confirm: false, now }, m.io);
  assert.equal(r.ok, false);
  assert.equal(r.code, BASELINE_CONFIRM);
  assert.equal(r.code, "FMC-BUILD-BASELINE-CONFIRM");
  assert.equal(r.written, false);
  assert.equal(m.files.get(file), "OLD");
  assert.equal(m.files.size, 1, "no archive was made either");
});

test("with confirm the old baseline is archived with a timestamp, then replaced", () => {
  const m = memory({ [file]: "OLD" });
  const r = saveBaseline(file, "NEW", { dryRun: false, confirm: true, now }, m.io);
  assert.deepEqual([r.ok, r.written, r.existed], [true, true, true]);
  const archived = archivePath(file, now);
  assert.equal(r.archived, archived);
  assert.equal(archived, "C:\\Projects\\F26001\\01_WIP\\_Build\\_Archive\\FMC_Quantities_Baseline_Ogala-S.20261128-064530-123.json");
  assert.equal(m.files.get(archived), "OLD", "the archive holds the old baseline");
  assert.equal(m.files.get(file), "NEW");
  assert.ok(m.writes.indexOf(archived) < m.writes.indexOf(file), "archived before overwritten");
  // a second replace a moment later archives the first replacement under another name
  const later = new Date(now.getTime() + 5);
  const r2 = saveBaseline(file, "NEWER", { dryRun: false, confirm: true, now: later }, m.io);
  assert.notEqual(r2.archived, archived);
  assert.equal(m.files.get(r2.archived!), "NEW");
  assert.equal(m.files.get(archived), "OLD", "the first archive is kept");
});

test("if the archive can't be written the old baseline is not overwritten", () => {
  const m = memory({ [file]: "OLD" }, true);
  const r = saveBaseline(file, "NEW", { dryRun: false, confirm: true, now }, m.io);
  assert.equal(r.ok, false);
  assert.equal(r.code, BASELINE_ARCHIVE_FAILED);
  assert.equal(r.written, false);
  assert.equal(m.files.get(file), "OLD");
});

test("the real file system does the same (a temp folder; Windows paths on Windows)", { skip: process.platform !== "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-baseline-"));
  const f = path.join(dir, "01_WIP", "_Build", "FMC_Quantities_Baseline_X.json");
  assert.equal(saveBaseline(f, "{}", {}, realIo).written, false);
  assert.equal(fs.existsSync(f), false);
  assert.equal(saveBaseline(f, "{\"v\":1}", { dryRun: false }, realIo).written, true);
  assert.equal(saveBaseline(f, "{\"v\":2}", { dryRun: false }, realIo).code, BASELINE_CONFIRM);
  const r = saveBaseline(f, "{\"v\":2}", { dryRun: false, confirm: true }, realIo);
  assert.equal(fs.readFileSync(f, "utf8"), "{\"v\":2}");
  assert.equal(fs.readFileSync(r.archived!, "utf8"), "{\"v\":1}");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fmc_build baseline goes through saveBaseline and no longer writes the file itself", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.resolve(here, "..", "..", "src", "tools", "fmc_build.ts"), "utf8");
  const block = src.slice(src.indexOf('if (args.action === "baseline")'), src.indexOf("model, elements"));
  assert.match(block, /saveBaseline\(file,/);
  assert.match(block, /dryRun: args\.dry_run, confirm: args\.confirm/);
  assert.doesNotMatch(block, /writeFileSync/);
});
