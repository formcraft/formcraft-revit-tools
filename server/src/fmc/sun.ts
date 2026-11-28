/**
 * fmc_sun: sun position (NOAA solar position algorithm, no refraction) and the shadow study plan.
 * Angles in degrees. Azimuth is from true north, clockwise. Times: local wall time at the site's time zone (hours
 * east of UTC); the plan also carries the UTC instant, which is what the add-in hands Revit (StartDateAndTime accepts UTC).
 * Pure functions: no Revit and no file system except the report.
 */
import { roundTo, siteReportDir, writeSiteReport } from "./sitecommon.js";

export const SUN_FIX: Record<string, string> = {
  "FMC-DOC-REQUIRED": "fmc_sun needs document, a title or a full path. The active document is not a guess.",
  "FMC-BATCH-LOCKED": "A write needs batch_lease from fmc_batch request.",
  "FMC-SUN-REFERENCES": "A write needs references.kit, references.standards and references.rulebook.",
  "FMC-SUN-SITE": "The document has no usable site location (latitude, longitude and time zone). Set Manage > Location in Revit, or pass latitude_deg, longitude_deg and time_zone_h.",
  "FMC-SUN-DATE": "A date must be YYYY-MM-DD.",
  "FMC-SUN-TIME": "A time must be HH:MM, 00:00 to 23:59.",
  "FMC-SUN-BELOW-HORIZON": "The sun is below the horizon at that time. No view is made for it.",
  "FMC-SUN-EXISTS": "A view with that name already exists. It is not replaced.",
  "FMC-SUN-PLAN": "Nothing to make: every study was skipped.",
  "FMC-SUN-SOURCE-VIEW": "source_view is not a 3D view in the document.",
  "FMC-SUN-TOO-MANY": "More than 48 views in one study. Pass fewer dates or times.",
  "FMC-SUN-INTERVAL": "interval_min must be 15, 30, 45 or 60 for a one_day study.",
  "FMC-SUN-READBACK": "Revit's sun angle after the write differs from the computed angle by more than 1 degree. Check the site location and the time zone.",
};

export interface SunSite {
  latitude_deg: number;
  longitude_deg: number;
  /** Hours east of UTC, e.g. 3 for Nairobi. */
  time_zone_h: number;
  place_name?: string;
  source?: "revit" | "args";
}

export interface SunPosition {
  altitude_deg: number;
  azimuth_deg: number;
  declination_deg: number;
  equation_of_time_min: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Julian day of a UTC instant. */
export function julianDay(utcMs: number): number {
  return utcMs / 86400000 + 2440587.5;
}

/** NOAA solar position for a UTC instant. Geometric altitude (no refraction). */
export function solarPosition(utcMs: number, latitudeDeg: number, longitudeDeg: number): SunPosition {
  const jd = julianDay(utcMs);
  const t = (jd - 2451545) / 36525;
  const l0 = mod(280.46646 + t * (36000.76983 + t * 0.0003032), 360);
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c = Math.sin(rad(m)) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(rad(2 * m)) * (0.019993 - 0.000101 * t) + Math.sin(rad(3 * m)) * 0.000289;
  const trueLong = l0 + c;
  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const decl = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));
  const y = Math.tan(rad(eps / 2)) ** 2;
  const eot = 4 * deg(
    y * Math.sin(2 * rad(l0)) - 2 * e * Math.sin(rad(m)) + 4 * e * y * Math.sin(rad(m)) * Math.cos(2 * rad(l0))
    - 0.5 * y * y * Math.sin(4 * rad(l0)) - 1.25 * e * e * Math.sin(2 * rad(m)),
  );
  const d = new Date(utcMs);
  const utcMinutes = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const tst = mod(utcMinutes + eot + 4 * longitudeDeg, 1440);
  let ha = tst / 4 - 180;
  if (ha < -180) ha += 360;
  const lat = rad(latitudeDeg);
  const dr = rad(decl);
  const cosZ = Math.min(1, Math.max(-1, Math.sin(lat) * Math.sin(dr) + Math.cos(lat) * Math.cos(dr) * Math.cos(rad(ha))));
  const zenith = deg(Math.acos(cosZ));
  const az = mod(deg(Math.atan2(Math.sin(rad(ha)), Math.cos(rad(ha)) * Math.sin(lat) - Math.tan(dr) * Math.cos(lat))) + 180, 360);
  return { altitude_deg: 90 - zenith, azimuth_deg: az, declination_deg: decl, equation_of_time_min: eot };
}

