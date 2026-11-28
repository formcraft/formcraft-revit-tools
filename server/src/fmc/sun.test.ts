import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { angleGap, checkReadback, localToUtcMs, planSunStudy, presetDates, revitAzimuthToCompass, solarPosition } from "./sun.js";
import { FMC_SUN_SHAPE, runFmcSun, type FmcSunArgs } from "../tools/fmc_sun.js";

function args(partial: Record<string, unknown>): FmcSunArgs {
  return z.object(FMC_SUN_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> {
  return { ...(JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: result.isError === true };
}

const nairobi = { latitude_deg: -1.2921, longitude_deg: 36.8219, time_zone_h: 3 };

test("solar position: London midsummer noon, equator equinox noon, and night", () => {
  // London, 21 June 2026, 12:00 UTC (13:00 BST): altitude about 90 - 51.5 + 23.44, sun due south.
  const london = solarPosition(Date.UTC(2026, 5, 21, 12, 0), 51.5, -0.13);
  assert.ok(Math.abs(london.altitude_deg - 61.9) < 0.5, `altitude ${london.altitude_deg}`);
  assert.ok(angleGap(london.azimuth_deg, 180) < 3, `azimuth ${london.azimuth_deg}`);
  assert.ok(Math.abs(london.declination_deg - 23.44) < 0.1);
  // Equator, 20 March 2026, solar noon at longitude 0: nearly overhead.
  const equator = solarPosition(Date.UTC(2026, 2, 20, 12, 7), 0, 0);
  assert.ok(equator.altitude_deg > 89, `altitude ${equator.altitude_deg}`);
  // Nairobi at 03:00 local is night.
  const night = solarPosition(localToUtcMs("2026-06-21", "03:00", 3), nairobi.latitude_deg, nairobi.longitude_deg);
  assert.ok(night.altitude_deg < 0);
  // Morning sun is east, afternoon sun is west (northern mid latitude).
  const am = solarPosition(Date.UTC(2026, 5, 21, 7, 0), 51.5, 0);
  const pm = solarPosition(Date.UTC(2026, 5, 21, 17, 0), 51.5, 0);
  assert.ok(am.azimuth_deg > 45 && am.azimuth_deg < 135, `am ${am.azimuth_deg}`);
  assert.ok(pm.azimuth_deg > 225 && pm.azimuth_deg < 315, `pm ${pm.azimuth_deg}`);
});

test("local time goes to UTC by the site time zone, and bad dates and times are refused", () => {
  assert.equal(new Date(localToUtcMs("2026-06-21", "09:00", 3)).toISOString(), "2026-06-21T06:00:00.000Z");
  assert.equal(new Date(localToUtcMs("2026-06-21", "09:00", -5)).toISOString(), "2026-06-21T14:00:00.000Z");
  assert.throws(() => localToUtcMs("2026-02-30", "09:00", 0), /FMC-SUN-DATE/);
  assert.throws(() => localToUtcMs("2026-06-21", "25:00", 0), /FMC-SUN-TIME/);
  assert.deepEqual(presetDates("solstices_equinoxes", 2026), ["2026-03-20", "2026-06-21", "2026-09-22", "2026-12-21"]);
});

test("the plan names one view per date and time, skips existing names and night, and caps the count", () => {
  const plan = planSunStudy(nairobi, {
    kind: "stills", dates: ["2026-06-21"], preset: "solstices_equinoxes", times: ["03:00", "09:00", "12:00", "15:00"],
    start_time: "08:00", end_time: "17:00", interval_min: 60, name_prefix: "FMC_SUN",
  }, ["fmc_sun_2026-06-21_1200"]);
  assert.deepEqual(plan.studies.map((row) => row.name), ["FMC_SUN_2026-06-21_0900", "FMC_SUN_2026-06-21_1500"]);
  assert.deepEqual(plan.skipped.map((row) => row.code).sort(), ["FMC-SUN-BELOW-HORIZON", "FMC-SUN-EXISTS"]);
  assert.equal(plan.studies[0].utc, "2026-06-21T06:00:00.000Z");
  const day = planSunStudy(nairobi, {
    kind: "one_day", dates: [], preset: "solstices", year: 2026, times: [], start_time: "07:00", end_time: "18:00", interval_min: 30, name_prefix: "S",
  });
  assert.deepEqual(day.studies.map((row) => row.name), ["S_2026-06-21_DAY", "S_2026-12-21_DAY"]);
  assert.equal(day.studies[0].end_utc, "2026-06-21T15:00:00.000Z");
  assert.throws(() => planSunStudy(nairobi, { kind: "one_day", dates: ["2026-06-21"], preset: "", times: [], start_time: "07:00", end_time: "18:00", interval_min: 20, name_prefix: "S" }), /FMC-SUN-INTERVAL/);
  const many = Array.from({ length: 13 }, (_, i) => `${String(6 + i).padStart(2, "0")}:00`);
  assert.throws(() => planSunStudy(nairobi, { kind: "stills", dates: [], preset: "solstices_equinoxes", year: 2026, times: many, start_time: "", end_time: "", interval_min: 60, name_prefix: "S" }), /FMC-SUN-TOO-MANY/);
});

test("Revit's azimuth (counterclockwise from east, radians) reads back as compass degrees", () => {
  assert.equal(Math.round(revitAzimuthToCompass(0)), 90);
  assert.equal(Math.round(revitAzimuthToCompass(Math.PI / 2)), 0);
  assert.equal(Math.round(revitAzimuthToCompass(Math.PI)), 270);
  const plan = [{ name: "A", kind: "stills" as const, date: "2026-06-21", utc: "", altitude_deg: 40, azimuth_deg: 90 }];
  const good = checkReadback(plan, [{ name: "A", view_id: "1", altitude_rad: (40.3 * Math.PI) / 180, azimuth_rad: 0 }]);
  assert.equal(good[0].readback, "MATCH");
  const bad = checkReadback(plan, [{ name: "A", view_id: "1", altitude_rad: (40 * Math.PI) / 180, azimuth_rad: Math.PI }]);
  assert.equal(bad[0].code, "FMC-SUN-READBACK");
});

const readBody = {
  title: "A", path: "D:\\Jobs\\_Staging\\A.rvt", is_central: false,
  site: { latitude_deg: -1.2921, longitude_deg: 36.8219, time_zone_h: 3, place_name: "Nairobi" },
  views_3d: [{ id: "10", name: "{3D}", is_template: false }],
  view_names: ["{3D}", "Level 1"],
};

test("dry run does not apply; a write needs the lease and references and reads Revit's angles back", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-sun-"));
  const guard: GuardConfig = { ...DEFAULT_CONFIG };
  const env = { ...process.env, LOCALAPPDATA: dir, APPDATA: dir, FMC_SUN_DIR: path.join(dir, "out") } as NodeJS.ProcessEnv;
  let applied = 0;
  const read = async () => readBody;
  const base = { action: "study", document: "A", dates: ["2026-06-21"], times: ["12:00"] };
  const dry = textOf(await runFmcSun(args(base), { read, apply: async () => { applied += 1; return {}; }, env, guard }));
  assert.equal(dry.dry_run, true);
  assert.equal(dry.studies_count, 1);
  assert.equal(applied, 0);
  assert.ok(fs.existsSync(dry.report));
  const noLease = textOf(await runFmcSun(args({ ...base, dry_run: false }), { read, env, guard }));
  assert.equal(noLease.code, "FMC-BATCH-LOCKED");
  const noRefs = textOf(await runFmcSun(args({ ...base, dry_run: false, batch_lease: "L" }), { read, env, guard }));
  assert.equal(noRefs.code, "FMC-SUN-REFERENCES");
  const refs = { kit: ["FMC-BIM-MAN-001"], standards: ["FMC-BIM-STD-002"], rulebook: ["FMC_Rulebook_AIUse"] };
  const done = textOf(await runFmcSun(args({ ...base, dry_run: false, batch_lease: "L", references: refs }), {
    read,
    env, guard,
    apply: async (body) => {
      applied += 1;
      const studies = body.studies as Array<{ name: string; utc: string }>;
      assert.equal(studies[0].utc, "2026-06-21T09:00:00.000Z");
      const want = dry.studies[0];
      return { ok: true, views: [{ name: studies[0].name, view_id: "99", altitude_rad: (want.altitude_deg * Math.PI) / 180, azimuth_rad: ((90 - want.azimuth_deg) * Math.PI) / 180 }] };
    },
  }));
  assert.equal(applied, 1);
  assert.equal(done.views_made, 1);
  assert.equal(done.views[0].readback, "MATCH");
  assert.equal(done.readback_mismatches, 0);
});

test("refusals: no document, no site, a bad source view, and a guarded model", async () => {
  const guard: GuardConfig = { ...DEFAULT_CONFIG };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-sun-r-"));
  const env = { ...process.env, LOCALAPPDATA: dir, APPDATA: dir, FMC_SUN_DIR: dir } as NodeJS.ProcessEnv;
  assert.equal(textOf(await runFmcSun(args({ action: "read" }), { env, guard })).code, "FMC-DOC-REQUIRED");
  const noSite = async () => ({ ...readBody, site: { latitude_deg: 0, longitude_deg: 0, time_zone_h: 0 } });
  assert.equal(textOf(await runFmcSun(args({ action: "study", document: "A" }), { read: noSite, env, guard })).code, "FMC-SUN-SITE");
  const withArgs = textOf(await runFmcSun(args({ action: "study", document: "A", latitude_deg: 51.5, longitude_deg: 0, time_zone_h: 0, year: 2026 }), { read: noSite, env, guard }));
  assert.equal(withArgs.site.source, "args");
  assert.equal(textOf(await runFmcSun(args({ action: "study", document: "A", source_view: "Nope" }), { read: async () => readBody, env, guard })).code, "FMC-SUN-SOURCE-VIEW");
  const central = async () => ({ ...readBody, is_central: true });
  const refs = { kit: ["k"], standards: ["s"], rulebook: ["r"] };
  const blocked = textOf(await runFmcSun(args({ action: "study", document: "A", dry_run: false, batch_lease: "L", references: refs, year: 2026 }), { read: central, env, guard }));
  assert.equal(blocked.code, "FMC-SUN-GUARD");
  const read = textOf(await runFmcSun(args({ action: "read", document: "A" }), { read: async () => readBody, env, guard }));
  assert.equal(read.read_only, true);
  assert.equal(read.site_ok, true);
});

test("the sun read is not a write and the apply is, and both are in command.json", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_sun"));
  assert.ok(WRITE_COMMANDS.has("fmc_sun_apply"));
  const manifest = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  const names = new Set(manifest.commands.map((row) => row.commandName));
  assert.ok(names.has("fmc_sun") && names.has("fmc_sun_apply"));
});
