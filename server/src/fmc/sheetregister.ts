/**
 * Which sheet register fmc_sheets (compare, create, rename) and fmc_issue (check, report, export) read.
 *
 * The project's register is given with `register`. Without it, the kit's FMC_Sheet_Register.csv (03_Master_Data, beside the
 * family specs) is the default: both tools used to refuse with "Sheet register not found: " and an empty path. When no
 * register can be read the refusal names the path that was looked for, with a code.
 */
import fs from "node:fs";
import path from "node:path";
import { GuardConfig, expandEnv } from "./policy.js";

const win = path.win32;

export const SHEET_REGISTER_NOT_FOUND = "FMC-SHEET-REGISTER-NOT-FOUND";
export const KIT_REGISTER_NAME = "FMC_Sheet_Register.csv";

export interface ResolvedRegister { file: string; source: "argument" | "kit default"; exists: boolean }

/** The kit's register: 03_Master_Data\FMC_Sheet_Register.csv, the folder of specs_path in fmc_guard.json. */
export function kitRegisterPath(cfg: Pick<GuardConfig, "specs_path">): string {
  return win.join(win.dirname(expandEnv(cfg.specs_path)), KIT_REGISTER_NAME);
}

export function resolveRegister(given: string | undefined, cfg: Pick<GuardConfig, "specs_path">, exists: (file: string) => boolean = fs.existsSync): ResolvedRegister {
  const asked = (given ?? "").trim();
  if (asked) return { file: asked, source: "argument", exists: exists(asked) };
  const file = kitRegisterPath(cfg);
  return { file, source: "kit default", exists: exists(file) };
}

/** The isError body when the register can't be read: the path, where it came from, and what to do. */
export function registerMissingBody(r: ResolvedRegister) {
  const how = r.source === "argument"
    ? "The register you passed doesn't exist."
    : "No register was passed, so the kit's default was used and it isn't there.";
  return {
    refused: true,
    code: SHEET_REGISTER_NOT_FOUND,
    register: r.file,
    register_source: r.source,
    reasons: [`[${SHEET_REGISTER_NOT_FOUND}] Sheet register not found: ${r.file}. ${how} Pass register (the project's FMC_Sheet_Register .xlsx or .csv), or put the kit's at that path.`],
  };
}