export function parseDate(text: string): { y: number; m: number; d: number } | null {
  const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!hit) return null;
  const [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return { y, m, d };
}

export function parseTime(text: string): { h: number; mi: number } | null {
  const hit = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!hit) return null;
  const h = Number(hit[1]);
  const mi = Number(hit[2]);
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

/** UTC instant (ms) of a local wall time at a site time zone (hours east of UTC). */
export function localToUtcMs(date: string, time: string, timeZoneH: number): number {
  const d = parseDate(date);
  const t = parseTime(time);
  if (!d) throw new Error(`[FMC-SUN-DATE] ${date}: ${SUN_FIX["FMC-SUN-DATE"]}`);
  if (!t) throw new Error(`[FMC-SUN-TIME] ${time}: ${SUN_FIX["FMC-SUN-TIME"]}`);
  return Date.UTC(d.y, d.m - 1, d.d, t.h, t.mi) - timeZoneH * 3600000;
}

/** March and September equinoxes and the June and December solstices, as calendar dates (close enough for a study). */
export function presetDates(preset: string, year: number): string[] {
  const p = (m: number, d: number) => `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (preset === "solstices") return [p(6, 21), p(12, 21)];
  if (preset === "equinoxes") return [p(3, 20), p(9, 22)];
  return [p(3, 20), p(6, 21), p(9, 22), p(12, 21)];
}

export function hhmm(time: string): string {
  const t = parseTime(time);
  return t ? `${String(t.h).padStart(2, "0")}${String(t.mi).padStart(2, "0")}` : time.replace(/\D/g, "");
}

export interface SunStudyArgs {
  kind: "stills" | "one_day";
  dates: string[];
  preset: string;
  year?: number;
  times: string[];
  start_time: string;
  end_time: string;
  interval_min: number;
  name_prefix: string;
}

export interface SunStudyRow {
  name: string;
  kind: "stills" | "one_day";
  date: string;
  time?: string;
  start_time?: string;
  end_time?: string;
  interval_min?: number;
  utc: string;
  end_utc?: string;
  altitude_deg: number;
  azimuth_deg: number;
  code?: string;
  reason?: string;
}

export interface SunPlan {
  site: SunSite;
  studies: SunStudyRow[];
  skipped: SunStudyRow[];
  sample_times_note: string;
}

/** The views a study would make, with the computed sun angle for each. Existing view names are skipped, never replaced. */
export function planSunStudy(site: SunSite, args: SunStudyArgs, existingNames: string[] = [], now = new Date()): SunPlan {
  const year = args.year ?? now.getUTCFullYear();
  const dates = args.dates.length ? args.dates : presetDates(args.preset, year);
  for (const date of dates) if (!parseDate(date)) throw new Error(`[FMC-SUN-DATE] ${date}: ${SUN_FIX["FMC-SUN-DATE"]}`);
  const taken = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  const studies: SunStudyRow[] = [];
  const skipped: SunStudyRow[] = [];
  const prefix = args.name_prefix.trim() || "FMC_SUN";
  const push = (row: SunStudyRow) => {
    if (taken.has(row.name.toLowerCase())) skipped.push({ ...row, code: "FMC-SUN-EXISTS", reason: SUN_FIX["FMC-SUN-EXISTS"] });
    else if (row.altitude_deg <= 0) skipped.push({ ...row, code: "FMC-SUN-BELOW-HORIZON", reason: SUN_FIX["FMC-SUN-BELOW-HORIZON"] });
    else {
      taken.add(row.name.toLowerCase());
      studies.push(row);
    }
  };
  if (args.kind === "one_day") {
    if (![15, 30, 45, 60].includes(args.interval_min)) throw new Error(`[FMC-SUN-INTERVAL] ${SUN_FIX["FMC-SUN-INTERVAL"]}`);
    for (const date of dates) {
      const startMs = localToUtcMs(date, args.start_time, site.time_zone_h);
      const endMs = localToUtcMs(date, args.end_time, site.time_zone_h);
      if (endMs <= startMs) throw new Error(`[FMC-SUN-TIME] end_time must be after start_time.`);
      const mid = solarPosition((startMs + endMs) / 2, site.latitude_deg, site.longitude_deg);
      push({
        name: `${prefix}_${date}_DAY`,
        kind: "one_day",
        date,
        start_time: args.start_time,
        end_time: args.end_time,
        interval_min: args.interval_min,
        utc: new Date(startMs).toISOString(),
        end_utc: new Date(endMs).toISOString(),
        altitude_deg: roundTo(mid.altitude_deg, 3),
        azimuth_deg: roundTo(mid.azimuth_deg, 3),
      });
    }
  } else {
    const times = args.times.length ? args.times : ["09:00", "12:00", "15:00"];
    for (const time of times) if (!parseTime(time)) throw new Error(`[FMC-SUN-TIME] ${time}: ${SUN_FIX["FMC-SUN-TIME"]}`);
    if (dates.length * times.length > 48) throw new Error(`[FMC-SUN-TOO-MANY] ${SUN_FIX["FMC-SUN-TOO-MANY"]}`);
    for (const date of dates) {
      for (const time of times) {
        const utcMs = localToUtcMs(date, time, site.time_zone_h);
        const pos = solarPosition(utcMs, site.latitude_deg, site.longitude_deg);
        push({
          name: `${prefix}_${date}_${hhmm(time)}`,
          kind: "stills",
          date,
          time,
          utc: new Date(utcMs).toISOString(),
          altitude_deg: roundTo(pos.altitude_deg, 3),
          azimuth_deg: roundTo(pos.azimuth_deg, 3),
        });
      }
    }
  }
  if (dates.length > 48 || studies.length > 48) throw new Error(`[FMC-SUN-TOO-MANY] ${SUN_FIX["FMC-SUN-TOO-MANY"]}`);
  return {
    site,
    studies,
    skipped,
    sample_times_note: "Times are local wall time at the site time zone. Daylight saving is not applied. Azimuth is from true north, clockwise.",
  };
}

/** Revit's GetFrameAzimuth is radians counterclockwise from east. This turns it into degrees clockwise from north. */
export function revitAzimuthToCompass(ccwFromEastRad: number): number {
  return mod(90 - deg(ccwFromEastRad), 360);
}

/** Absolute angle difference, wrapping at 360. */
export function angleGap(a: number, b: number): number {
  const d = mod(a - b, 360);
  return Math.min(d, 360 - d);
}

export interface SunReadback { name: string; view_id?: string; altitude_rad?: number; azimuth_rad?: number; code?: string; reason?: string }

/** Compares Revit's sun angles after the write with the plan. Over 1 degree is FMC-SUN-READBACK. */
export function checkReadback(plan: SunStudyRow[], rows: SunReadback[], toleranceDeg = 1): Array<Record<string, unknown>> {
  const byName = new Map(plan.map((row) => [row.name.toLowerCase(), row]));
  return rows.map((row) => {
    const want = byName.get(String(row.name ?? "").toLowerCase());
    if (!want || row.code || typeof row.altitude_rad !== "number" || typeof row.azimuth_rad !== "number") return { ...row };
    const altitude = deg(row.altitude_rad);
    const azimuth = revitAzimuthToCompass(row.azimuth_rad);
    const dAlt = Math.abs(altitude - want.altitude_deg);
    const dAz = want.altitude_deg > 89 ? 0 : angleGap(azimuth, want.azimuth_deg);
    const ok = dAlt <= toleranceDeg && dAz <= toleranceDeg;
    return {
      name: row.name,
      view_id: row.view_id,
      revit_altitude_deg: roundTo(altitude, 3),
      revit_azimuth_deg: roundTo(azimuth, 3),
      computed_altitude_deg: want.altitude_deg,
      computed_azimuth_deg: want.azimuth_deg,
      readback: ok ? "MATCH" : "MISMATCH",
      ...(ok ? {} : { code: "FMC-SUN-READBACK", reason: SUN_FIX["FMC-SUN-READBACK"] }),
    };
  });
}

export function sunDir(env: NodeJS.ProcessEnv = process.env): string {
  return siteReportDir(env, "FMC_SUN_DIR", "sun");
}

export function writeSunReport(env: NodeJS.ProcessEnv, body: unknown, dir = sunDir(env)): string {
  return writeSiteReport(dir, "sun", body);
}
