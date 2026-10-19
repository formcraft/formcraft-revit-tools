import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClashRow, NavisState, groupClashes, navisCall, processAlive, readState, stateFile } from "../fmc/navis.js";
import { GuardConfig, archivePlan, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { ClashMatrix, coverage, idOfTest, matrixProblems, planTests } from "../fmc/clashmatrix.js";
import { FoundModel, defaultFederatedFile, federatedPathProblems, federationPlan, findDisciplineModels, parseContainer } from "../fmc/federate.js";
import { NOT_A_PERSON, NavisClashRow, cloudPlan, newestTest, resolveClashItems, statusHash } from "../fmc/clashback.js";
import { exchangeRoot, loadIdentity, saveIdentity, writePackage } from "../hub/exchange.js";
import { FMC_REVIEW_SHAPE, clashesIntoRegister, loadRegister, runFmcReview, saveRegister } from "./fmc_review.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

const win = path.win32;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

function log(cfg: GuardConfig, action: string, dry: boolean, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = win.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dry, target, result, detail]));
  } catch {
    // logging must never block the work
  }
}

export const FMC_NAVIS_DESCRIPTION =
  "Formcraft and Navisworks Manage (track N; hub step H3). Talks to the Formcraft bridge inside a running Navisworks. " +
    "status: whether Navisworks and the bridge are up. info: the open file and its models. tests: every clash test with its " +
    "results by status. results: one test's clashes (filter by status, limit), each item with its Revit Element ID, category " +
    "and source model, plus the clashes grouped by model and category pair. federate (project_folder): finds the project's " +
    "discipline models by container name (02_Shared and/or 01_WIP, NWC before NWD before RVT; or files), appends the ones " +
    "not in the open document and saves the federation as an .nwf in 01_WIP\\_Navisworks (an older one is archived, never " +
    "overwritten). matrix: reads and checks the clash matrix (fmc-clash-matrix/0.1, the kit's 08_Navisworks, or matrix: a " +
    "file) and what the open federation can test. clash_create: the matrix's tests as clash tests named \"FMC <id> …\" " +
    "(made or updated; a person's test is never touched; remove_stale removes only FMC tests the matrix dropped). " +
    "clash_run: runs the matrix's FMC tests. back (project_folder): the newest results (or test) traced to their Revit " +
    "elements through the identity map, handed over as Mark & Review tickets (handover tickets) or review clouds in the " +
    "open Revit model (handover clouds, after tickets). clash_status: a status (Active, Reviewed, Approved, Resolved) and a " +
    "comment on the clash results a person names; the dry run gives a plan_hash, the real run needs approved_by (that " +
    "person, never the AI) and the same plan_hash. Every write is a dry run unless dry_run is false.";

export const FMC_NAVIS_SHAPE = {
  action: z.enum(["status", "info", "tests", "results", "federate", "matrix", "clash_create", "clash_run", "back", "clash_status"]),
  test: z.string().optional().default("").describe("results, clash_status: the clash test's name; back: the test (default: the one run most recently)"),
  status: z.string().optional().default("").describe("results: only this status (New, Active, Reviewed, Approved, Resolved)"),
  limit: z.number().int().min(1).max(2000).optional().default(200).describe("results: at most this many clashes"),
  project_folder: z.string().optional().default("").describe("federate, back: the project folder (with 01_WIP)"),
  project_code: z.string().optional().default("").describe("back: the project code for a new review register"),
  files: z.array(z.string()).optional().default([]).describe("federate: these NWC, NWD or RVT files instead of finding them"),
  source: z.enum(["both", "shared", "wip"]).optional().default("both").describe("federate: where to find the discipline models (02_Shared wins over 01_WIP)"),
  roles: z.array(z.string()).optional().default([]).describe("federate: only these role codes (Manual 4.3)"),
  output: z.string().optional().default("").describe("federate: the .nwf (default <project>\\01_WIP\\_Navisworks\\<Project>-<Originator>-ZZ-ZZ-M3-Z-0001.nwf)"),
  matrix: z.string().optional().default("").describe("matrix, clash_create, clash_run: a clash matrix file instead of the kit's (clash_matrix_file)"),
  tests: z.array(z.string()).optional().default([]).describe("clash_create, clash_run: only these matrix test ids"),
  remove_stale: z.boolean().optional().default(false).describe("clash_create: also remove FMC tests the matrix no longer has (never a person's test)"),
  handover: z.enum(["tickets", "clouds"]).optional().default("tickets").describe("back: Mark & Review tickets, or review clouds in the open Revit model"),
  model: z.string().optional().default("").describe("back with clouds: the Revit model open now (default: asked from Revit)"),
  names: z.array(z.string()).optional().default([]).describe("clash_status: the clash results by name (e.g. Clash12), as the person named them"),
  set_status: z.enum(["Active", "Reviewed", "Approved", "Resolved"]).optional().describe("clash_status: the new status"),
  comment: z.string().optional().default("").describe("clash_status: a comment added to each result"),
  approved_by: z.string().optional().default("").describe("clash_status: the person who said yes (never the AI)"),
  plan_hash: z.string().optional().default("").describe("clash_status: the plan_hash from the dry run that person saw"),
  dry_run: z.boolean().optional().default(true).describe("federate, clash_create, clash_run, back, clash_status: a dry run unless false"),
  by: z.string().optional().default("").describe("Who acts (the pane passes the signed-in person)"),
};

