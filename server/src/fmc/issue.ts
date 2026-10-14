/**
 * Ready to issue (board manage/PaneIssue, U19). Pure.
 *
 * One check before anything leaves the office: every sheet of the issue set against the register, its title block,
 * the Must rules, the links and the codes. The result is Ready, Ready with exceptions (each one approved and recorded)
 * or Blocked. The five codes stay apart (MAN 4.4): company revision, Revit revision, sheet status, purpose, approval.
 */
import { ModelSheet, RegisterSheet, numberOk } from "./sheets.js";
import { RuleResult } from "./rules.js";

export const PURPOSES = ["For construction", "For approval", "For information", "For tender", "For permit"];

/** Company revision: P01 (preliminary), C01 (contract), A01 (as built), with an optional point (P01.1). */
export function revisionOk(r: string) { return /^[PCA]\d{2}(\.\d+)?$/.test(r.trim()); }

/** Sheet status (suitability) codes: S0–S7 shared, A1–A9 authorised, B1–B9 partly signed off, CR as built. */
export function statusOk(s: string) { return /^(S[0-7]|A[1-9]|B[1-9]|CR)$/.test(s.trim()); }

export interface Revision { id: number; sequence: number; number: string; description: string; date: string; issued: boolean }
export interface IssueSheet extends ModelSheet { current_revision?: string }
export interface IssueException { sheet: string; item: string; why: string; approved_by: string; until: string; recorded?: string }

export interface IssueInput {
  issue_set: string;
  purpose: string;
  company_revision: string;
  /** Title block fields every issued sheet fills (approval is checked on its own). */
  fields: string[];
  approval_field: string;
  status_field: string;
  today: string;
}

export interface SheetReadiness {
  number: string; name: string; id?: number;
  status: "Ready" | "Exception" | "Blocked";
  /** What stops the sheet, as "item: detail"; item is what an exception names. */
  reasons: string[];
  excepted: string[];
  element_ids: number[];
}

export type CheckState = "Pass" | "Warn" | "Fail" | "N/A";
export interface ChecklistLine { check: string; state: CheckState; detail: string }

export interface Readiness {
  result: "Ready" | "Ready with exceptions" | "Blocked";
  summary: string;
  checklist: ChecklistLine[];
  sheets: SheetReadiness[];
  model_blockers: string[];
  exceptions_used: IssueException[];
  revit_revision: string;
}

/** An exception is in force until its date passes, or until the company revision reaches the one it names. */
export function inForce(e: IssueException, revision: string, today: string): boolean {
  const u = (e.until ?? "").trim();
  if (!u) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(u)) return u >= today;
  if (revisionOk(u) && revisionOk(revision)) return revision.trim().toUpperCase() < u.toUpperCase();
  return true;
}

function covers(e: IssueException, sheet: string, item: string) {
  return e.sheet.trim().toUpperCase() === sheet.toUpperCase() && (e.item.trim() === "*" || e.item.trim().toLowerCase() === item.toLowerCase());
}

/** The latest Revit revision, as the pane shows it: "Seq 4 · P03 · open". */
export function revitRevision(revisions: Revision[]): string {
  if (!revisions.length) return "None in the model";
  const last = [...revisions].sort((a, b) => a.sequence - b.sequence)[revisions.length - 1];
  return `Seq ${last.sequence}${last.number ? " · " + last.number : ""} · ${last.issued ? "issued" : "open"}`;
}

