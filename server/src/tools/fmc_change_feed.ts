import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { expandEnv, loadConfig } from "../fmc/policy.js";
import { projectOf, readLedger } from "../fmc/ledger.js";
import { readCreated } from "../fmc/createdlog.js";
import { loadSyncState } from "../fmc/docschedule.js";
import { runFmcChanges } from "./fmc_changes.js";
import {
  DEFAULT_SOURCES, FEED_SOURCES, FeedEntry, FeedSource, SourceStatus, createdEntries, externalEntries, feedCounts, filterFeed, flowEntries,
  changeFeedDir, ledgerEntries, pageFeed, persistedEntries, readPersistedLog, revitEntries, sortFeed, syncLogEntries, syncStateEntries, syncSummary,
} from "../fmc/changefeed.js";

const win = path.win32;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_CHANGE_FEED_DESCRIPTION =
  "Formcraft change record and sync feed (F19). Read-only: no dry run is needed because nothing is ever changed. One timeline, " +
  "newest first, of what changed, who changed it and when: the hub call ledger (every Formcraft tool call, its result and who " +
  "started it: ai, pane, job, schedule, cli), hook runs, batches' created elements, the sync log and the managed save/sync clocks, " +
  "and, when document names an open model, Revit's own record from fmc_change_feed_read (the session journal of transactions, " +
  "undos, saves and syncs, with the Revit user; with since_version, the elements created, modified and deleted since that " +
  "document version, with creator and last changed by). flows adds fmc_changes' out-of-date flags. The sync section reports the " +
  "last sync, last save and whether the model changed since; it never syncs, saves, reloads latest, relinquishes or checks out: " +
  "a person syncs in Revit. Every source asked for is listed in sources with what was read or why not. Page with cursor; pass " +
  "next.since_version and next.after_seq back to read only what is new. " +
  "Example: {\"document\":\"F26901-FMC-ZZ-ZZ-M3-A-0002_USER\",\"since\":\"2026-11-28T00:00:00Z\"}.";

export const FMC_CHANGE_FEED_SHAPE = {
  document: z.string().optional().default("").describe("Title or full path of an open model for Revit's record. Empty: files only (no Revit call)."),
  project_code: z.string().optional().default("").describe("Keep ledger lines of this project only"),
  project_folder: z.string().optional().default("").describe("The project (its sync log in 01_WIP, and flows)"),
  since: z.string().optional().default("").describe("ISO time: entries at or after it"),
  until: z.string().optional().default("").describe("ISO time: entries at or before it"),
  sources: z.array(z.enum(FEED_SOURCES)).optional().default([...DEFAULT_SOURCES]).describe("ledger, external, created, syncs, revit, flows"),
  since_version: z.string().optional().default("").describe("revit: a version GUID from an earlier reply (next.since_version): elements changed since it"),
  after_seq: z.number().int().min(0).optional().default(0).describe("revit: journal entries after this sequence number (next.after_seq)"),
  element_limit: z.number().int().min(1).max(1000).optional().default(200).describe("revit: changed elements listed at most (all are counted)"),
  limit: z.number().int().min(1).max(500).optional().default(100).describe("Entries in this page"),
  cursor: z.string().optional().default("").describe("next_cursor from the previous page"),
};
export type FmcChangeFeedArgs = z.infer<z.ZodObject<typeof FMC_CHANGE_FEED_SHAPE>>;

export interface ChangeFeedIo {
  /** fmc_change_feed_read in the add-in (tests pass a fake). */
  revit?: (body: Record<string, unknown>) => Promise<unknown>;
  /** fmc_changes flags (tests pass a fake). */
  flows?: (projectFolder: string) => Promise<unknown[]>;
  env?: NodeJS.ProcessEnv;
  reportsDir?: string;
  now?: () => Date;
}

async function defaultFlows(projectFolder: string): Promise<unknown[]> {
  const r = await runFmcChanges({ project_folder: projectFolder, recipe_files: [], families: true });
  const body = JSON.parse(r.content[0].text) as { flags?: unknown[]; error?: string };
  if (body.error) throw new Error(body.error);
  return body.flags ?? [];
}

const readText = (f: string): string | null => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };

