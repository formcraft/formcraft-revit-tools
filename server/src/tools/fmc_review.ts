import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { Filter, PRIORITIES, Register, ReviewItem, answer, filterItems, find, printItems, printList, raise, raiseProblems, shownStatus, solve, verdict } from "../fmc/review.js";

const win = path.win32;

function log(cfg: GuardConfig, action: string, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = win.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, false, target, result, detail]));
  } catch {
    // logging must never block the work
  }
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

/** The project's review register: <project>\01_WIP\_Reviews\FMC_Review_Register.json (the team shares it). */
export function registerFile(projectFolder: string): string { return win.join(projectFolder, "01_WIP", "_Reviews", "FMC_Review_Register.json"); }
const registerFileFor = (projectFolder: string) => registerFile(projectFolder.trim());

function load(file: string, project: string): Register {
  try { const r = JSON.parse(fs.readFileSync(file, "utf8")) as Register; return { project: r.project || project, items: r.items ?? [] }; }
  catch { return { project, items: [] }; }
}

/** One line per item for lists (the full item comes with action item). */
const line = (i: ReviewItem, today: string) => ({ id: i.id, title: i.title, lead: i.lead, owner: i.owner, priority: i.priority, due: i.due,
  status: shownStatus(i, today), disciplines: i.disciplines, answered: i.answers.map((a) => a.discipline) });

export const FMC_REVIEW_DESCRIPTION =
  "Formcraft review register (MAN 10.5), kept in <project>\\01_WIP\\_Reviews\\FMC_Review_Register.json; it never changes " +
    "the model, so it works on live models. list (filter All, Open, My discipline, Overdue, Closed); item (one item in " +
    "full); raise (title, what is wrong, disciplines affected, lead discipline, one owner, priority, due date: default " +
    "Critical 3 working days, High 1 week; links the elements selected in Revit when link_selection is true); answer (a " +
    "discipline's answer); solve (the owner marks it done with the solution, once every asked discipline answered); " +
    "check (the raiser accepts and closes, or reopens with a reason); cloud (draws a revision cloud around the item's " +
    "linked elements in the active view, on the open review revision: changes the model, so a dry run first and refused " +
    "on live projects); print (a sheet's PDF and its list of items, for review or as revised, into " +
    "01_WIP\\_Reviews\\Prints\\<sheet>\\<date>_<kind>, with the sheet's print history).";

export const FMC_REVIEW_SHAPE = {
  action: z.enum(["list", "item", "raise", "answer", "solve", "check", "cloud", "print", "prints"]),
  sheet: z.string().optional().default("").describe("print, prints: the sheet number, e.g. A-1001"),
  kind: z.enum(["For review", "As revised"]).optional().default("For review").describe("print: open items to fix, or solved items with their solutions"),
  dry_run: z.boolean().optional().default(true).describe("cloud: a dry run unless false"),
  project_folder: z.string().describe("The project folder (the register lives in its 01_WIP)"),
  project_code: z.string().optional().default(""),
  filter: z.enum(["All", "Open", "My discipline", "Overdue", "Closed"]).optional().default("Open"),
  my_disciplines: z.array(z.string()).optional().default([]),
  full: z.boolean().optional().default(false).describe("list: whole items (answers, solution) instead of one line each; the pane asks for them"),
  id: z.string().optional().default("").describe("item, answer, solve, check: the item id, e.g. F26001-ISS-0014"),
  title: z.string().optional().default(""),
  description: z.string().optional().default(""),
  disciplines: z.array(z.string()).optional().default([]),
  lead: z.string().optional().default(""),
  owner: z.string().optional().default(""),
  priority: z.enum(PRIORITIES).optional().default("High"),
  due: z.string().optional().default("").describe("raise: YYYY-MM-DD (empty: the priority's default)"),
  link_selection: z.boolean().optional().default(true).describe("raise: link the elements selected in Revit"),
  discipline: z.string().optional().default("").describe("answer: the answering discipline"),
  text: z.string().optional().default("").describe("answer: the answer; solve: the solution; check: the reason to reopen"),
  done: z.boolean().optional().default(true).describe("answer: this discipline's part is done"),
  accept: z.boolean().optional().default(true).describe("check: accept and close (true) or reopen (false)"),
  by: z.string().optional().default("").describe("Who acts (the pane passes the signed-in person)"),
};

export type FmcReviewArgs = z.infer<z.ZodObject<typeof FMC_REVIEW_SHAPE>>;

