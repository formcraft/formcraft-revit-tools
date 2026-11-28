import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { atLeast, changeSeverity, docKey, modelChanges, modelSeverity, pickBaseline, readVersions, recordVersion, type VersionRow } from "./modelchanges.js";
import { FMC_CHANGES_SHAPE, modelSection } from "../tools/fmc_changes.js";

// Tool research 1-25 (fmc_changes, approved 28 Nov): a read-only Revit model read of what changed since a time, and
// severity levels on every flag and element.

const tmpEnv = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-changes-"));
  return { env: { ...process.env, FMC_CHANGES_DIR: dir, LOCALAPPDATA: dir }, dir };
};
const args = (over: Record<string, unknown> = {}) => z.object(FMC_CHANGES_SHAPE).parse({ model: true, families: false, ...over });
const DOC = "F26901-FMC-ZZ-ZZ-M3-E-0001_USER";

test("changes: severity puts deletions and datum, structure, shell, link and equipment changes first", () => {
  assert.equal(modelSeverity({ id: 1 }, "deleted").severity, "high");
  assert.equal(modelSeverity({ id: 2, bic: "OST_Levels", category: "Levels", category_type: "Model" }, "modified").severity, "high");
  assert.equal(modelSeverity({ id: 3, bic: "OST_Furniture", category: "Furniture", category_type: "Model" }, "created").severity, "medium");
  assert.equal(modelSeverity({ id: 4, bic: "OST_TextNotes", category_type: "Annotation" }, "created").severity, "low");
  assert.equal(modelSeverity({ id: 5, bic: "OST_Furniture", category_type: "Model", is_type: true }, "modified").severity, "low");
  const rows = modelChanges({ created: [{ id: 4, category_type: "Annotation" }], modified: [{ id: 2, bic: "OST_Grids", category_type: "Model" }], deleted: [{ id: 9 }] });
  assert.deepEqual(rows.map((r) => [r.id, r.change, r.severity]), [[9, "deleted", "high"], [2, "modified", "high"], [4, "created", "low"]]);
  assert.equal(atLeast("medium", "low"), true);
  assert.equal(atLeast("low", "medium"), false);
  assert.equal(changeSeverity({ kind: "part", what: "a", affects: [], why: "the part file is missing: x" }), "high");
  assert.equal(changeSeverity({ kind: "recipe", what: "a", affects: [], why: "b" }), "medium");
  assert.equal(changeSeverity({ kind: "tree", what: "a", affects: [], why: "b" }), "low");
});

test("changes: since picks the newest version recorded at or before it, for the same document by title or path", () => {
  const rows: VersionRow[] = [
    { at: "2026-11-28T06:00:00.000Z", document: DOC, guid: "g1", saves: 1 },
    { at: "2026-11-28T07:00:00.000Z", document: `C:\\WIP\\${DOC}.rvt`, guid: "g2", saves: 2 },
    { at: "2026-11-28T08:00:00.000Z", document: "Other", guid: "x", saves: 1 },
  ];
  assert.equal(docKey(`C:\\WIP\\${DOC}.rvt`), docKey(DOC));
  assert.equal(pickBaseline(rows, [DOC], Date.parse("2026-11-28T07:30:00Z")).row?.guid, "g2");
  assert.equal(pickBaseline(rows, [DOC], Date.parse("2026-11-28T06:30:00Z")).row?.guid, "g1");
  const none = pickBaseline(rows, [DOC], Date.parse("2026-11-28T05:00:00Z"));
  assert.equal(none.row, null);
  assert.equal(none.earliest, "2026-11-28T06:00:00.000Z");
});

test("changes: the version journal records a version once and skips a repeat", () => {
  const { env, dir } = tmpEnv();
  assert.equal(recordVersion({ at: "2026-11-28T06:00:00Z", document: DOC, guid: "g1", saves: 1 }, env), true);
  assert.equal(recordVersion({ at: "2026-11-28T06:05:00Z", document: DOC, guid: "g1", saves: 1 }, env), false);
  assert.equal(recordVersion({ at: "2026-11-28T06:10:00Z", document: DOC, guid: "g2", saves: 1 }, env), true);
  assert.equal(readVersions(env).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("changes: a model read with no earlier version records one and says so; the next read compares with it", async () => {
  const { env, dir } = tmpEnv();
  const calls: Array<Record<string, unknown>> = [];
  let guid = "11111111-1111-1111-1111-111111111111";
  const read = async (body: Record<string, unknown>) => {
    calls.push(body);
    const head = { model: DOC, resolved_document: { title: DOC, path: `C:\\WIP\\${DOC}.rvt` }, is_workshared: true, version: { guid, saves: 3 } };
    if (!body.base_version) return { ...head, compared: false };
    return { ...head, compared: true, deleted_available: true,
      created: [{ id: 10, bic: "OST_Furniture", category: "Furniture", category_type: "Model" }, { id: 11, bic: "OST_TextNotes", category_type: "Annotation" }],
      modified: [{ id: 20, bic: "OST_Walls", category: "Walls", category_type: "Model" }], deleted: [{ id: 30 }] };
  };
  const first = await modelSection(args(), { read, env, now: () => Date.parse("2026-11-28T06:00:00Z") });
  assert.equal(first.ok, true);
  assert.equal(first.compared, false);
  assert.match((first.notes as string[]).join(" "), /No model version .* was recorded before/);
  assert.equal(readVersions(env).length, 1);

  guid = "22222222-2222-2222-2222-222222222222";
  const second = await modelSection(args({ since: "2026-11-28T09:30:00+03:00", min_severity: "medium", limit: 2 }), { read, env, now: () => Date.parse("2026-11-28T07:00:00Z") });
  assert.equal(calls[calls.length - 1].base_version, "11111111-1111-1111-1111-111111111111");
  assert.equal(second.compared, true);
  const counts = second.counts as Record<string, number>;
  assert.deepEqual([counts.created, counts.modified, counts.deleted], [2, 1, 1]);
  assert.equal(counts.below_min_severity, 1, "the annotation row is counted, not dropped silently");
  assert.equal(counts.over_limit, 1);
  assert.deepEqual((second.changes as Array<{ id: number }>).map((r) => r.id), [30, 20]);
  assert.deepEqual(second.by_severity, { high: 2, medium: 1, low: 1 });
  assert.ok(typeof second.report === "string" && fs.existsSync(second.report as string));
  assert.equal(readVersions(env).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("changes: since before every recorded version and a bad since are said out loud; an unknown base is reported", async () => {
  const { env, dir } = tmpEnv();
  recordVersion({ at: "2026-11-28T06:00:00.000Z", document: DOC, guid: "g1", saves: 1 }, env);
  const read = async (body: Record<string, unknown>) => ({ model: DOC, resolved_document: { title: DOC }, version: { guid: "g2", saves: 1 },
    ...(body.base_version ? { compared: false, base_error: "Revit does not know base_version" } : { compared: false }) });
  const early = await modelSection(args({ since: "2026-11-27T00:00:00Z" }), { read, env });
  assert.match((early.notes as string[]).join(" "), /earliest recorded is 2026-11-28T06:00:00.000Z/);
  const bad = await modelSection(args({ since: "yesterday-ish" }), { read, env });
  assert.equal(bad.code, "FMC-CHANGES-SINCE");
  const unknown = await modelSection(args({ base_version: "33333333-3333-3333-3333-333333333333" }), { read, env });
  assert.equal(unknown.ok, false);
  assert.match((unknown.notes as string[]).join(" "), /does not know base_version/);
  fs.rmSync(dir, { recursive: true, force: true });
});
