/**
 * F-072 (issue #248): the add-in answers "[FMC-BRIDGE-BUSY] Revit is still running <command> since <time> (job <id>)"
 * while an earlier command that outlived its wait still holds Revit's API thread (plugin/Core/BridgeBusy.cs). Before,
 * every later call queued behind it and timed out by mistake. Here: recognising that answer, waiting while the busy job's
 * heartbeats are fresh (up to the caller's ceiling), and the words for a finding when the wait gives up.
 */

export const BUSY_TAG = "[FMC-BRIDGE-BUSY]";

/** What a busy answer says: the command holding Revit, since when (Revit's local time, as written), its job id. */
export interface BridgeBusy { command: string; since: string; job: string }

const BUSY_RE = /\[FMC-BRIDGE-BUSY\] Revit is still running (\S+) since (.+?) \(job ([A-Za-z0-9_-]{1,64})\)/;

/** The busy answer in an error, a message or a reply body; null when it isn't one. */
export function parseBusy(x: unknown): BridgeBusy | null {
  const text = x instanceof Error ? x.message : typeof x === "string" ? x : (() => { try { return JSON.stringify(x) ?? ""; } catch { return ""; } })();
  const m = BUSY_RE.exec(text);
  return m ? { command: m[1], since: m[2], job: m[3] } : null;
}

/** For a finding or a log line: "Revit was busy with fmc_doc_flex since 2026-10-19 13:37:20 (job 1792…)". */
export function busyWords(b: BridgeBusy): string {
  return `Revit was busy with ${b.command} since ${b.since} (job ${b.job})`;
}

/** The wait gave up: the busy answer's words (so it is still recognised), how long it waited and why it stopped. */
export class BridgeBusyError extends Error {
  readonly code = "FMC-BRIDGE-BUSY";
  constructor(readonly busy: BridgeBusy, readonly waitedMs: number, readonly why: "ceiling" | "no heartbeat", readonly forCommand: string) {
    super(`${BUSY_TAG} Revit is still running ${busy.command} since ${busy.since} (job ${busy.job}), so ${forCommand} wasn't sent: ` +
      `waited ${Math.round(waitedMs / 1000)} s, then gave up (${why === "ceiling" ? "the call's time limit" : "Revit's heartbeats for that job stopped"}). ` +
      `fmc_job status ${busy.job} follows it; send ${forCommand} again once it has finished.`);
    this.name = "BridgeBusyError";
  }
}

export interface BusyWaitOptions {
  /** The caller's ceiling (ms) for waiting on a busy Revit. */
  ceilingMs: number;
  /** The command being sent, for the words. */
  command: string;
  /** How often to ask again (ms); FMC_BUSY_POLL_MS, default 5 s. */
  pollMs?: number;
  /** How old the busy job's last heartbeat may be (ms); default 3 min (Revit writes one a minute). */
  staleMs?: number;
  /** The busy job's last heartbeat (ms since epoch, 0 = none). */
  heartbeatMs: (job: string) => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onWait?: (busy: BridgeBusy, waitedMs: number) => void;
}

export function busyPollMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.FMC_BUSY_POLL_MS);
  return Number.isFinite(v) && v > 0 ? v : 5000;
}

/**
 * Sends, and while the add-in answers busy, waits and sends again: as long as the busy job's heartbeats are fresh
 * (counted from the first busy answer when it has none yet) and the ceiling isn't reached. Any other answer or error
 * goes back as it came. Giving up throws BridgeBusyError, whose message still carries the busy words.
 */
