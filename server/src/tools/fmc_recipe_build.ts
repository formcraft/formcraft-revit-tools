import fs from "node:fs";
import { Recipe } from "../fmc/recipes.js";
import {
  BRIDGE_LIMIT_BYTES, BuildRecord, CHUNK_BYTES, ChunkRecord, applyEnvelope, isNoAnswer, isSessionGone, isStillQueued, opsHash,
  planChunks, progressPath, readBuilds, readProgress, rememberTemplatePlanes, renumberOpError, requestBytes, stoppedAt, writeBuild,
} from "../fmc/recipebuild.js";

/**
 * fmc_recipe build, the run itself (F-029, F-040). One build is a record (FMC_Recipe_Builds.json) and a background
 * session. Whole mode sends every op in one fmc_doc apply (one TransactionGroup; the dry run is rolled back) and is
 * refused when the call is bigger than the Revit bridge reads. Stepwise mode sends the ops in chunks the bridge can
 * take, one TransactionGroup per chunk, into the unsaved template (a dry run never saves, so the template is the
 * thing rolled back), and each call does as many chunks as fit before the client's cut-off; resume carries on from
 * the last good op. Any failure closes the template without saving and lists the background documents builds left open.
 */

export interface BuildOptions {
  recipeFile: string; template: string; target: string; dry: boolean; overwrite: boolean;
  stepwise: boolean; chunkSize: number; resume: boolean;
  reportsDir: string; sharedParameterFile: string;
  notes: string[]; sources: Record<string, string[]>;
  /** The ops Revit gets (load_family paths resolved on this PC); the recipe's own ops when left out. */
  ops?: unknown[];
  /** Flex's size check: each size parameter at its lowest and highest type value (Gate A: solids follow Width/Height). */
  follow?: unknown[];
}

/** What a build needs from the rest of the server: fmc_doc (as parsed JSON with ok), Gate A, the clock and the time budget. */
export interface BuildDeps {
  doc: (args: Record<string, unknown>) => Promise<any>;
  gate: (file: string, flex: object) => Promise<{ verdict: string; lines: unknown[] }>;
  now?: () => number;
  /** How long one call may keep starting chunks (ms); Infinity for the pane's CLI, which has no client cut-off. */
  budgetMs?: number;
  appData?: string;
  /** How long a chunk may stay without an answer before it counts as hung (the apply's hard timeout). */
  hardMs?: number;
}

export interface BuildReply { body: Record<string, unknown>; isError: boolean }

const inFlight = new Map<string, string>();

function errorText(r: any): string {
  return String(r?.error ?? (Array.isArray(r?.reasons) ? r.reasons.join("; ") : "") ?? "") || "no answer";
}

const ok = (r: any) => r && r.ok !== false && !r.refused && !r.error;

export async function buildRecipe(recipe: Recipe, o: BuildOptions, d: BuildDeps): Promise<BuildReply> {
  const fam = recipe.family;
  if (inFlight.has(fam)) return { body: { refused: true, reasons: [`A call for ${fam} is still working (${inFlight.get(fam)}): wait for it, then resume`] }, isError: true };
  inFlight.set(fam, "starting");
  try { return await run(recipe, o, d); } finally { inFlight.delete(fam); }
}

