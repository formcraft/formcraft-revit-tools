/**
 * The batch line on disk. Leases live in memory while the process runs. A restart reads this file back,
 * so a queued ticket is not dropped. An active lease is stored at the head of its line as waiting:
 * the session that held it is gone with the process, and the bot asks for the same label again.
 */
import fs from "node:fs";
import path from "node:path";
import { formcraftDir } from "./aiuse_io.js";

export const MAINTENANCE_REASON = "maintenance: server update";

export interface StoredTicket {
  id: string;
  document: string;
  label: string;
  batchId: string;
  bot: string;
  client: string;
  references: Record<string, string[]>;
  correction: string;
  attempt: number;
  requestedAt: number;
  estOps?: number;
}

export function maintenancePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(formcraftDir(env), "batch.maintenance");
}

export function batchLinePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(formcraftDir(env), "FMC_BatchLine.json");
}

/** The reason in batch.maintenance, or null when the file is absent. An empty file still means maintenance. */
export function readMaintenance(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const text = fs.readFileSync(maintenancePath(env), "utf8").trim();
    return text || MAINTENANCE_REASON;
  } catch {
    return null;
  }
}

export function writeMaintenance(reason: string | null, env: NodeJS.ProcessEnv = process.env): void {
  const file = maintenancePath(env);
  if (!reason) {
    try { fs.unlinkSync(file); } catch { /* already clear */ }
    return;
  }
  fs.mkdirSync(path.win32.dirname(file), { recursive: true });
  fs.writeFileSync(file, reason, "utf8");
}

export function saveBatchLine(tickets: StoredTicket[], env: NodeJS.ProcessEnv = process.env): void {
  const file = batchLinePath(env);
  fs.mkdirSync(path.win32.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ saved_at: new Date().toISOString(), tickets }));
  fs.renameSync(tmp, file);
}

export function loadBatchLine(env: NodeJS.ProcessEnv = process.env): StoredTicket[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(batchLinePath(env), "utf8")) as { tickets?: unknown };
    if (!Array.isArray(parsed.tickets)) return [];
    return parsed.tickets.filter(isTicket);
  } catch {
    return [];
  }
}

function isTicket(value: unknown): value is StoredTicket {
  if (!value || typeof value !== "object") return false;
  const row = value as StoredTicket;
  return typeof row.id === "string" && typeof row.document === "string" && typeof row.label === "string"
    && typeof row.client === "string" && typeof row.batchId === "string" && typeof row.bot === "string"
    && row.references != null && typeof row.references === "object" && typeof row.attempt === "number";
}
