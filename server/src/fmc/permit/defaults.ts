/**
 * fmc_permit_check interim defaults (Phase A, 28 Nov 2026). Emlyn has not answered Q1, Q3 and Q10 yet, so each answer
 * the check depends on is one named value here. Change a value here (or set the environment variable named beside it)
 * and nothing else needs to move. No regulation number lives in this file: every threshold is read from the standards
 * bank at run time (bank.ts).
 */
import path from "node:path";

export type PermitState = "FAIL" | "PASS" | "REVIEW" | "NOT_CHECKED" | "NOT_APPLICABLE" | "ADVICE" | "INFO";

export interface PermitDefaults {
  /** Folder holding FMC_Standards_Building.json and FMC_Standards_Sources.json. Env FMC_PERMIT_STANDARDS_DIR. */
  standardsDir: string;
  buildingFile: string;
  sourcesFile: string;
  /** Q1: a bank value with status "proposed" may still produce FAIL (with a caveat). false turns those FAILs into REVIEW. Env FMC_PERMIT_PROPOSED_MAY_FAIL=0|1. */
  proposedMayFail: boolean;
  /** Q1: how a PASS reads. Never "complies". */
  passWording: string;
  /** Q3: stairs stay this state until dwelling vs other residential is decided. Env FMC_PERMIT_STAIRS_STATE. */
  stairsState: PermitState;
  /** Q10: exactly at the 30 m2 or 12 m boundary is REVIEW (the Act and the Regulations word the boundary differently). Env FMC_PERMIT_BOUNDARY_REVIEW=0|1. */
  boundaryReview: boolean;
  /** How close counts as "exactly" at a boundary. Measurement tolerances, not regulation values. */
  boundaryToleranceM2: number;
  boundaryToleranceMm: number;
  /** Where runs and reports are written. Env FMC_PERMIT_DIR, else %LOCALAPPDATA%\Formcraft\permit. */
  reportDir: string;
}

export const DEFAULT_STANDARDS_DIR = "C:\\Users\\USER\\agent-tools\\standards\\kit";

function flag(raw: string | undefined, fallback: boolean): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return fallback;
}

const STATES: PermitState[] = ["FAIL", "PASS", "REVIEW", "NOT_CHECKED", "NOT_APPLICABLE", "ADVICE", "INFO"];

export function permitReportDir(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.FMC_PERMIT_DIR ?? "").trim()) return env.FMC_PERMIT_DIR!.trim();
  const local = env.LOCALAPPDATA || path.join(path.sep, "tmp", "FormcraftLocal");
  return path.join(local, "Formcraft", "permit");
}

export function permitDefaults(env: NodeJS.ProcessEnv = process.env, standardsDir?: string): PermitDefaults {
  const stairs = (env.FMC_PERMIT_STAIRS_STATE ?? "").trim().toUpperCase() as PermitState;
  return {
    standardsDir: (standardsDir ?? "").trim() || (env.FMC_PERMIT_STANDARDS_DIR ?? "").trim() || DEFAULT_STANDARDS_DIR,
    buildingFile: "FMC_Standards_Building.json",
    sourcesFile: "FMC_Standards_Sources.json",
    proposedMayFail: flag(env.FMC_PERMIT_PROPOSED_MAY_FAIL, true),
    passWording: "no exception found on model data",
    stairsState: STATES.includes(stairs) ? stairs : "REVIEW",
    boundaryReview: flag(env.FMC_PERMIT_BOUNDARY_REVIEW, true),
    boundaryToleranceM2: 0.05,
    boundaryToleranceMm: 10,
    reportDir: permitReportDir(env),
  };
}

/** The defaults in force, as the run and the report print them. */
export function describeDefaults(d: PermitDefaults): string[] {
  return [
    `Q1: a bank value with status "proposed" ${d.proposedMayFail ? "may produce FAIL, with a caveat" : "never produces FAIL (REVIEW instead)"}; PASS reads "${d.passWording}".`,
    "Q2: no demo model; built and tested on unit fixtures only.",
    `Q3: stairs are ${d.stairsState} until dwelling vs other residential thresholds are decided.`,
    `Q10: exactly at the floor-area or height boundary is ${d.boundaryReview ? "REVIEW" : "classified normally"} (tolerance ${d.boundaryToleranceM2} m2, ${d.boundaryToleranceMm} mm).`,
    `Standards bank folder: ${d.standardsDir}`,
  ];
}