async function run(recipe: Recipe, o: BuildOptions, d: BuildDeps): Promise<BuildReply> {
  const now = d.now ?? Date.now;
  const t0 = now();
  const budget = d.budgetMs ?? Infinity;
  const hardMs = d.hardMs ?? 300000;
  const ops = (o.ops ?? recipe.ops) as unknown[];
  const n = ops.length;
  const fam = recipe.family;
  const envelope = requestBytes("fmc_doc_apply", applyEnvelope("00000000", o.sharedParameterFile));
  const whole = envelope + Buffer.byteLength(JSON.stringify(ops), "utf8");
  const plan = planChunks(ops, o.chunkSize, CHUNK_BYTES, envelope);
  const refuse = (reasons: string[], extra: object = {}): BuildReply => ({ body: { refused: true, reasons, ...extra }, isError: true });

  if (plan.tooBig.length)
    return refuse(plan.tooBig.map((t) => `op ${t.op} is ${t.bytes} bytes on its own, more than one call to Revit can carry (${BRIDGE_LIMIT_BYTES}): split its points into smaller ops`));
  if (!o.stepwise && whole > BRIDGE_LIMIT_BYTES)
    return refuse([`The ${n} ops are ${Math.round(whole / 1024)} KB in one call; the Revit bridge reads ${BRIDGE_LIMIT_BYTES} bytes per call, so Revit would never see the batch (F-029)`],
      { stepwise_plan: { chunks: plan.chunks.length, chunk_size: o.chunkSize }, next: "Run with stepwise: true: the same dry run first, then dry_run: false" });

  // ---- the record: new, or the one being resumed
  let rec: BuildRecord;
  const notes = [...o.notes];
  if (o.resume) {
    const prev = readBuilds(o.reportsDir)[fam];
    if (!prev) return refuse([`No build of ${fam} to resume: start one without resume`]);
    if (prev.state === "built" || prev.state === "dry run done") return refuse([`The last build of ${fam} finished (${prev.state}): start a new one without resume`]);
    if (prev.dry_run !== o.dry) return refuse([`The build being resumed is ${prev.dry_run ? "a dry run" : "a real build"}: resume it with dry_run: ${prev.dry_run}`]);
    if (prev.stepwise !== o.stepwise) return refuse([`The build being resumed is ${prev.stepwise ? "stepwise" : "whole"}: resume it with stepwise: ${prev.stepwise}`]);
    if (prev.last_good_op > n || opsHash(ops.slice(0, prev.last_good_op)) !== prev.good_hash)
      return refuse([`Ops 1-${prev.last_good_op} of ${fam} changed since that build: start again without resume`]);
    rec = { ...prev, chunk_size: o.chunkSize, recipe_file: o.recipeFile };
  } else {
    rec = {
      id: `${fam}-${new Date(now()).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`, family: fam, recipe_file: o.recipeFile, template: o.template,
      dry_run: o.dry, stepwise: o.stepwise, chunk_size: o.chunkSize, ops_total: n, ops_hash: opsHash(ops), session: "", sessions: [],
      started: new Date(now()).toISOString(), updated: "", state: "running", last_good_op: 0, good_hash: opsHash([]), chunks: [],
    };
  }
  rec.ops_total = n;
  rec.ops_hash = opsHash(ops);
  const save = () => writeBuild(o.reportsDir, rec);
  const warnings: string[] = [];
  const progressReply = (state: string, extra: object = {}): BuildReply => {
    save();
    return { body: {
      building: fam, build: rec.id, dry_run: rec.dry_run, stepwise: rec.stepwise, state, ops_done: `${rec.last_good_op} of ${n}`,
      chunks: rec.chunks.slice(-5), warnings: warnings.slice(0, 20), notes: notes.slice(0, 20), ...extra,
      next: `Call fmc_recipe build again with the same recipe_file, dry_run: ${rec.dry_run}, stepwise: ${rec.stepwise} and resume: true to carry on from op ${rec.last_good_op + 1}`,
    }, isError: false };
  };

  // ---- F-040: close without saving, list what builds left open
  const fail = async (where: { op: number | null; text: string }, revitAnswering = true): Promise<BuildReply> => {
    rec.state = "failed";
    rec.failed_op = where;
    let closed: any = { closed: false, reason: "no session" };
    if (rec.session) {
      closed = await d.doc({ action: "close", session: rec.session });
      if (closed?.closed === true || /already closed|No such session/.test(String(closed?.reason ?? ""))) rec.session = "";
      else revitAnswering = revitAnswering && !isStillQueued(errorText(closed)) && !isNoAnswer(errorText(closed));
    }
    let background: any = null;
    if (revitAnswering) {
      const bg = await d.doc({ action: "background" });
      if (ok(bg)) background = bg;
    }
    save();
    const builds = readBuilds(o.reportsDir);
    const opened = new Map<string, string>();
    for (const b of Object.values(builds)) for (const s of b.sessions ?? []) opened.set(s, b.family);
    const leftOpen = (background?.sessions ?? []).filter((s: any) => opened.has(s.session)).map((s: any) => ({ ...s, build: opened.get(s.session) }));
    return { body: {
      failed: true, family: fam, build: rec.id, dry_run: rec.dry_run, failed_at: where, ops_done: `${rec.last_good_op} of ${n}`,
      chunks: rec.chunks.slice(-5), warnings: warnings.slice(0, 20),
      template_closed: !rec.session, close: rec.session ? (closed?.reason ?? closed?.error ?? "the close didn't answer") : "closed without saving",
      left_open: background ? leftOpen : "not listed: Revit isn't answering",
      other_background: background?.other_background ?? [],
      next: [
        where.op ? `Fix op ${where.op} in the recipe` : "Check Revit (a dialog may be waiting)",
        rec.stepwise && rec.last_good_op ? `then resume: true to rebuild ops 1-${rec.last_good_op} and carry on from op ${rec.last_good_op + 1}` : "then build again",
        (background && leftOpen.length) || rec.session ? "fmc_recipe cleanup lists the background documents builds left open; with dry_run: false it closes them without saving" : "",
      ].filter(Boolean),
    }, isError: true };
  };

  const openTemplate = async (): Promise<string | null> => {
    const open = await d.doc({ action: "open", template: o.template });
    if (!open?.session) return errorText(open) || "The template didn't open";
    rec.session = String(open.session);
    rec.sessions = [...new Set([...(rec.sessions ?? []), rec.session])];
    rememberTemplatePlanes(o.reportsDir, o.template, open.document?.reference_planes);
    save();
    return null;
  };

  // ---- a chunk the last call left with Revit
  const last = rec.chunks[rec.chunks.length - 1];
  if (o.resume && last && (last.state === "running in Revit" || last.state === "sent")) {
    const p = readProgress(progressPath(rec.session, d.appData));
    const fresh = p && (!p.started || !last.sent_at || Date.parse(p.started) >= Date.parse(last.sent_at) - 5000) ? p : null;
    if (fresh?.state === "finished") {
      Object.assign(last, { state: "done", created: fresh.result?.created, updated: fresh.result?.updated, skipped: fresh.result?.skipped, warnings: fresh.result?.warnings });
      rec.last_good_op = last.to;
      rec.good_hash = opsHash(ops.slice(0, last.to));
      rec.state = "running";
      save();
    } else if (fresh?.state === "failed") {
      last.state = "failed";
      last.error = fresh.error;
      return fail(stoppedAt(fresh, last.from - 1, last.sent_at));
    } else {
      const where = stoppedAt(fresh, last.from - 1, last.sent_at);
      if (last.sent_at && now() - Date.parse(last.sent_at) > hardMs) { last.state = "no answer"; return fail(where, false); }
      return progressReply("running in Revit", { at: where.text });
    }
  }

  // ---- the session: open the template, or check the resumed one is still there
  if (rec.session && o.resume) {
    const rep = await d.doc({ action: "report", session: rec.session });
    if (!ok(rep) && isSessionGone(errorText(rep))) {
      notes.push("The session of the build being resumed had closed (idle for 30 minutes, or Revit restarted)");
      rec.session = "";
    }
  }
  if (!rec.session) {
    // A new template holds none of the earlier ops: rebuild them first (each op answers create, update or skip).
    if (rec.last_good_op > 0) {
      notes.push(`The template is opened again, so ops 1-${rec.last_good_op} are rebuilt before op ${rec.last_good_op + 1}`);
      rec.last_good_op = 0;
      rec.good_hash = opsHash([]);
    }
    const why = await openTemplate();
    if (why) { rec.state = "failed"; save(); return refuse([why]); }
  }

  // ---- the ops
  let lastMs = 0;
  while (rec.last_good_op < n) {
    const from = rec.last_good_op + 1;
    let to = n;
    if (rec.stepwise) {
      const next = planChunks(ops.slice(rec.last_good_op), rec.chunk_size, CHUNK_BYTES, envelope).chunks[0];
      to = rec.last_good_op + next.to;
      if (budget !== Infinity && now() - t0 + Math.max(lastMs * 1.5, 8000) > budget) return progressReply("paused");
    }
    const cr: ChunkRecord = { from, to, state: "sent", sent_at: new Date(now()).toISOString() };
    if (rec.chunks.some((c) => c.state === "done" && c.from <= from && c.to >= to)) cr.replay = true;
    rec.chunks.push(cr);
    save();
    const started = now();
    inFlight.set(fam, `ops ${from}-${to}`);
    const r = await d.doc({ action: "apply", session: rec.session, ops: ops.slice(from - 1, to), dry_run: rec.stepwise ? false : rec.dry_run });
    lastMs = now() - started;
    cr.ms = lastMs;
    if (ok(r)) {
      Object.assign(cr, { state: "done", created: r.created ?? 0, updated: r.updated ?? 0, skipped: r.skipped ?? 0, warnings: (r.warnings ?? []).length });
      warnings.push(...(r.warnings ?? []).map(String));
      rec.last_good_op = to;
      rec.good_hash = opsHash(ops.slice(0, to));
      save();
      continue;
    }
    const msg = errorText(r);
    if (isStillQueued(msg)) {
      cr.state = "running in Revit";
      rec.state = "waiting";
      return progressReply("running in Revit", { at: stoppedAt(readProgress(progressPath(rec.session, d.appData)), from - 1, cr.sent_at).text });
    }
    if (isNoAnswer(msg)) {
      cr.state = "no answer";
      cr.error = msg;
      return fail(stoppedAt(readProgress(progressPath(rec.session, d.appData)), from - 1, cr.sent_at), false);
    }
    cr.state = "failed";
    cr.error = msg;
    return fail(renumberOpError(msg, from - 1));
  }

  // ---- every op is in: a dry run closes without saving; a build flexes, saves, closes and runs Gate A
  const totals = rec.chunks.filter((c) => c.state === "done" && !c.replay)
    .reduce((t, c) => ({ created: t.created + (c.created ?? 0), updated: t.updated + (c.updated ?? 0), skipped: t.skipped + (c.skipped ?? 0) }), { created: 0, updated: 0, skipped: 0 });
  if (rec.dry_run) {
    const closed = await d.doc({ action: "close", session: rec.session });
    if (closed?.closed === true) rec.session = "";
    rec.state = "dry run done";
    save();
    return { body: {
      dry_run: true, family: fam, build: rec.id, would_save: o.target, ...totals, chunks: rec.stepwise ? rec.chunks.length : undefined,
      warnings: warnings.slice(0, 30), notes, sources: o.sources, template_closed: !rec.session,
      next: `Run again with dry_run=false${rec.stepwise ? " and stepwise: true" : ""} to build, flex, save to staging and run Gate A`,
    }, isError: false };
  }
  if (budget !== Infinity && now() - t0 > budget - 20000) return progressReply("ops applied", { next_step: "flex, save and Gate A" });
  const flex = await d.doc({ action: "flex", session: rec.session, ...(o.follow?.length ? { follow: o.follow } : {}) });
  const saved = await d.doc({ action: "save", session: rec.session, path: o.target, overwrite: o.overwrite });
  if (!ok(saved)) return fail({ op: null, text: `save failed: ${errorText(saved)}` });
  fs.writeFileSync(o.target.replace(/\.rfa$/i, ".recipe.json"), JSON.stringify(recipe, null, 2));
  const closed = await d.doc({ action: "close", session: rec.session });
  if (closed?.closed === true) rec.session = "";
  const gate = await d.gate(o.target, flex);
  rec.state = "built";
  rec.result = { built: o.target, verdict: gate.verdict };
  save();
  return { body: {
    built: o.target, build: rec.id, ...totals, warnings: warnings.slice(0, 30), flex: { ok: flex?.ok }, gate,
    next: gate.verdict === "Pass" ? "A reviewer releases it in the pane" : "Fix what fails and build again",
  }, isError: false };
}