export function readiness(
  input: IssueInput, plan: RegisterSheet[], model: IssueSheet[], rules: RuleResult[], links: Array<{ name: string; pinned: boolean }>,
  revisions: Revision[], exceptions: IssueException[],
): Readiness {
  const byNumber = new Map(model.map((m) => [m.number, m]));
  const live = exceptions.filter((e) => inForce(e, input.company_revision, input.today));
  const used: IssueException[] = [];
  const failing = rules.filter((r) => r.state === "Fail" && r.severity === "Must" && !r.excepted);
  const sheetIds = new Set(model.map((m) => m.id));

  const sheets: SheetReadiness[] = plan.map((p) => {
    const m = byNumber.get(p.number);
    const found: Array<[string, string, number[]]> = [];
    if (!numberOk(p.number)) found.push(["number", `${p.number} doesn't follow [Role]-[Series][Number]`, []]);
    if (!m) found.push(["missing", "not in the model", []]);
    else {
      const empty = input.fields.filter((f) => !(m.fields[f] ?? "").trim());
      if (empty.length) found.push(["title block", `${empty.join(", ")} empty`, [m.id]]);
      if (!(m.fields[input.approval_field] ?? "").trim()) found.push(["approval", `${input.approval_field} empty`, [m.id]]);
      const st = (m.fields[input.status_field] ?? "").trim();
      if (!statusOk(st)) found.push(["status", st ? `${input.status_field} "${st}" isn't a status code` : `${input.status_field} empty`, [m.id]]);
      for (const r of failing) if (r.element_ids.includes(m.id)) found.push([`rule ${r.id}`, r.rule, [m.id]]);
    }
    const reasons: string[] = [], excepted: string[] = [], ids = new Set<number>();
    for (const [item, detail, els] of found) {
      const e = live.find((x) => covers(x, p.number, item));
      if (e) { excepted.push(`${item}: ${detail} (${e.approved_by})`); if (!used.includes(e)) used.push(e); }
      else { reasons.push(`${item}: ${detail}`); els.forEach((i) => ids.add(i)); }
    }
    return { number: p.number, name: m?.name ?? p.name, id: m?.id, status: reasons.length ? "Blocked" : excepted.length ? "Exception" : "Ready",
      reasons, excepted, element_ids: [...ids] };
  });

  // Must rules that fail on things other than these sheets block the whole issue.
  const modelBlockers = failing.filter((r) => !r.element_ids.some((i) => sheetIds.has(i))).map((r) => `${r.id} (${r.where})`);

  const n = plan.length;
  const count = (pred: (s: SheetReadiness) => boolean) => sheets.filter(pred).length;
  const has = (s: SheetReadiness, item: string) => s.reasons.some((r) => r.startsWith(item + ":"));
  const exc = (s: SheetReadiness, item: string) => s.excepted.some((r) => r.startsWith(item + ":"));
  const line = (check: string, item: string | ((s: SheetReadiness, f: typeof has) => boolean), okDetail: (bad: number) => string): ChecklistLine => {
    const test = typeof item === "string" ? (s: SheetReadiness, f: typeof has) => f(s, item) : item;
    const bad = count((s) => test(s, has)), ex = count((s) => test(s, exc));
    return { check, state: bad ? "Fail" : ex ? "Warn" : "Pass", detail: okDetail(bad) + (ex ? `, ${ex} excepted` : "") };
  };
  const unpinned = links.filter((l) => !l.pinned);
  const latest = [...revisions].sort((a, b) => a.sequence - b.sequence).pop();
  const codes: string[] = [];
  if (!revisionOk(input.company_revision)) codes.push(`company revision "${input.company_revision}" isn't P01, C01 or A01 style`);
  if (!PURPOSES.includes(input.purpose)) codes.push(`purpose "${input.purpose}" isn't one of ${PURPOSES.join(", ")}`);
  const ruleFails = failing.length;
  // F-018: Must rules QA couldn't check are never counted as passed.
  const mustUnchecked = rules.filter((r) => r.severity === "Must" && r.state === "Not checked").length;

  const checklist: ChecklistLine[] = [
    line("Sheets exist with valid numbers", (s, f) => f(s, "missing") || f(s, "number"), (bad) => `${n - bad} / ${n}`),
    line("Title blocks filled", "title block", (bad) => `${n - bad} / ${n}`),
    { check: "Mandatory rules pass", state: ruleFails ? (modelBlockers.length || count((s) => s.reasons.some((r) => r.startsWith("rule "))) ? "Fail" : "Warn") : mustUnchecked ? "Warn" : "Pass",
      detail: [ruleFails ? `${ruleFails} fail` : "", mustUnchecked ? `${mustUnchecked} not checked (a person reviews them)` : ""].filter(Boolean).join(", ") || "OK" },
    { check: "Open reviews on these sheets", state: "N/A", detail: "Review items arrive with Team › Review" },
    { check: "Links checked", state: unpinned.length ? "Warn" : "Pass", detail: links.length ? (unpinned.length ? `${unpinned.length} unpinned` : `${links.length} pinned`) : "No links" },
    line("Sheet status codes valid", "status", (bad) => bad ? `${bad} not valid` : "OK"),
    { check: "Revision and purpose valid", state: codes.length ? "Fail" : latest && latest.issued ? "Warn" : "Pass",
      detail: codes.length ? codes.join("; ") : latest ? (latest.issued ? "The latest Revit revision is already issued: add one for this issue" : "OK") : "No Revit revision yet" },
    line("Approvals recorded", "approval", (bad) => `${n - bad} of ${n}`),
  ];

  const blocked = sheets.filter((s) => s.status === "Blocked");
  const anyFail = blocked.length > 0 || modelBlockers.length > 0 || codes.length > 0 || n === 0;
  const result = anyFail ? "Blocked" : used.length ? "Ready with exceptions" : "Ready";
  const summary = n === 0 ? "The register plans no sheets for this issue set and these disciplines."
    : anyFail ? [
        blocked.length ? `${blocked.length} sheet${blocked.length === 1 ? "" : "s"} blocked (${blocked.slice(0, 4).map((s) => s.number).join(", ")}${blocked.length > 4 ? "…" : ""})` : "",
        modelBlockers.length ? `Must rules fail: ${modelBlockers.join(", ")}` : "",
        codes.length ? codes.join("; ") : "",
      ].filter(Boolean).join(". ") + ". Fix them, or record an approved exception."
    : (used.length ? `${n} sheets ready, ${used.length} with an approved exception.` : `${n} sheets ready.`)
      + (mustUnchecked ? ` ${mustUnchecked} Must rule${mustUnchecked === 1 ? " wasn't" : "s weren't"} checked: a person reviews ${mustUnchecked === 1 ? "it" : "them"} before the issue goes out.` : "");

  return { result, summary, checklist, sheets, model_blockers: modelBlockers, exceptions_used: used, revit_revision: revitRevision(revisions) };
}

