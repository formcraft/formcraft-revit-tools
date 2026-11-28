import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_CONFIG, type GuardConfig } from "./policy.js";
import type { FamEditIo, Reply } from "./famedit_common.js";

/** Shared by the family editor tests (not a test itself): a scratch kit, a fake Revit that records calls, a JSON caller. */
export interface Kit { root: string; staging: string; log: string; config: { config: GuardConfig; problem: string } }
export function kit(): Kit {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-famedit-"));
  const staging = path.join(root, "04_Families", "_Staging");
  fs.mkdirSync(staging, { recursive: true });
  const config: GuardConfig = { ...DEFAULT_CONFIG, write_roots: [path.join(root, "wip")], library_roots: [], reports_dir: path.join(root, "reports"),
    family_staging_root: staging, family_template_dir: path.join(root, "templates") };
  return { root, staging, log: path.join(root, "reports", "FMC_MCP_FileLog.csv"), config: { config, problem: "" } };
}
export const done = (k: Kit) => fs.rmSync(k.root, { recursive: true, force: true });

export interface Call { command: string; payload: any; dry: boolean }
/** reads: command → answer; an apply answers with a rolled-back dry run or a committed real run. */
export function fakeRevit(reads: Record<string, unknown>, applyAnswer: (p: any) => object = () => ({ results: [{ ok: true }] })) {
  const calls: Call[] = [];
  const send = async (command: string, payload: any, dry: boolean) => {
    calls.push({ command, payload, dry });
    if (command in reads) return reads[command];
    if (command.endsWith("_apply")) return { run_id: payload.run_id, dry_run: payload.dry_run, failed: false, rolled_back: payload.dry_run, ...applyAnswer(payload) };
    throw new Error(`no answer for ${command}`);
  };
  return { calls, send, applies: () => calls.filter((c) => c.command.endsWith("_apply")) };
}

export async function callTool<S extends z.ZodRawShape>(shape: S, run: (a: any, io: FamEditIo) => Promise<Reply>, args: Record<string, unknown>, io: FamEditIo) {
  const r = await run(z.object(shape).parse(args), io);
  return { body: JSON.parse(r.content[0].text), isError: r.isError };
}
export const RUN_ID = /^FE-\d{8}T\d{6}-[0-9a-f]{6}$/;
