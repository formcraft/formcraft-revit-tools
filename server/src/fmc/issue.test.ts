import { test } from "node:test";
import assert from "node:assert/strict";
import { IssueException, IssueInput, IssueSheet, inForce, manifest, readiness, revisionOk, revitRevision, sheetFileName, statusOk } from "./issue.js";
import { RuleResult } from "./rules.js";
import { RegisterSheet } from "./sheets.js";

const input: IssueInput = {
  issue_set: "CONSTRUCTION", purpose: "For construction", company_revision: "C02",
  fields: ["Drawn By", "Checked By", "Sheet Issue Date"], approval_field: "Approved By", status_field: "FMC_Sheet_Status", today: "2026-10-14",
};
const full = { "Drawn By": "AB", "Checked By": "CD", "Sheet Issue Date": "2026-10-14", "Approved By": "EF", FMC_Sheet_Status: "A1" };
const plan: RegisterSheet[] = [
  { number: "Z-0001", name: "Sheet index", role: "Z", sets: [] },
  { number: "A-1001", name: "GA ground floor", role: "A", sets: [] },
  { number: "A-2001", name: "Elevations", role: "A", sets: [] },
  { number: "M-1001", name: "Ventilation L00", role: "M", sets: [] },
];
const model: IssueSheet[] = [
  { id: 1, number: "Z-0001", name: "Sheet index", views: 0, fields: { ...full } },
  { id: 2, number: "A-1001", name: "GA ground floor", views: 0, fields: { ...full } },
  { id: 3, number: "A-2001", name: "Elevations", views: 0, fields: { ...full, "Approved By": "" } },
  { id: 4, number: "M-1001", name: "Ventilation L00", views: 0, fields: { ...full, FMC_Sheet_Status: "WIP" } },
];
const revs = [{ id: 9, sequence: 4, number: "C02", description: "Construction", date: "2026-10-14", issued: false }];
const mustFail = (ids: number[]): RuleResult => ({ id: "SHT-019", rule: "Sheet status filled", severity: "Must", state: "Fail", where: `${ids.length} sheets`, element_ids: ids, fix_hint: "" });

test("codes: company revision and status are checked apart", () => {
  assert.ok(revisionOk("C02") && revisionOk("P01.1") && !revisionOk("02") && !revisionOk("C2"));
  assert.ok(statusOk("A1") && statusOk("S2") && statusOk("CR") && !statusOk("WIP") && !statusOk(""));
});

test("a sheet with an empty approval or a bad status code blocks the issue", () => {
  const r = readiness(input, plan, model, [], [], revs, []);
  assert.equal(r.result, "Blocked");
  assert.deepEqual(r.sheets.map((s) => s.status), ["Ready", "Ready", "Blocked", "Blocked"]);
  assert.match(r.sheets[3].reasons[0], /^status: FMC_Sheet_Status "WIP"/);
  assert.equal(r.checklist.find((c) => c.check === "Approvals recorded")!.detail, "3 of 4");
  assert.match(r.summary, /2 sheets blocked \(A-2001, M-1001\)/);
});

test("approved exceptions turn blocked sheets into Ready with exceptions; expired ones don't count", () => {
  const ex: IssueException[] = [
    { sheet: "A-2001", item: "approval", why: "Agreed by phone", approved_by: "NAME A", until: "C03" },
    { sheet: "M-1001", item: "*", why: "Status follows", approved_by: "NAME F", until: "" },
  ];
  const r = readiness(input, plan, model, [], [], revs, ex);
  assert.equal(r.result, "Ready with exceptions");
  assert.deepEqual(r.sheets.map((s) => s.status), ["Ready", "Ready", "Exception", "Exception"]);
  assert.equal(r.exceptions_used.length, 2);
  assert.equal(inForce(ex[0], "C03", "2026-10-14"), false);
  assert.equal(inForce({ ...ex[0], until: "2026-10-01" }, "C02", "2026-10-14"), false);
});

test("Must rules block the sheet they fail on, or the whole issue when they fail elsewhere", () => {
  const fixed = model.map((m) => ({ ...m, fields: { ...full } }));
  const onSheet = readiness(input, plan, fixed, [mustFail([2])], [], revs, []);
  assert.equal(onSheet.sheets[1].status, "Blocked");
  assert.match(onSheet.sheets[1].reasons[0], /^rule SHT-019/);
  const elsewhere = readiness(input, plan, fixed, [mustFail([77])], [], revs, []);
  assert.equal(elsewhere.result, "Blocked");
  assert.deepEqual(elsewhere.model_blockers, ["SHT-019 (1 sheets)"]);
  const excepted = readiness(input, plan, fixed, [{ ...mustFail([77]), excepted: "Exception: …" }], [], revs, []);
  assert.equal(excepted.result, "Ready");
});

test("a missing sheet, a bad revision and an issued Revit revision show in the checklist", () => {
  const r = readiness({ ...input, company_revision: "2" }, plan, model.slice(0, 3).map((m) => ({ ...m, fields: { ...full } })), [], [{ name: "S.rvt", pinned: false }],
    [{ ...revs[0], issued: true }], []);
  const byCheck = Object.fromEntries(r.checklist.map((c) => [c.check, c]));
  assert.equal(byCheck["Sheets exist with valid numbers"].detail, "3 / 4");
  assert.equal(byCheck["Revision and purpose valid"].state, "Fail");
  assert.equal(byCheck["Links checked"].state, "Warn");
  assert.equal(r.sheets[3].reasons[0], "missing: not in the model");
  assert.equal(revitRevision([{ ...revs[0], issued: true }]), "Seq 4 · C02 · issued");
});

test("the manifest names PDFs by container name and adds the register, transmittal and report", () => {
  assert.equal(sheetFileName("F26001", "FMC", "A-1001"), "F26001-FMC-ZZ-ZZ-DR-A-1001");
  const fixed = model.map((m) => ({ ...m, fields: { ...full } }));
  const r = readiness(input, plan, fixed, [], [], revs, []);
  const files = manifest("F26001", "FMC", "C02", r, { pdf: true, register: true, transmittal: false });
  assert.deepEqual(files.map((f) => f.name), [
    "F26001-FMC-ZZ-ZZ-DR-Z-0001.pdf", "F26001-FMC-ZZ-ZZ-DR-A-1001.pdf", "F26001-FMC-ZZ-ZZ-DR-A-2001.pdf", "F26001-FMC-ZZ-ZZ-DR-M-1001.pdf",
    "F26001_Drawing_Register_C02.csv", "F26001_Readiness_C02.md"]);
});