export type FmcNavisArgs = z.infer<z.ZodObject<typeof FMC_NAVIS_SHAPE>>;

type Call = (method: string, params?: object, timeoutMs?: number) => Promise<Record<string, unknown>>;
type Reply = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** What the tests swap: the bridge, the guard config, fmc_review and the Revit model's name. */
export interface NavisDeps {
  state?: () => NavisState | null;
  alive?: (pid: number) => boolean;
  call?: Call;
  config?: GuardConfig;
  review?: (args: Record<string, unknown>) => Promise<Reply>;
  revitModel?: () => Promise<string>;
}

const LONG = 600000;

export function loadMatrix(file: string): { matrix?: ClashMatrix; problems: string[] } {
  let raw: string;
  try { raw = fs.readFileSync(expandEnv(file), "utf8"); } catch {
    return { problems: [`No clash matrix at ${file}: the kit has none yet (kit change request, docs/CLASH_MATRIX.md). Name a proposal with matrix, e.g. tests\\navis\\FMC_Clash_Matrix_sample.json`] };
  }
  let m: unknown;
  try { m = JSON.parse(raw.replace(/^﻿/, "")); } catch { return { problems: [`${file} is not valid JSON`] }; }
  const problems = matrixProblems(m);
  return problems.length ? { problems } : { matrix: m as ClashMatrix, problems };
}

const modelFiles = (info: Record<string, unknown>) =>
  ((info.models ?? []) as Array<{ file?: string; source?: string }>).flatMap((m) => [m.file ?? "", m.source ?? ""]).filter(Boolean);

function explicitModels(files: string[]): { models: FoundModel[]; problems: string[] } {
  const models: FoundModel[] = [], problems: string[] = [];
  for (const f of files) {
    const ext = win.extname(f).toLowerCase();
    const c = parseContainer(f);
    if (![".nwc", ".nwd", ".rvt"].includes(ext)) problems.push(`${f}: only NWC, NWD or RVT files are appended`);
    else if (!fs.existsSync(f)) problems.push(`${f} doesn't exist`);
    else models.push({ file: f, stem: win.basename(f, ext).toUpperCase(), role: c?.role ?? "BIM", project: c?.project ?? "", originator: c?.originator ?? "",
      area: f.toLowerCase().split(/[\\/]/).includes("02_shared") ? "shared" : "wip", ext });
  }
  return { models, problems };
}

