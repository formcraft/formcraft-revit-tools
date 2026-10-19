/** The automation balance's files (F74): the ledger, the mapping file and the build tracker. Shared by fmc_balance and fmc_report. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ledgerDir, readLedger } from "./ledger.js";
import { Event, FeatureRow, toEvents } from "./balance.js";
import { Home, KISIC_HOMES, mergeHomes } from "./balance_homes.js";

const readJson = (file: string): unknown => { try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch { return null; } };

/** The mapping: the KISIC seed, with <ledger>\FMC_Balance_Homes.json laid over it. */
export function loadHomes(env: NodeJS.ProcessEnv = process.env): Home[] {
  return mergeHomes(KISIC_HOMES, readJson(path.join(ledgerDir(env), "FMC_Balance_Homes.json")));
}

/** docs/tracker/features.json: the argument, FMC_TRACKER_FILE, or the repo's copy beside this build. Empty when none. */
export function loadFeatures(file = "", env: NodeJS.ProcessEnv = process.env): { file: string; features: FeatureRow[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [file, env.FMC_TRACKER_FILE ?? "", path.resolve(here, "..", "..", "..", "docs", "tracker", "features.json")].filter(Boolean);
  for (const f of candidates) {
    const j = readJson(f);
    if (Array.isArray(j)) return { file: f, features: j.filter((x) => x && typeof x.id === "string").map((x) => ({ id: x.id, feature: String(x.feature ?? ""), status: String(x.status ?? "") })) };
  }
  return { file: "", features: [] };
}

/** The ledger's events (calls and external runs) in the months the period spans. */
export function ledgerEvents(from: string, to: string, env: NodeJS.ProcessEnv = process.env): Event[] {
  return toEvents(readLedger("calls", from, to, env), readLedger("external", from, to, env));
}
