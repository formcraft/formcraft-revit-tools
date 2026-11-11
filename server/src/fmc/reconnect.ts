import { WRITE_COMMANDS } from "./policy.js";

/** Wait before the next try to reach a Revit that just restarted. Capped so a dead port does not stall the call. */
export function backoffMs(attempt: number): number {
  const step = Math.max(0, Math.floor(attempt));
  return Math.min(2000, 200 * 2 ** step);
}

export function isConnectionReset(error: unknown): boolean {
  const err = error as { message?: string; code?: string };
  const text = `${err?.code ?? ""} ${err?.message ?? error ?? ""}`;
  return /ECONNRESET|EPIPE|ECONNABORTED|connection was reset|half-closed/i.test(text);
}

/**
 * A read that died because the socket reset is tried once more, after the instance files are read again.
 * A write is never sent twice: the first attempt may already have changed the model.
 */
export function shouldRetryReset(command: string, error: unknown, attempt: number): boolean {
  return attempt === 0 && !WRITE_COMMANDS.has(command) && isConnectionReset(error);
}