/**
 * F-040: the background family documents builds opened and that are still open, and the other background family
 * documents in Revit. dry_run lists; dry_run false closes the ones this server's sessions opened, without saving.
 * A document the person opened (or that shows in a Revit window) is never closed (F-023: the add-in refuses too).
 */
export async function cleanupBackground(dry: boolean, reportsDir: string, doc: BuildDeps["doc"]): Promise<BuildReply> {
  const bg = await doc({ action: "background" });
  if (!ok(bg)) return { body: { refused: true, reasons: [errorText(bg)] }, isError: true };
  const opened = new Map<string, string>();
  for (const b of Object.values(readBuilds(reportsDir))) for (const s of b.sessions ?? []) opened.set(s, b.family);
  const sessions = (bg.sessions ?? []).map((s: any) => ({ ...s, build: opened.get(s.session) ?? "" }));
  const closable = sessions.filter((s: any) => s.closable);
  const stays = sessions.filter((s: any) => !s.closable);
  if (dry) return { body: {
    dry_run: true, would_close: closable, stays_open: stays, other_background: bg.other_background ?? [],
    next: closable.length ? "Run again with dry_run=false to close these without saving" : "Nothing for a tool to close",
  }, isError: false };
  const closed = [];
  for (const s of closable) closed.push({ session: s.session, title: s.title, ...(await doc({ action: "close", session: s.session })) });
  return { body: { closed, stays_open: stays, other_background: bg.other_background ?? [] }, isError: false };
}