export async function runFmcChangeFeed(args: FmcChangeFeedArgs, io: ChangeFeedIo = {}) {
  const env = io.env ?? process.env;
  const now = (io.now ?? (() => new Date()))();
  const wanted = new Set<FeedSource>(args.sources.length ? args.sources : DEFAULT_SOURCES);
  const statuses: SourceStatus[] = [];
  const notes: string[] = [];
  const all: FeedEntry[] = [];
  const document = args.document.trim();
  const project = (args.project_code.trim() || projectOf({ project_folder: args.project_folder })).toUpperCase();
  const from = args.since ? args.since : "";
  const to = args.until ? args.until : now.toISOString();
  let next: Record<string, unknown> = {};
  let revitFacts: Record<string, unknown> | null = null;

  const take = (source: FeedSource, run: () => { entries: FeedEntry[]; note?: string }) => {
    if (!wanted.has(source)) return;
    try {
      const r = run();
      all.push(...r.entries);
      statuses.push({ source, read: true, count: r.entries.length, note: r.note ?? "" });
    } catch (e) {
      statuses.push({ source, read: false, count: 0, note: e instanceof Error ? e.message : String(e) });
    }
  };

  let reportsDir = io.reportsDir ?? "";
  if (!reportsDir) { try { reportsDir = expandEnv(loadConfig().config.reports_dir); } catch { reportsDir = ""; } }

  take("ledger", () => ({ entries: ledgerEntries(readLedger("calls", from, to, env)), note: "Tool calls: who started them (ai, pane, job, schedule, cli), never a person's name" }));
  take("external", () => ({ entries: externalEntries(readLedger("external", from, to, env)) }));
  take("created", () => ({ entries: createdEntries(readCreated(env)) }));
  take("syncs", () => {
    const entries: FeedEntry[] = [];
    const folder = expandEnv(args.project_folder.trim());
    const files = [folder ? win.join(folder, "01_WIP", "FMC_Sync_Log.csv") : "", reportsDir ? win.join(reportsDir, "FMC_Sync_Log.csv") : ""].filter(Boolean);
    const read: string[] = [];
    for (const f of files) { const t = readText(f); if (t != null) { entries.push(...syncLogEntries(t, f)); read.push(f); } }
    entries.push(...syncStateEntries(loadSyncState(env)));
    return { entries, note: read.length ? `Sync log: ${read.join("; ")}` : "No sync log found; managed save/sync clocks only" };
  });

  const persisted = wanted.has("revit") ? persistedEntries(readPersistedLog(changeFeedDir(env), document)) : [];
  if (wanted.has("revit")) {
    if (!document) {
      if (persisted.length) {
        all.push(...persisted);
        statuses.push({ source: "revit", read: true, count: persisted.length, note: `Lasting change log under ${changeFeedDir(env)} (append-only JSONL, outside the model). Times include their time zone.` });
      } else {
        statuses.push({ source: "revit", read: false, count: 0, note: "Pass document (an open model's title or path) for Revit's version diff. The lasting log is still read when it has entries. Not guessed from the active document." });
      }
    } else {
      try {
        const body: Record<string, unknown> = { document, after_seq: args.after_seq, limit: 1000, element_limit: args.element_limit };
        if (args.since_version.trim()) body.since_version = args.since_version.trim();
        const raw = (io.revit
          ? await io.revit(body)
          : await withRevitConnection((client) => client.sendCommand("fmc_change_feed_read", body, 60000))) as Record<string, unknown>;
        revitFacts = raw ?? {};
        // When the lasting JSONL is already in hand, drop the add-in journal lines so they are not listed twice;
        // keep the version diff. If the log is empty (tests, or the server cannot see the file), keep the journal.
        const journalForEntries = persisted.length
          ? { ...(revitFacts.journal as object || {}), entries: [] }
          : (revitFacts.journal ?? {});
        const entries = [...persisted, ...revitEntries({ ...revitFacts, journal: journalForEntries }, now)];
        all.push(...entries);
        const journal = (revitFacts.journal ?? {}) as Record<string, unknown>;
        const diff = revitFacts.diff as Record<string, unknown> | null | undefined;
        const bits: string[] = [];
        if (persisted.length) bits.push(`Lasting change log under ${changeFeedDir(env)} (append-only JSONL, outside the model). Times include their time zone.`);
        if (journal.listening === false) bits.push("Revit's journal isn't listening in this session");
        else if (journal.since) bits.push(`Session journal since ${journal.since}`);
        if (journal.more) bits.push("more journal entries: call again with next.after_seq");
        if (journal.gap) bits.push(`${journal.dropped} older journal entries were dropped by the cap before they were read`);
        if (diff && diff.code) bits.push(`${diff.code}: ${diff.message}`);
        for (const n of (Array.isArray(revitFacts.notes) ? revitFacts.notes : []) as unknown[]) notes.push(String(n));
        statuses.push({ source: "revit", read: true, count: entries.length, note: bits.join("; ") });
        const version = (revitFacts.version ?? {}) as Record<string, unknown>;
        next = { since_version: version.guid ?? "", after_seq: journal.next_after_seq ?? args.after_seq };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        statuses.push({ source: "revit", read: false, count: 0, note: `Revit not read: ${msg}` });
      }
    }
  }

  if (wanted.has("flows")) {
    try {
      const flags = await (io.flows ?? defaultFlows)(expandEnv(args.project_folder.trim()));
      const entries = flowEntries(flags, now);
      all.push(...entries);
      statuses.push({ source: "flows", read: true, count: entries.length, note: "fmc_changes flags, a snapshot of now; each update is a dry run another tool runs after a yes" });
    } catch (e) {
      statuses.push({ source: "flows", read: false, count: 0, note: e instanceof Error ? e.message : String(e) });
    }
  }

  const kept = sortFeed(filterFeed(all, { since: args.since, until: args.until, project, document }));
  const page = pageFeed(kept, args.limit, args.cursor);
  const sync = syncSummary(kept, document);
  return reply({
    tool: "fmc_change_feed",
    read_only: true,
    transaction: false,
    applied: false,
    saved: false,
    synced: false,
    worksharing: "never touched: no sync, save, reload latest, relinquish or checkout. A person syncs in Revit.",
    as_of: now.toISOString(),
    document,
    project,
    model: revitFacts ? {
      resolved_document: revitFacts.resolved_document ?? null, workshared: revitFacts.workshared ?? null, version: revitFacts.version ?? null,
      diff_counts: (revitFacts.diff as Record<string, unknown> | null)?.counts ?? null,
    } : null,
    sync,
    total: kept.length,
    counts: feedCounts(kept),
    entries: page.entries,
    next_cursor: page.next_cursor,
    next,
    sources: statuses,
    notes,
  });
}

export function registerFmcChangeFeedTool(server: McpServer) {
  server.tool("fmc_change_feed", FMC_CHANGE_FEED_DESCRIPTION, FMC_CHANGE_FEED_SHAPE, (args) => runFmcChangeFeed(args));
}