export async function runFmcNavis(args: FmcNavisArgs, deps: NavisDeps = {}) {
  const cfg = deps.config ?? loadConfig().config;
  const state = (deps.state ?? readState)();
  const up = state !== null && (deps.alive ?? processAlive)(state.pid);
  const call: Call = deps.call ?? ((m, p = {}, t) => navisCall(state!.port, m, p, t));
  const by = args.by.trim() || process.env.USERNAME || "Formcraft";
  const dry = args.dry_run !== false;

  if (args.action === "status") {
    if (!state) return reply({ navisworks: "not found", detail: `No ${stateFile()}: Navisworks isn't running, or the Formcraft bridge isn't installed in it` });
    if (!up) return reply({ navisworks: "closed", detail: `Navisworks (pid ${state.pid}) has closed` });
    try {
      const info = await call("navis_info", {}, 15000);
      return reply({ navisworks: "running", port: state.port, pid: state.pid, file: info.file, models: (info.models as unknown[] | undefined)?.length ?? 0, clash_tests: info.clash_tests });
    } catch (e) {
      return reply({ navisworks: "running", port: state.port, pid: state.pid, bridge: e instanceof Error ? e.message : String(e) }, true);
    }
  }

  if (args.action === "matrix") {
    const file = args.matrix.trim() || cfg.clash_matrix_file;
    const { matrix, problems } = loadMatrix(file);
    if (!matrix) return reply({ refused: true, file, reasons: problems }, true);
    const tests = planTests(matrix, args.tests);
    let ready: ReturnType<typeof coverage> | undefined;
    if (up) { try { ready = coverage(tests, modelFiles(await call("navis_info"))); } catch { ready = undefined; } }
    return reply({ file, name: matrix.name, revision: matrix.revision, tests, ...(ready ? { open_federation: ready } : { note: "Open the federation in Navisworks to see which tests it can run" }) });
  }

  if (!up) return reply({ refused: true, reasons: ["Navisworks with the Formcraft bridge isn't running (fmc_navis status)"] }, true);
  try {
    if (args.action === "info") return reply(await call("navis_info"));
    if (args.action === "tests") return reply(await call("navis_clash_tests"));
    if (args.action === "results") {
      if (!args.test) return reply({ refused: true, reasons: ["Name the clash test (fmc_navis tests lists them)"] }, true);
      const r = await call("navis_clash_results", { test: args.test, status: args.status, limit: args.limit });
      const rows = (r.results ?? []) as ClashRow[];
      return reply({ ...r, groups: groupClashes(rows), note: "Read-only. Each clash names both Revit elements: a fix is the model author's, through a person's yes" });
    }
    if (args.action === "federate") return await federate(args, cfg, call, dry, by);
    if (args.action === "clash_create" || args.action === "clash_run") return await clashTests(args, cfg, call, dry);
    if (args.action === "back") return await back(args, cfg, call, dry, by, deps);
    return await clashStatus(args, cfg, call, dry);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(cfg, "navis_" + args.action, dry, args.project_folder || args.test, "error", msg);
    return reply({ error: msg }, true);
  }
}