/** Container name for a sheet PDF (MAN 4.1): [Project]-[Originator]-ZZ-ZZ-DR-[Role]-[Number]. */
export function sheetFileName(code: string, originator: string, number: string): string {
  const [role, digits] = number.includes("-") ? [number.split("-")[0], number.split("-").slice(1).join("")] : ["Z", number];
  return `${code}-${originator}-ZZ-ZZ-DR-${role}-${digits.replace(/[^A-Za-z0-9]/g, "").padStart(4, "0")}`;
}

export interface IssueFile { kind: "pdf" | "register" | "transmittal" | "report"; name: string; sheet?: string; id?: number }

export function manifest(code: string, originator: string, revision: string, r: Readiness, outputs: { pdf: boolean; register: boolean; transmittal: boolean }): IssueFile[] {
  const files: IssueFile[] = [];
  if (outputs.pdf)
    for (const s of r.sheets) if (s.id !== undefined) files.push({ kind: "pdf", name: sheetFileName(code, originator, s.number) + ".pdf", sheet: s.number, id: s.id });
  if (outputs.register) files.push({ kind: "register", name: `${code}_Drawing_Register_${revision}.csv` });
  if (outputs.transmittal) files.push({ kind: "transmittal", name: `${code}_Transmittal_${revision}.md` });
  files.push({ kind: "report", name: `${code}_Readiness_${revision}.md` });
  return files;
}

export function registerCsv(code: string, originator: string, input: IssueInput, r: Readiness, model: IssueSheet[], csv: (cells: string[]) => string): string {
  const byNumber = new Map(model.map((m) => [m.number, m]));
  return csv(["Sheet", "Name", "Container name", "Company revision", "Revit revision", "Status", "Purpose", "Issue set", "Date"]) +
    r.sheets.map((s) => csv([s.number, s.name, sheetFileName(code, originator, s.number), input.company_revision,
      byNumber.get(s.number)?.current_revision ?? "", byNumber.get(s.number)?.fields[input.status_field] ?? "", input.purpose, input.issue_set, input.today])).join("");
}

export function transmittal(code: string, input: IssueInput, r: Readiness, sendTo: string, files: IssueFile[]): string {
  return [
    `# Transmittal · ${code} · ${input.issue_set} · ${input.company_revision}`, "",
    `Date: ${input.today}  `, `Purpose: ${input.purpose}  `, `To: ${sendTo || "(not set)"}  `, `Readiness: ${r.result}`, "",
    "| Sheet | Name | File |", "|---|---|---|",
    ...r.sheets.map((s) => `| ${s.number} | ${s.name} | ${files.find((f) => f.sheet === s.number)?.name ?? ""} |`), "",
    r.exceptions_used.length ? "## Approved exceptions" : "",
    ...r.exceptions_used.map((e) => `- ${e.sheet} · ${e.item}: ${e.why} (approved by ${e.approved_by}${e.until ? ", until " + e.until : ""})`),
    "", "Issued from 01_WIP\\_Issue. A person moves it to 03_Published after authorisation.",
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n") + "\n";
}

export function readinessReport(code: string, input: IssueInput, r: Readiness, rulebooks: string, when: Date): string {
  return [
    `# Readiness · ${code} · ${input.issue_set} · ${input.company_revision}`, "",
    `Checked ${when.toISOString()} against ${rulebooks}. Purpose: ${input.purpose}. Revit revision: ${r.revit_revision}.`, "",
    `**${r.result}.** ${r.summary}`, "",
    "| Check | State | Detail |", "|---|---|---|", ...r.checklist.map((c) => `| ${c.check} | ${c.state} | ${c.detail} |`), "",
    "| Sheet | Name | Status | Why |", "|---|---|---|---|",
    ...r.sheets.map((s) => `| ${s.number} | ${s.name} | ${s.status} | ${[...s.reasons, ...s.excepted.map((x) => "excepted · " + x)].join("; ")} |`), "",
    r.exceptions_used.length ? "## Exceptions" : "",
    ...r.exceptions_used.map((e) => `- ${e.sheet} · ${e.item}: ${e.why} · ${e.approved_by}${e.until ? " · until " + e.until : ""}`),
  ].join("\n") + "\n";
}
