/**
 * Who may drain or resume the batch line, who may reserve a slot, and whether a bot name is the caller's own.
 *
 * Before: fmc_batch drain and resume had no check at all (any AI session could stop every lease grant, or lift a maintenance
 * stop a person had put on), and reserve trusted the `bot` field, which the caller writes, so naming "Hostel Building Bot"
 * made anyone the scheduler. Now the name that counts is the one the MCP client registered for its session (clientInfo.name at
 * initialize, caller.ts), never a field on the call:
 *  - drain and resume: a person (the pane, the CLI) or a client named in fmc_guard.json batch_admins; an AI session or an
 *    unlisted client is refused with FMC-BATCH-AUTH;
 *  - reserve: a client named in batch_schedulers, or a bot named in batch_schedulers whose bot_identities entry lists the
 *    caller's client; the bot field alone is not enough (FMC-BATCH-SCHEDULER);
 *  - a `bot` on request or reserve that names a registered bot (bot_identities), a scheduler or an admin must come from a
 *    client listed for it: a spoofed name is FMC-BATCH-IDENTITY. Any other bot value is just a label.
 * All three lists are in fmc_guard.json and are changed by a person, never by an AI session.
 */
import type { Caller } from "./caller.js";

export const BATCH_AUTH = "FMC-BATCH-AUTH";
export const BATCH_IDENTITY = "FMC-BATCH-IDENTITY";
export const BATCH_SCHEDULER = "FMC-BATCH-SCHEDULER";

export interface BotRegistry {
  batch_admins?: string[];
  batch_schedulers?: string[];
  /** Bot display name -> the MCP client names (clientInfo.name) that may act as it. */
  bot_identities?: Record<string, string[]>;
}

export interface Verdict { ok: boolean; code?: string; message?: string }

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
const names = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

/** The client name this session registered, or "" when it never said (unknown). */
export function registeredClient(caller: Pick<Caller, "client"> | null | undefined): string {
  const c = norm(caller?.client);
  return !c || c === "unknown" ? "" : c;
}

/** Started by a person: the pane, the CLI, or a person at a terminal. An AI, a job and a schedule are not. */
export function humanStart(startedBy: string): boolean {
  return ["pane", "cli", "person"].includes(norm(startedBy));
}

function identityList(reg: BotRegistry, bot: string): string[] | null {
  const map = reg.bot_identities && typeof reg.bot_identities === "object" ? reg.bot_identities : {};
  for (const [k, v] of Object.entries(map)) if (norm(k) === norm(bot)) return names(v);
  return null;
}

/** True when the bot name is one the caller proved: its client is in that bot's bot_identities entry. */
export function botProven(reg: BotRegistry, bot: string, caller: Pick<Caller, "client">): boolean {
  const list = identityList(reg, bot);
  const who = registeredClient(caller);
  return !!list && !!who && list.some((c) => norm(c) === who);
}

/** Names that are never self-declared: the schedulers and the admins, as well as any registered bot. */
function guardedName(reg: BotRegistry, bot: string): boolean {
  const n = norm(bot);
  return identityList(reg, bot) !== null || names(reg.batch_schedulers).some((x) => norm(x) === n) || names(reg.batch_admins).some((x) => norm(x) === n);
}

/** A bot name on a call: refused when it names a registered, scheduler or admin bot the caller's client is not listed for. */
export function identityVerdict(bot: string | undefined, caller: Pick<Caller, "client">, reg: BotRegistry): Verdict {
  const b = (bot ?? "").trim();
  if (!b || !guardedName(reg, b)) return { ok: true };
  if (botProven(reg, b, caller)) return { ok: true };
  const who = registeredClient(caller);
  return {
    ok: false, code: BATCH_IDENTITY,
    message: `[${BATCH_IDENTITY}] "${b}" is a registered bot name and this session is ${who ? `client "${who}"` : "an unnamed client"}, which is not listed for it (fmc_guard.json bot_identities). A bot name written on the call is not an identity. Use your own bot name, or ask a person to register this client.`,
  };
}

/** reserve: a scheduler by registered client name, or by a proven bot name; never by the bot field alone. */
export function schedulerVerdict(bot: string | undefined, caller: Pick<Caller, "client">, reg: BotRegistry): Verdict {
  const list = reg.batch_schedulers === undefined ? ["Hostel Building Bot"] : names(reg.batch_schedulers);
  const who = registeredClient(caller);
  if (who && list.some((x) => norm(x) === who)) return { ok: true };
  const b = (bot ?? "").trim();
  if (b && list.some((x) => norm(x) === norm(b)) && botProven(reg, b, caller)) return { ok: true };
  return {
    ok: false, code: BATCH_SCHEDULER,
    message: `[${BATCH_SCHEDULER}] reserve is only for a scheduler in batch_schedulers: this session's registered client name, or a bot name its client is listed for in bot_identities. The bot field alone is not enough.`,
  };
}

/** drain and resume: a person, or a client (or proven bot) in batch_admins. */
export function maintenanceVerdict(action: "drain" | "resume", bot: string | undefined, caller: Pick<Caller, "client">, startedBy: string, reg: BotRegistry): Verdict {
  if (humanStart(startedBy)) return { ok: true };
  const admins = names(reg.batch_admins);
  const who = registeredClient(caller);
  if (who && admins.some((x) => norm(x) === who)) return { ok: true };
  const b = (bot ?? "").trim();
  if (b && admins.some((x) => norm(x) === norm(b)) && botProven(reg, b, caller)) return { ok: true };
  return {
    ok: false, code: BATCH_AUTH,
    message: `[${BATCH_AUTH}] ${action} changes the line for every bot, so it is for a person (the pane or the CLI) or a client listed in fmc_guard.json batch_admins. This session is ${who ? `client "${who}"` : "an unnamed client"} started by ${norm(startedBy) || "ai"}.`,
  };
}
