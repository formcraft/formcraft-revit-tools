import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";
import {
  BS8666_UNIT_MASS_KG_M, buildSchedule, coverChecks, markConflicts, massSummary, measuredCover, minClearSpacingMm,
  minRadiusMm, roundUp, scheduleCsv, shapeCodeOf, shapeLength, spacingChecks, unitMassKgPerM, type RebarFact,
} from "./rebar.js";
import { FMC_REBAR_SCHEDULE_SHAPE, citeValue, runFmcRebarSchedule, type FmcRebarScheduleArgs } from "../tools/fmc_rebar_schedule.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function args(partial: Record<string, unknown>): FmcRebarScheduleArgs {
  return z.object(FMC_REBAR_SCHEDULE_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, unknown> & { isError: boolean } {
  const body = JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>;
  return { ...body, isError: result.isError === true };
}

// A 300 x 600 beam from (0,0,0) to (6000,300,600), 40 mm cover all round.
const beamHost = { host_min: [0, 0, 0], host_max: [6000, 300, 600], host_cover_mm: { top: 40, bottom: 40, other: 40 } };
const bottomBars: RebarFact = {
  id: "101", mark: "01", bar_type: "H20", diameter_mm: 20, quantity: 3, bar_length_mm: 5920, shape: "00", dims: { A: 5920 },
  layout: "fixed_number", spacing_mm: 90, host_id: "9", host_category: "Structural Framing", host_mark: "B1", host_type: "RC 300x600",
  // centre lines 40 + 10 mm in from the faces
  centerline_min: [40, 50, 50], centerline_max: [5960, 250, 50], ...beamHost,
};
const links: RebarFact = {
  id: "102", mark: "02", bar_type: "H10", diameter_mm: 10, quantity: 30, bar_length_mm: 1500, shape: "M_51", dims: { A: 220, B: 520, C: 150 },
  layout: "maximum_spacing", spacing_mm: 200, host_id: "9", host_category: "Structural Framing", host_mark: "B1", host_type: "RC 300x600",
  centerline_min: [100, 25, 25], centerline_max: [5900, 275, 575], ...beamHost,
};

test("BS 8666 unit masses, radii and rounding", () => {
  assert.equal(BS8666_UNIT_MASS_KG_M[12], 0.888);
  assert.deepEqual(unitMassKgPerM(16), { value: 1.579, source: "BS8666 Table 1" });
  assert.equal(unitMassKgPerM(25).value, 3.854);
  const odd = unitMassKgPerM(14);
  assert.equal(odd.source, "formula");
  assert.equal(odd.value, 1.208);
  assert.equal(minRadiusMm(12), 24);
  assert.equal(minRadiusMm(20), 70);
  assert.equal(minRadiusMm(14), 28);
  assert.equal(roundUp(5901, 25), 5925);
  assert.equal(roundUp(5900, 25), 5900);
  assert.equal(roundUp(5900.4, 0), 5900);
});

test("shape codes are read from Revit shape names and lengths follow the table", () => {
  assert.equal(shapeCodeOf("00"), "00");
  assert.equal(shapeCodeOf("M_21"), "21");
  assert.equal(shapeCodeOf("BS8666 - 51"), "51");
  assert.equal(shapeCodeOf("Shape 11"), "11");
  assert.equal(shapeCodeOf("Custom"), "");
  assert.equal(shapeLength("00", { A: 3000 }, 12).length_mm, 3000);
  // 11: A + B - 0.5r - d, H12: r 24
  assert.equal(shapeLength("11", { A: 1000, B: 400 }, 12).length_mm, 1000 + 400 - 12 - 12);
  // 21: A + B + C - r - 2d, H16: r 32
  assert.equal(shapeLength("21", { A: 300, B: 1000, C: 300 }, 16).length_mm, 1600 - 32 - 32);
  // 51: 2(A + B + C) - 2.5r - 5d, H10: r 20
  assert.equal(shapeLength("51", { A: 220, B: 520, C: 150 }, 10).length_mm, 2 * 890 - 50 - 50);
  // 12 uses the specified R
  const twelve = shapeLength("12", { A: 1000, B: 500, R: 100 }, 12);
  assert.ok(Math.abs((twelve.length_mm ?? 0) - (1500 - 43 - 14.4)) < 1e-9);
  const missing = shapeLength("21", { A: 300 }, 16);
  assert.equal(missing.length_mm, null);
  assert.deepEqual(missing.missing, ["B", "C"]);
  assert.equal(shapeLength("99", { A: 1 }, 12).known, false);
});

test("the schedule has BS 8666 columns, merges like sets and sums mass", () => {
  const twin: RebarFact = { ...bottomBars, id: "103", quantity: 2 };
  const custom: RebarFact = { ...links, id: "104", mark: "03", shape: "Freeform", dims: {}, bar_length_mm: 2012, bar_type: "12 mm", diameter_mm: 12, quantity: 4 };
  const rows = buildSchedule([bottomBars, links, twin, custom]);
  assert.equal(rows.length, 3);
  const one = rows.find((r) => r.bar_mark === "01")!;
  assert.equal(one.member, "Structural Framing B1 (RC 300x600)");
  assert.equal(one.type_size, "H20");
  assert.equal(one.total_no, 5);
  assert.deepEqual(one.rebar_ids, ["101", "103"]);
  assert.equal(one.length_mm, 5925);
  assert.equal(one.length_source, "shape");
  assert.equal(one.mass_kg, Math.round(5 * 5925 * 2.466) / 1000);
  const two = rows.find((r) => r.bar_mark === "02")!;
  assert.equal(two.shape_code, "51");
  assert.equal(two.length_mm, 1700);
  assert.equal(two.length_delta_mm, 180);
  assert.ok(two.notes.some((n) => n.includes("differs")));
  const three = rows.find((r) => r.bar_mark === "03")!;
  assert.equal(three.shape_code, "99");
  assert.equal(three.length_source, "revit");
  assert.equal(three.length_mm, 2025);
  assert.equal(three.type_size, "H12");
  const summary = massSummary(rows);
  assert.deepEqual(summary.by_size.map((s) => s.type_size), ["H10", "H12", "H20"]);
  assert.equal(summary.total_kg, Math.round((one.mass_kg + two.mass_kg + three.mass_kg) * 1000) / 1000);
  const csv = scheduleCsv(rows).split("\r\n");
  assert.match(csv[0], /^Member,Bar mark,Type and size/);
  assert.equal(csv.length, 5);
  assert.equal(markConflicts(rows).length, 0);
  const clash = buildSchedule([bottomBars, { ...bottomBars, id: "105", host_id: "10", host_mark: "B2", diameter_mm: 16, bar_type: "H16" }]);
  const conflicts = markConflicts(clash);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].code, "MARK_CONFLICT");
});

