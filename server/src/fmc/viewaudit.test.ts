import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { auditViews, planFixes, type ViewAuditRead } from "./viewaudit.js";
import { FMC_VIEW_AUDIT_SHAPE, runFmcViewAudit, type FmcViewAuditArgs } from "../tools/fmc_view_audit.js";

const args = (partial: Record<string, unknown>): FmcViewAuditArgs => z.object(FMC_VIEW_AUDIT_SHAPE).parse(partial);
const textOf = (r: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> =>
  ({ ...(JSON.parse(r.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: r.isError === true });

const READ: ViewAuditRead = {
  title: "A", path: "D:\\Jobs\\_Staging\\F26901\\01_WIP\\A.rvt",
  views: [
    { id: "1", name: "Level 1", view_type: "FloorPlan", template_capable: true, template: "", template_id: "-1", on_sheet: true, discipline: "Architectural", detail_level: "Medium", crop_active: true, crop_visible: false,
      view_range: { top: { level: "Associated level", offset_mm: 2300 }, cut: { level: "Associated level", offset_mm: 1200 }, bottom: { level: "Associated level", offset_mm: 0 }, depth: { level: "Associated level", offset_mm: 0 } },
      link_overrides: [{ link: "S.rvt", mode: "ByLinkView" }] },
    { id: "2", name: "Level 2", view_type: "FloorPlan", template_capable: true, template: "FMC_A_Plan", template_id: "10", on_sheet: false, discipline: "Architectural", detail_level: "Fine", crop_active: false, crop_visible: true, scope_box: "SB1" },
    { id: "3", name: "Sheet A-101", view_type: "DrawingSheet", template_capable: false, on_sheet: true },
    { id: "4", name: "Door legend", view_type: "Legend", template_capable: false, on_sheet: false },
    { id: "5", name: "Dup", view_type: "Section", template_capable: true, template_id: "-1", on_sheet: true },
    { id: "6", name: "Dup", view_type: "Section", template_capable: true, template_id: "-1", on_sheet: true },
  ],
  templates: [
    { id: "10", name: "FMC_A_Plan", view_type: "FloorPlan", users: 1, controlled: 40, non_controlled: ["View Range", "Scale"] },
    { id: "11", name: "FMC_A_Section", view_type: "Section", users: 0, controlled: 30, non_controlled: [] },
  ],
  filters: [{ id: "20", name: "FMC_Fire", kind: "ParameterFilterElement", used_by: 2 }, { id: "21", name: "Old", kind: "ParameterFilterElement", used_by: 0 }],
  scope_boxes: [{ id: "30", name: "SB1" }],
};

test("the report lists every finding the brief names", () => {
  const r = auditViews(READ);
  assert.deepEqual(r.views_without_template.items.map((v) => v.view), ["Level 1", "Dup", "Dup"]);
  assert.equal(r.non_controlled_template_parameters.items[0]?.template, "FMC_A_Plan");
  assert.deepEqual(r.non_controlled_template_parameters.items[0]?.parameters, ["View Range", "Scale"]);
  assert.deepEqual(r.unused_templates.items.map((t) => t.template), ["FMC_A_Section"]);
  assert.deepEqual(r.unused_filters.items.map((f) => f.filter), ["Old"]);
  assert.deepEqual(r.views_not_on_sheets.items.map((v) => v.view), ["Level 2", "Door legend"]);
  assert.equal(r.state.view_range.items[0]?.view, "Level 1");
  assert.equal(r.state.crop_off.items[0]?.view, "Level 2");
  assert.equal(r.state.scope_box.items[0]?.scope_box, "SB1");
  assert.equal(r.state.link_overrides.items[0]?.view, "Level 1");
  assert.equal(r.state.detail_level.Fine, 1);
  assert.equal(auditViews(READ, 1).views_without_template.total, 3);
});

test("fixes are checked against the read before anything is planned", () => {
  const p = planFixes(READ, [
    { op: "assign_template", view: "Level 1", template: "FMC_A_Plan" },
    { op: "assign_template", view: "Level 1", template: "FMC_A_Section" },
    { op: "assign_template", view: "Dup", template: "FMC_A_Section" },
    { op: "assign_template", view: "Level 2", template: "FMC_A_Plan" },
    { op: "control_template_params", template: "FMC_A_Plan" },
    { op: "control_template_params", template: "FMC_A_Plan", parameters: ["Nope"] },
    { op: "set_scope_box", view: "Level 2", scope_box: "" },
    { op: "set_scope_box", view: "Level 1", scope_box: "SB9" },
    { op: "set_detail_level", view: "Level 2", level: "Fine" },
    { op: "set_crop", view: "Level 2" },
  ]);
  assert.deepEqual(p.ops.map((o) => o.op), ["assign_template", "control_template_params", "set_scope_box"]);
  assert.deepEqual(p.ops[1]?.parameters, ["View Range", "Scale"]);
  assert.equal((p.ops[2]?.value as { scope_box_id: string }).scope_box_id, "-1");
  const codes = p.skipped.map((s) => s.code);
  assert.ok(codes.includes("FMC-VIEWAUDIT-TEMPLATE-TYPE"));
  assert.ok(codes.includes("FMC-VIEWAUDIT-AMBIGUOUS"));
  assert.ok(codes.includes("FMC-VIEWAUDIT-PARAM"));
  assert.ok(codes.includes("FMC-VIEWAUDIT-NOT-FOUND"));
  assert.ok(codes.filter((c) => c === "FMC-VIEWAUDIT-NOTHING").length >= 3);
  assert.equal(p.warnings[0]?.code, "FMC-VIEWAUDIT-TEMPLATE-CONTROLS");
});

test("fixes need a dry run, confirm, the same plan_hash and a lease, then go in one call", async () => {
  const guard: GuardConfig = { ...DEFAULT_CONFIG };
  const read = async () => READ;
  let applies = 0;
  const apply = async (b: Record<string, unknown>) => { applies += 1; return { ok: true, applied: b.ops, failed: [] }; };
  const fixes = [{ op: "assign_template", view: "Level 1", template: "FMC_A_Plan" }, { op: "set_detail_level", view: "Level 1", level: "Fine" }];
  const report = textOf(await runFmcViewAudit(args({ document: "A" }), { read, apply, guard }));
  assert.equal(report.read_only, true);
  assert.equal(report.plan_hash, undefined);
  const dry = textOf(await runFmcViewAudit(args({ document: "A", fixes }), { read, apply, guard }));
  assert.equal(dry.fixes.ops.length, 2);
  const base = { document: "A", fixes, dry_run: false };
  assert.equal(textOf(await runFmcViewAudit(args({ ...base, plan_hash: dry.plan_hash, batch_lease: "l" }), { read, apply, guard })).code, "FMC-GAP-CONFIRM");
  assert.equal(textOf(await runFmcViewAudit(args({ ...base, confirm: true, batch_lease: "l" }), { read, apply, guard })).code, "FMC-GAP-DRY-RUN-FIRST");
  assert.equal(textOf(await runFmcViewAudit(args({ ...base, confirm: true, plan_hash: dry.plan_hash }), { read, apply, guard })).code, "FMC-BATCH-LOCKED");
  const other = textOf(await runFmcViewAudit(args({ ...base, fixes: [fixes[0]], confirm: true, plan_hash: dry.plan_hash, batch_lease: "l" }), { read, apply, guard }));
  assert.equal(other.code, "FMC-GAP-PLAN-CHANGED");
  assert.equal(textOf(await runFmcViewAudit(args({ ...base, confirm: true, plan_hash: dry.plan_hash, batch_lease: "l" }), { read: async () => ({ ...READ, is_central: true }), apply, guard })).code, "FMC-GAP-GUARD");
  assert.equal(applies, 0);
  const done = textOf(await runFmcViewAudit(args({ ...base, confirm: true, plan_hash: dry.plan_hash, batch_lease: "l" }), { read, apply, guard }));
  assert.equal(applies, 1);
  assert.equal(done.read_only, false);
  assert.equal(done.deleted, 0);
});

test("the view audit read is a read and the fix batch is a write", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_view_audit_read"));
  assert.ok(WRITE_COMMANDS.has("fmc_view_audit_apply"));
});