export async function runFmcReview(args: FmcReviewArgs) {
  const { config } = loadConfig();
  try {
    if (!args.project_folder.trim()) return reply({ refused: true, reasons: ["Set the project folder: the review register lives in its 01_WIP"] }, true);
    const file = registerFile(args.project_folder.trim());
    const now = new Date(), today = now.toISOString().slice(0, 10);
    const reg = load(file, args.project_code.trim().toUpperCase());

    if (args.action === "list") {
      const items = filterItems(reg, args.filter as Filter, args.my_disciplines, today);
      return reply({ file, project: reg.project, filter: args.filter, count: items.length, total: reg.items.length,
        overdue: reg.items.filter((i) => shownStatus(i, today) === "Overdue").length,
        items: items.map((i) => args.full ? { ...i, shown_status: shownStatus(i, today) } : line(i, today)) });
    }
    if (args.action === "item") return reply({ item: { ...find(reg, args.id), shown_status: shownStatus(find(reg, args.id), today) } });
    if (args.action === "prints")
      return reply({ sheet: args.sheet, prints: (reg.prints ?? []).filter((p) => !args.sheet || p.sheet.toUpperCase() === args.sheet.toUpperCase()).slice(-20).reverse() });

    const verdictWrite = checkWritePath(file, config, { checkName: false });
    if (!verdictWrite.ok) return reply({ refused: true, reasons: verdictWrite.reasons }, true);
    const by = args.by.trim() || "Claude (via MCP)";
    let item: ReviewItem;
    if (args.action === "raise") {
      let ctx: { model?: string; view?: string; sheet?: string; selected?: number[] } = {};
      try { ctx = await withRevitConnection((c) => c.sendRaw("fmc_review_context", {}, 15000)); } catch { ctx = {}; }
      const q = { title: args.title, description: args.description, disciplines: args.disciplines, lead: args.lead, owner: args.owner,
        priority: args.priority, due: args.due.trim(), raised_by: by, model: ctx.model ?? "", view: ctx.view ?? "",
        element_ids: args.link_selection ? (ctx.selected ?? []) : [], sheet: ctx.sheet ?? "" };
      const problems = raiseProblems(q, today);
      if (problems.length) return reply({ refused: true, reasons: problems }, true);
      item = raise(reg, q, now);
    } else if (args.action === "cloud") {
      item = find(reg, args.id);
      if (!item.element_ids.length) return reply({ refused: true, reasons: [`${item.id} has no linked elements: select them in Revit and raise it with link_selection, or cloud by hand`] }, true);
      if (item.cloud) return reply({ refused: true, reasons: [`${item.id} already has a cloud (${item.cloud.view}, revision ${item.cloud.revision})`] }, true);
      const params = { element_ids: item.element_ids, mark: item.id, comment: `${item.id} · ${item.title}`, dry_run: args.dry_run !== false };
      // The plan only reads; drawing the cloud changes the model and goes through the live-model lock.
      const r = await withRevitConnection((c) => args.dry_run !== false ? c.sendRaw("fmc_review_cloud", params, 30000) : c.sendCommand("fmc_review_cloud", params, 30000));
      if (args.dry_run !== false) return reply({ dry_run: true, would: r, next: "Run again with dry_run=false" });
      item.cloud = { id: Number(r?.cloud_id ?? 0), view: String(r?.view ?? ""), revision: String(r?.revision ?? "") };
      item.history.push({ at: now.toISOString(), by, what: `Clouded on ${item.cloud.view} (revision ${item.cloud.revision})` });
    } else if (args.action === "print") {
      const sheet = args.sheet.trim().toUpperCase();
      if (!sheet) return reply({ refused: true, reasons: ["Name the sheet to print, e.g. A-1001"] }, true);
      const facts = await withRevitConnection((c) => c.sendRaw("fmc_sheet_facts", { fields: [] }, 60000));
      const target = ((facts?.sheets ?? []) as Array<{ id: number; number: string; name: string }>).find((x) => x.number.toUpperCase() === sheet);
      if (!target) return reply({ refused: true, reasons: [`Sheet ${sheet} isn't in the model`] }, true);
      const items = printItems(reg, sheet, args.kind);
      const folder = win.join(args.project_folder.trim(), "01_WIP", "_Reviews", "Prints", sheet, `${today}_${args.kind === "For review" ? "ForReview" : "AsRevised"}`);
      const v = checkWritePath(win.join(folder, "x.pdf"), config, { checkName: false });
      if (!v.ok) return reply({ refused: true, reasons: v.reasons }, true);
      if (fs.existsSync(folder) && fs.readdirSync(folder).length) return reply({ refused: true, reasons: [`${folder} already holds today's print; nothing is overwritten`] }, true);
      fs.mkdirSync(folder, { recursive: true });
      const file = `${sheet}_${args.kind === "For review" ? "ForReview" : "AsRevised"}_${today}`;
      const e = await withRevitConnection((c) => c.sendRaw("fmc_issue_export", { folder, sheets: [{ id: target.id, file }] }, 300000));
      fs.writeFileSync(win.join(folder, file + "_items.md"), printList(`${sheet} ${target.name}`, args.kind, items, now));
      const pdf = ((e?.sheets ?? []) as Array<{ result: string }>)[0]?.result ?? "not exported";
      reg.prints = [...(reg.prints ?? []), { sheet, kind: args.kind, at: now.toISOString(), by, revision: "", items: items.map((i) => i.id), folder }];
      fs.writeFileSync(registerFileFor(args.project_folder), JSON.stringify(reg, null, 2));
      log(config, "review_print", folder, pdf === "exported" ? "done" : "partial", `${sheet} ${args.kind}: ${items.length} items, PDF ${pdf}`);
      return reply({ done: true, folder, pdf, items: items.map((i) => i.id), next: "Each print is kept in the sheet's print history" });
    } else {
      item = find(reg, args.id);
      if (args.action === "answer") answer(item, args.discipline || args.lead, by, args.text, args.done, now);
      else if (args.action === "solve") solve(item, by, args.text, now);
      else verdict(item, by, args.accept, args.text, now);
    }
    fs.mkdirSync(win.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(reg, null, 2));
    log(config, "review_" + args.action, file, "done", `${item.id} ${item.status}`);
    return reply({ done: true, item: { ...item, shown_status: shownStatus(item, today) }, file,
      next: args.action === "solve" ? "The raiser checks it: accept and close, or reopen" : undefined });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "review_" + args.action, args.project_folder, "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcReviewTool(server: McpServer) {
  server.tool("fmc_review", FMC_REVIEW_DESCRIPTION, FMC_REVIEW_SHAPE, (args) => runFmcReview(args));
}