test("cover: host settings against a minimum, and measured cover from centre lines", () => {
  assert.deepEqual(measuredCover(bottomBars), { top: 540, bottom: 40, sides: 30 });
  // the bottom bars sit 30 mm from the ends: that fails the 40 mm host setting
  const plain = coverChecks([bottomBars]);
  assert.equal(plain.checked, 1);
  assert.equal(plain.failures.length, 1);
  assert.equal(plain.failures[0].face, "sides");
  assert.equal(plain.failures[0].value_mm, 30);
  const tight = coverChecks([{ ...bottomBars, centerline_min: [50, 50, 50], centerline_max: [5950, 250, 50] }], { min_cover_mm: 50 });
  const codes = tight.failures.map((f) => `${f.code}:${f.face}`).sort();
  assert.deepEqual(codes, [
    "COVER_MEASURED_BELOW:bottom", "COVER_MEASURED_BELOW:sides",
    "COVER_SETTING_BELOW_MIN:bottom", "COVER_SETTING_BELOW_MIN:other", "COVER_SETTING_BELOW_MIN:top",
  ]);
  const ok = coverChecks([{ ...bottomBars, centerline_min: [50, 50, 50], centerline_max: [5950, 250, 50] }], { min_cover_mm: 35 });
  assert.equal(ok.failures.length, 0);
  const starter = measuredCover({ ...bottomBars, centerline_max: [5960, 250, 900] });
  assert.equal(starter!.top, null);
  const none = coverChecks([{ ...bottomBars, centerline_min: undefined }]);
  assert.deepEqual(none.unmeasured, ["101"]);
});

test("spacing: clear gap against max(bar, aggregate + 5, 20)", () => {
  assert.equal(minClearSpacingMm(12, 20), 25);
  assert.equal(minClearSpacingMm(32, 20), 32);
  assert.equal(minClearSpacingMm(10, 10), 20);
  assert.equal(spacingChecks([bottomBars, links], 20).failures.length, 0);
  const close: RebarFact = { ...bottomBars, id: "106", spacing_mm: 40 };
  const result = spacingChecks([close, { ...links, layout: "single", spacing_mm: 5 }, { ...links, quantity: 1, spacing_mm: 5 }], 20);
  assert.equal(result.checked, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].value_mm, 20);
  assert.equal(result.failures[0].required_mm, 25);
});