async function federate(args: FmcNavisArgs, cfg: GuardConfig, call: Call, dry: boolean, by: string) {
  const pf = args.project_folder.trim();
  if (!pf) return reply({ refused: true, reasons: ["Set the project folder: the discipline models are found in it and the .nwf goes to its 01_WIP"] }, true);
  const ex = args.files.length ? explicitModels(args.files) : { models: findDisciplineModels(pf, { source: args.source, roles: args.roles }), problems: [] };
  if (ex.problems.length) return reply({ refused: true, reasons: ex.problems }, true);
  if (!ex.models.length) return reply({ refused: true, reasons: [`No container-named discipline models (NWC, NWD or RVT) in ${pf}'s ${args.source === "both" ? "02_Shared or 01_WIP" : args.source === "shared" ? "02_Shared" : "01_WIP"}`] }, true);
  const info = await call("navis_info");
  const plan = federationPlan(ex.models, modelFiles(info));
  const output = args.output.trim() || defaultFederatedFile(pf, ex.models);
  const problems = federatedPathProblems(output, cfg);
  const replaces = output && fs.existsSync(output);
  const summary = {
    document: info.file ?? "", output, by_role: plan.by_role,
    append: plan.append.map((m) => ({ file: m.file, role: m.role, from: m.area })), already_in_document: plan.already.map((m) => m.file),
    ...(replaces ? { archives: archivePlan(output, []).moves[0][1] } : {}),
  };
  if (problems.length) return reply({ refused: true, reasons: problems, ...summary }, true);
  if (dry) {
    const check = plan.append.length ? await call("navis_append", { files: plan.append.map((m) => m.file), dry_run: true }) : { files: [] };
    return reply({ dry_run: true, ...summary, bridge: check.files,
      next: `Run again with dry_run=false: Navisworks appends ${plan.append.length} model(s) and saves ${win.basename(output)}${replaces ? " (the older one goes to _Archive)" : ""}` });
  }
  const appended = plan.append.length ? await call("navis_append", { files: plan.append.map((m) => m.file), dry_run: false }, LONG) : { files: [], appended: 0 };
  const failed = ((appended.files ?? []) as Array<{ file: string; result: string }>).filter((f) => !/^(appended|already in the document)$/.test(f.result));
  if (failed.length) {
    log(cfg, "navis_federate", false, output, "partial", failed.map((f) => `${win.basename(f.file)} ${f.result}`).join("; "));
    return reply({ done: false, appended: appended.files, reasons: ["Some models weren't appended, so the federation wasn't saved: fix them and run again"] }, true);
  }
  if (replaces) {
    const [from, to] = archivePlan(output, []).moves[0];
    fs.mkdirSync(win.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  }
  const saved = await call("navis_save_as", { file: output, dry_run: false }, LONG);
  const root = exchangeRoot(pf, expandEnv(cfg.reports_dir));
  const pkg = writePackage(root, { from: "revit", to: "navisworks", what: "federation", files: [{ name: "federation.json", text: JSON.stringify({ output, models: ex.models, by }, null, 2) }] });
  log(cfg, "navis_federate", false, output, saved.saved ? "done" : "failed", `${plan.append.length} appended, ${plan.already.length} already in`);
  return reply({ done: !!saved.saved, output, appended: appended.files, saved, package: pkg.manifest.id,
    next: "fmc_navis clash_create with the clash matrix, then clash_run" }, !saved.saved);
}

async function clashTests(args: FmcNavisArgs, cfg: GuardConfig, call: Call, dry: boolean) {
  const file = args.matrix.trim() || cfg.clash_matrix_file;
  const { matrix, problems } = loadMatrix(file);
  if (!matrix) return reply({ refused: true, file, reasons: problems }, true);
  const planned = planTests(matrix, args.tests);
  if (!planned.length) return reply({ refused: true, reasons: [`None of ${args.tests.join(", ")} is in the matrix`] }, true);
  const label = `${matrix.name} ${matrix.revision}`;
  if (args.action === "clash_create") {
    const r = await call("navis_clash_create", { tests: planned, dry_run: dry, remove_stale: args.remove_stale }, dry ? 120000 : LONG);
    if (!dry) log(cfg, "navis_clash_create", false, label, "done", `${planned.length} tests`);
    return reply({ dry_run: dry, matrix: label, ...r, ...(dry ? { next: "Run again with dry_run=false to make or update these tests (only FMC tests change)" } : { next: "fmc_navis clash_run" }) });
  }
  const existing = ((await call("navis_clash_tests")).tests ?? []) as Array<{ name: string }>;
  const names: string[] = [], missing: string[] = [];
  for (const t of planned) {
    const found = existing.find((e) => idOfTest(e.name) === t.id);
    if (found) names.push(found.name); else missing.push(t.id);
  }
  if (!names.length) return reply({ refused: true, reasons: ["None of the matrix's tests is in the document yet: run clash_create first"], missing }, true);
  const r = await call("navis_clash_run", { tests: names, dry_run: dry }, dry ? 120000 : LONG);
  if (!dry) log(cfg, "navis_clash_run", false, label, "done", names.join("; "));
  return reply({ dry_run: dry, matrix: label, ...r, ...(missing.length ? { not_created_yet: missing } : {}),
    next: dry ? "Run again with dry_run=false to run them" : "fmc_navis back hands the new clashes to Revit (tickets or clouds)" });
}

async function back(args: FmcNavisArgs, cfg: GuardConfig, call: Call, dry: boolean, by: string, deps: NavisDeps) {
  const pf = args.project_folder.trim();
  if (!pf) return reply({ refused: true, reasons: ["Set the project folder: the review register and the identity map live in its 01_WIP"] }, true);
  const tests = ((await call("navis_clash_tests")).tests ?? []) as Array<{ name: string; last_run?: string }>;
  const test = newestTest(tests, args.test);
  if (!test) return reply({ refused: true, reasons: ["No clash test has been run yet: fmc_navis clash_run, or name the test"] }, true);
  const res = await call("navis_clash_results", { test, status: "", limit: 2000 });
  const root = exchangeRoot(pf, expandEnv(cfg.reports_dir));
  const map = loadIdentity(root);
  const resolved = resolveClashItems(map, (res.results ?? []) as NavisClashRow[], { record: !dry });
  const identity = dry ? { known: resolved.known, would_link: resolved.unknown, without_revit_id: resolved.without_revit_id }
    : { known: resolved.known, linked: resolved.linked, without_revit_id: resolved.without_revit_id };

  if (args.handover === "tickets") {
    const r = clashesIntoRegister({ projectFolder: pf, projectCode: args.project_code, test, rows: resolved.rows, by, dryRun: dry, config: cfg });
    if (dry) return reply({ dry_run: true, test, clashes: r.clashes, would_add: r.would_add, skipped: r.skipped, identity, next: "Run again with dry_run=false" });
    saveIdentity(root, map);
    const pkg = writePackage(root, { from: "navisworks", to: "revit", what: `clashes ${test}`, files: [{ name: "clashes.json", text: JSON.stringify({ test, rows: resolved.rows }, null, 2) }] });
    log(cfg, "navis_back", false, r.file, "done", `${test}: ${r.added.length} tickets`);
    return reply({ done: true, test, added: r.added, skipped: r.skipped, identity, package: pkg.manifest.id,
      next: "Open a ticket with fmc_review show; or fmc_navis back handover=clouds with the model open in Revit" });
  }

  const model = args.model.trim() || await (deps.revitModel ?? revitModelName)();
  if (!model) return reply({ refused: true, reasons: ["Open the Revit model to cloud in (or name it with model)"] }, true);
  const reg = loadRegister(pf);
  if (!reg.items.some((i) => i.links?.clash?.test === test))
    return reply({ refused: true, reasons: [`No tickets for ${test} yet: run fmc_navis back with handover=tickets first (a cloud marks a ticket)`] }, true);
  const plan = cloudPlan(reg, test, model);
  if (dry) return reply({ dry_run: true, test, model, ...plan, identity,
    next: plan.tickets.length ? `Run again with dry_run=false to draw ${plan.tickets.length} cloud(s) in ${model}'s active view (refused on live models: the lock decides)` : "Nothing to cloud in this model" });
  const done: Array<{ id: string; result: string }> = [];
  for (const t of plan.tickets) {
    const item = reg.items.find((i) => i.id === t.id)!;
    if (item.element_ids.length && item.element_ids.join() !== t.element_ids.join()) { done.push({ id: t.id, result: "skipped: it already links other elements" }); continue; }
    item.element_ids = t.element_ids;
  }
  saveRegister(pf, reg);
  saveIdentity(root, map);
  const review = deps.review ?? ((a: Record<string, unknown>) => runFmcReview(z.object(FMC_REVIEW_SHAPE).parse(a)));
  for (const t of plan.tickets) {
    if (done.some((d) => d.id === t.id)) continue;
    const r = await review({ action: "cloud", id: t.id, project_folder: pf, dry_run: false, by });
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(r.content[0]?.text ?? "{}"); } catch { body = {}; }
    done.push({ id: t.id, result: r.isError ? `refused: ${((body.reasons as string[] | undefined) ?? [String(body.error ?? "")]).join("; ")}` : "clouded" });
  }
  log(cfg, "navis_back_clouds", false, model, "done", `${test}: ${done.filter((d) => d.result === "clouded").length} clouds`);
  return reply({ done: true, test, model, clouds: done, more: plan.more });
}