export async function retryWhileBusy<T>(send: () => Promise<T>, o: BusyWaitOptions): Promise<T> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const poll = Math.max(1, o.pollMs ?? busyPollMs());
  const stale = o.staleMs ?? 3 * 60 * 1000;
  let t0 = 0;
  for (;;) {
    try {
      return await send();
    } catch (e) {
      const b = parseBusy(e);
      if (!b || e instanceof BridgeBusyError) throw e;
      const t = now();
      if (!t0) t0 = t;
      const waited = t - t0;
      if (waited + poll > o.ceilingMs) throw new BridgeBusyError(b, waited, "ceiling", o.command);
      if (t - Math.max(o.heartbeatMs(b.job), t0) > stale) throw new BridgeBusyError(b, waited, "no heartbeat", o.command);
      o.onWait?.(b, waited);
      await sleep(poll);
    }
  }
}

/** One line of FMC_Jobs_Revit.jsonl, as far as the bridge's state needs it. */
export interface RevitJobLine { at?: string; job?: string; command?: string; pid?: number; event?: string; started?: string }

/**
 * The bridge's state from Revit's own job record: busy from a "bridge_busy" line until that job's "bridge_free" or
 * "finished" line, for one Revit (its pid). `heartbeat` is the job's last sign of life (ms), for a bounded wait.
 */
export function bridgeState(lines: RevitJobLine[], pid: number): (BridgeBusy & { heartbeat: number }) | null {
  let cur: (BridgeBusy & { heartbeat: number }) | null = null;
  for (const e of lines) {
    if (!e || e.pid !== pid || typeof e.job !== "string") continue;
    const at = Date.parse(String(e.at ?? ""));
    if (e.event === "bridge_busy") {
      const started = Date.parse(String(e.started ?? ""));
      cur = { command: String(e.command ?? ""), job: e.job, since: Number.isFinite(started) ? localTime(started) : String(e.started ?? ""), heartbeat: Number.isFinite(at) ? at : 0 };
    } else if (cur && e.job === cur.job) {
      if (e.event === "bridge_free" || e.event === "finished") cur = null;
      else if ((e.event === "heartbeat" || e.event === "running") && Number.isFinite(at)) cur.heartbeat = Math.max(cur.heartbeat, at);
    }
  }
  return cur;
}

export type BridgeRead = () => (BridgeBusy & { heartbeat: number }) | null;

/**
 * The test runner's wait for a busy bridge (F-072): until `read` says free, at most `maxMs`, and only while the busy
 * job's heartbeats are fresh and Revit is alive. `hint` is a busy answer the step just got, for when Revit's record
 * doesn't show the busy job (an older add-in): then one poll is waited and the bridge counts as free.
 */
export async function waitForBridgeFree(read: BridgeRead, o: {
  maxMs: number; pollMs?: number; staleMs?: number; hint?: BridgeBusy | null;
  now?: () => number; sleep?: (ms: number) => Promise<void>; alive?: () => boolean;
}): Promise<{ free: boolean; busy: BridgeBusy | null; waitedMs: number; why?: "limit" | "no heartbeat" | "revit gone" }> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const poll = Math.max(1, o.pollMs ?? 15000);
  const stale = o.staleMs ?? 3 * 60 * 1000;
  const t0 = now();
  let b = read();
  if (!b) {
    if (o.hint) await sleep(poll);
    return { free: true, busy: null, waitedMs: now() - t0 };
  }
  for (;;) {
    const t = now();
    const plain: BridgeBusy = { command: b.command, since: b.since, job: b.job };
    if (o.alive && !o.alive()) return { free: false, busy: plain, waitedMs: t - t0, why: "revit gone" };
    if (t - Math.max(b.heartbeat, t0) > stale) return { free: false, busy: plain, waitedMs: t - t0, why: "no heartbeat" };
    if (t - t0 >= o.maxMs) return { free: false, busy: plain, waitedMs: t - t0, why: "limit" };
    await sleep(Math.min(poll, Math.max(1, o.maxMs - (t - t0))));
    b = read();
    if (!b) return { free: true, busy: null, waitedMs: now() - t0 };
  }
}

/** "2026-10-19 13:37:20" in this PC's time, as the add-in writes it. */
export function localTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