test("aggregate and cover values cite the call, the bank or a provisional default", () => {
  assert.deepEqual(citeValue(null, "rebar.max_aggregate_mm", undefined, 20), {
    key: "rebar.max_aggregate_mm", value: 20, source: "provisional", clause: "PROVISIONAL default 20 mm. Not in the standards bank. It cannot PASS.", can_pass: false,
  });
  const bank = { standards: { "rebar.max_aggregate_mm": { value: 14, status: "approved", clause: "FMC-BIM-STD-002 6.3" } } };
  assert.equal(citeValue(bank, "rebar.max_aggregate_mm", undefined, 20).value, 14);
  assert.equal(citeValue(bank, "rebar.max_aggregate_mm", undefined, 20).can_pass, true);
  assert.equal(citeValue(bank, "rebar.max_aggregate_mm", 10, 20).source, "call");
  assert.equal(citeValue({ "rebar.min_cover_mm": { value: 40, status: "provisional" } }, "rebar.min_cover_mm", undefined, null).can_pass, false);
  assert.equal(citeValue(null, "rebar.min_cover_mm", undefined, null).value, null);
});

test("the tool is read-only, names the document, writes JSON and CSV, and the add-in starts no transaction", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-rebar-"));
  const env = { ...process.env, APPDATA: dir, LOCALAPPDATA: dir, FMC_REBAR_DIR: path.join(dir, "rebar"), FMC_STANDARDS_FILE: path.join(dir, "missing.json") } as NodeJS.ProcessEnv;
  const missing = textOf(await runFmcRebarSchedule(args({}), { env, standards: null }));
  assert.equal(missing.code, "FMC-DOC-REQUIRED");
  assert.equal(missing.isError, true);

  const refused = textOf(await runFmcRebarSchedule(args({ document: "X" }), { env, standards: null, read: async () => ({ refused: true, code: "FMC-DOC-NOT-FOUND", message: "no" }) }));
  assert.equal(refused.isError, true);
  assert.equal(refused.code, "FMC-DOC-NOT-FOUND");

  const body = textOf(await runFmcRebarSchedule(args({ document: "F26901-FMC-ZZ-ZZ-M3-S-0001_USER", min_cover_mm: 40 }), {
    env,
    standards: null,
    read: async () => ({
      resolved_document: { title: "F26901-FMC-ZZ-ZZ-M3-S-0001_USER", path: "D:\\Jobs\\_Staging\\S.rvt" },
      notes: [],
      rebars: [bottomBars, links, { ...links, id: "107", spacing_mm: 30, mark: "04" }],
    }),
  }));
  assert.equal(body.isError, false);
  assert.equal(body.read_only, true);
  assert.equal(body.transaction, false);
  assert.equal(body.rebar_sets, 3);
  assert.equal(body.rows_count, 3);
  const checks = body.checks as Record<string, { status: string; failures: number }>;
  assert.equal(checks.cover.status, "FAIL");
  assert.equal(checks.spacing.status, "FAIL");
  assert.equal(checks.spacing.failures, 1);
  assert.equal(checks.marks.status, "PASS");
  const report = body.report as { json: string; csv: string };
  assert.ok(fs.existsSync(report.json));
  assert.match(fs.readFileSync(report.csv, "utf8"), /^Member,Bar mark/);

  const narrowed = textOf(await runFmcRebarSchedule(args({ document: "S", marks: ["02"], aggregate_mm: 10 }), {
    env, standards: null, read: async () => ({ rebars: [bottomBars, links] }),
  }));
  assert.equal(narrowed.rows_count, 1);
  assert.equal((narrowed.checks as Record<string, { status: string }>).spacing.status, "PASS");

  const source = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcRebarSchedule.cs"), "utf8");
  assert.equal(source.includes("new Transaction"), false);
  assert.equal(source.includes("TransactionGroup"), false);
  assert.equal(source.includes("SubTransaction"), false);
  assert.equal(source.includes("RollBack"), false);
  assert.equal(/\.Set\(/.test(source.replace(/_done\.Set\(\)/g, "")), false);
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_rebar_schedule"));
  assert.equal(WRITE_COMMANDS.has("fmc_rebar_schedule"), false);
  const commands = JSON.parse(fs.readFileSync(path.join(root, "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  assert.ok(commands.commands.some((c) => c.commandName === "fmc_rebar_schedule"));
});