async function revitModelName(): Promise<string> {
  try {
    const ctx = await withRevitConnection((c) => c.sendRaw("fmc_review_context", {}, 15000));
    return String(ctx?.model ?? "");
  } catch { return ""; }
}

async function clashStatus(args: FmcNavisArgs, cfg: GuardConfig, call: Call, dry: boolean) {
  const test = args.test.trim();
  const names = [...new Set(args.names.map((n) => n.trim()).filter(Boolean))];
  const reasons: string[] = [];
  if (!test) reasons.push("Name the clash test");
  if (!names.length) reasons.push("Name the clash results to change (names): only the results a person names are changed");
  if (names.length > 200) reasons.push("At most 200 results at a time");
  if (!args.set_status) reasons.push("Say the new status (set_status: Active, Reviewed, Approved or Resolved)");
  if (reasons.length) return reply({ refused: true, reasons }, true);
  const status = args.set_status!;
  const plan = await call("navis_clash_status", { test, names, status, comment: args.comment, author: "", dry_run: true });
  const rows = (plan.results ?? []) as Array<{ name: string; result: string; was?: string }>;
  const found = rows.filter((r) => r.result !== "missing").map((r) => r.name);
  const hash = statusHash(test, found, status, args.comment);
  if (dry) return reply({ dry_run: true, test, status, comment: args.comment, results: rows, plan_hash: hash,
    next: "Show this to the person who decides; on a clear yes run again with dry_run=false, approved_by (that person) and this plan_hash" });
  const who = args.approved_by.trim();
  if (!who || NOT_A_PERSON.test(who)) return reply({ refused: true, reasons: ["A clash status changes only with a person's yes: approved_by is that person, never the AI (rule 5)"] }, true);
  if (args.plan_hash.trim() !== hash) return reply({ refused: true, reasons: ["The plan changed since the dry run (or no plan_hash): run the dry run again and show it"], plan_hash: hash }, true);
  if (!found.length) return reply({ refused: true, reasons: ["None of the named results is in the test"] }, true);
  const comment = args.comment.trim() ? `${args.comment.trim()} (${who}, via Formcraft)` : "";
  const r = await call("navis_clash_status", { test, names: found, status, comment, author: who, dry_run: false });
  log(cfg, "navis_clash_status", false, test, "done", `${found.length} → ${status}, approved by ${who}`);
  return reply({ done: true, ...r, approved_by: who, next: "Save the .nwf in Navisworks to keep the statuses (a person's step)" });
}

export function registerFmcNavisTool(server: McpServer) {
  server.tool("fmc_navis", FMC_NAVIS_DESCRIPTION, FMC_NAVIS_SHAPE, (args) => runFmcNavis(args));
}
