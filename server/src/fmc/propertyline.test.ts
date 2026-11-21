import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { explain } from "./explain.js";
import { screenScript } from "./scriptguard.js";
import { batchHasExtent, MODIFY_MODEL_DESCRIPTION, MODEL_EDIT_OPS } from "../tools/modify_element.js";
import { FMC_INSTRUCTIONS } from "./mcp_context.js";
import {
  CODE_CREATE_PRESENT, CODE_NEEDS_HUMAN, CODE_NO_API, CODE_NO_TAG, HUMAN_STEPS, JOIN_MM, KIT_PROPERTY_LINE_TAG,
  PROPERTY_LINE_SCRIPTS, chainSegments, classifyPropertyBatch, executePropertyLineBatch, pointLoopProblems,
  propertyLineIsDry,
} from "./propertyline.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const square = [
  { id: "1", a: [0, 0, 0], b: [10000, 0, 0] },
  { id: "2", a: [10000, 0, 0], b: [10000, 5000, 0] },
  { id: "3", a: [10000, 5000, 0], b: [0, 5000, 0] },
  { id: "4", a: [0, 5000, 0], b: [0, 0, 0] },
] as const;

function curvesOf(rows: Array<{ id: number; start_mm: number[]; end_mm: number[]; kind?: string; owner_view?: string; missing?: boolean; rejected?: string }>) {
  return {
    success: true,
    document: { title: "Site", path: "D:\\WIP\\Site.rvt" },
    result: {
      create_api: false,
      revit: "2025",
      active_view: "Site",
      curves: rows.map((row) => ({ kind: "model", ...row })),
    },
  };
}

const squareCurves = curvesOf([
  { id: 3, start_mm: [10000, 5000, 0], end_mm: [0, 5000, 0] },
  { id: 1, start_mm: [0, 0, 0], end_mm: [10000, 0, 0] },
  { id: 4, start_mm: [0, 0, 0], end_mm: [0, 5000, 0] },
  { id: 2, start_mm: [10000, 5000, 0], end_mm: [10000, 0, 0] },
]);

test("a closed loop chains in order, a gap, a branch and a slope do not", () => {
  const chain = chainSegments(square.map((seg) => ({ ...seg, a: [...seg.a], b: [...seg.b] })), true);
  assert.equal(chain.ok, true);
  if (chain.ok) {
    assert.equal(chain.closed, true);
    assert.deepEqual(chain.order, ["1", "2", "3", "4"]);
  }
  const gap = chainSegments([
    { id: "1", a: [0, 0, 0], b: [1000, 0, 0] },
    { id: "2", a: [1000 + JOIN_MM + 1, 0, 0], b: [2000, 0, 0] },
  ], false);
  assert.equal(gap.ok, false);
  if (!gap.ok) assert.match(gap.problems[0], /not one contiguous chain/);
  const branch = chainSegments([
    { id: "1", a: [0, 0, 0], b: [1000, 0, 0] },
    { id: "2", a: [1000, 0, 0], b: [2000, 0, 0] },
    { id: "3", a: [1000, 0, 0], b: [1000, 1000, 0] },
  ], false);
  assert.equal(branch.ok, false);
  if (!branch.ok) assert.match(branch.problems[0], /more than one line/);
  const open = chainSegments(square.slice(0, 3).map((seg) => ({ ...seg, a: [...seg.a], b: [...seg.b] })), true);
  assert.equal(open.ok, false);
  if (!open.ok) assert.match(open.problems[0], /do not close/);
  const slope = chainSegments([
    { id: "1", a: [0, 0, 0], b: [1000, 0, 0] },
    { id: "2", a: [1000, 0, 0], b: [1000, 0, 50] },
  ], false);
  assert.equal(slope.ok, false);
  if (!slope.ok) assert.match(slope.problems[0], /horizontal/);
});

test("points_mm is checked for a closed horizontal chain and never becomes a create", () => {
  assert.deepEqual(pointLoopProblems([[0, 0], [30000, 0], [30000, 20000], [0, 20000]], true), []);
  assert.deepEqual(pointLoopProblems([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 0, 0]], true), []);
  assert.match(pointLoopProblems([[0, 0], [10, 0]], true)[0], /at least 3/);
  assert.match(pointLoopProblems([[0, 0, 0], [10, 0, 20], [10, 10, 0]], true).join(" "), /horizontal/);
  assert.equal(propertyLineIsDry({ op: "property_line" }, false), true);
  assert.equal(propertyLineIsDry({ op: "property_line", dry_run: false }, false), false);
  assert.equal(propertyLineIsDry({ op: "property_line", dry_run: false }, true), true);
});

test("points_mm fails closed with FMC-NO-API-PROPERTYLINE and does not call Revit", async () => {
  const calls: string[] = [];
  const send = async (command: string) => { calls.push(command); return {}; };
  const good = await executePropertyLineBatch(
    [{ op: "property_line", points_mm: [[0, 0], [30000, 0], [30000, 20000], [0, 20000]], closed: true, level: "Site ±0.00", name: "Plot A" }],
    false, "Site", send,
  );
  assert.equal(good?.isError, true);
  assert.equal(good?.body.code, CODE_NO_API);
  assert.equal(good?.body.created, false);
  assert.equal(good?.body.created_id, null);
  assert.equal(good?.body.posted, false);
  assert.equal(good?.body.level_applied, false);
  assert.equal(good?.body.name_applied, false);
  assert.match(String(good?.body.reason), /2027/);
  const bad = await executePropertyLineBatch(
    [{ op: "property_line", points_mm: [[0, 0], [10, 0]], from_ids: [1] }],
    false, "Site", send,
  );
  assert.equal(bad?.body.code, CODE_NO_API);
  assert.match(String(bad?.body.reason), /not both/);
  assert.deepEqual(calls, []);
});

test("from_ids stays a dry run unless the op sets dry_run false, and the lines are kept", async () => {
  const sent: Array<{ command: string; params: Record<string, unknown> }> = [];
  const send = async (command: string, params: Record<string, unknown>) => {
    sent.push({ command, params });
    if (command === "fmc_select_by") return { ids: [2] };
    if (command === "send_code_to_revit") return squareCurves;
    return { started: "PropertyLine", selected: [1, 2, 3, 4] };
  };
  const dry = await executePropertyLineBatch(
    [{ op: "property_line", from_ids: [3, 1, 4], select: { category: "Lines" }, keep_source: false }],
    false, "Site", send,
  );
  assert.equal(dry?.isError, false);
  assert.equal(dry?.body.code, CODE_NEEDS_HUMAN);
  assert.equal(dry?.body.posted, false);
  assert.equal(dry?.body.created, false);
  assert.equal(dry?.body.source_kept, true);
  assert.deepEqual(dry?.body.delete_after_verify, [3, 1, 4, 2]);
  assert.equal(dry?.body.addin_rebuild, false);
  assert.match(String(dry?.body.instructions), /Create by sketching/);
  assert.deepEqual(sent.map((call) => call.command), ["fmc_select_by", "send_code_to_revit"]);
  assert.equal(sent[1].params.transactionMode, "read_only");
  assert.equal(sent[1].params.dry_run, true);
  assert.equal(screenScript(String(sent[1].params.code)), null);
  const lines = explain("send_code_to_revit", sent[1].params);
  assert.match(lines.join("\n"), /Nothing is posted/);
  assert.ok(lines.every((line) => !line.includes("PropertyLine.Create") && !line.includes("GetMethods")));

  sent.length = 0;
  const apply = await executePropertyLineBatch(
    [{ op: "property_line", from_ids: [1, 2, 3, 4], dry_run: false, keep_source: true }],
    false, "Site", send,
  );
  assert.equal(apply?.isError, true);
  assert.equal(apply?.body.code, CODE_NEEDS_HUMAN);
  assert.equal(apply?.body.posted, true);
  assert.equal(apply?.body.created, false);
  assert.equal(apply?.body.created_id, null);
  assert.equal(apply?.body.source_kept, true);
  assert.equal(apply?.body.keep_source, true);
  assert.equal(apply?.body.command, "PropertyLine");
  assert.deepEqual(apply?.body.selected, [1, 2, 3, 4]);
  assert.equal(apply?.body.instructions, HUMAN_STEPS);
  assert.deepEqual(sent.map((call) => call.command), ["send_code_to_revit", "fmc_post_command"]);
  assert.equal(sent[1].params.command, "PropertyLine");
  assert.deepEqual(sent[1].params.select_ids, [3, 4, 1, 2]);
});

test("a gap, a detail line in another view, and a Revit that already has Create do not post the command", async () => {
  const commands: string[] = [];
  const send = async (command: string) => {
    commands.push(command);
    return curvesOf([
      { id: 1, start_mm: [0, 0, 0], end_mm: [1000, 0, 0] },
      { id: 2, start_mm: [2000, 0, 0], end_mm: [3000, 0, 0] },
    ]);
  };
  const gap = await executePropertyLineBatch(
    [{ op: "property_line", from_ids: [1, 2], dry_run: false, closed: false }],
    false, "Site", send,
  );
  assert.equal(gap?.body.posted, false);
  assert.match(String(gap?.body.reason), /contiguous/);
  assert.deepEqual(commands, ["send_code_to_revit"]);

  commands.length = 0;
  const sendDetail = async (command: string) => {
    commands.push(command);
    return curvesOf([
      { id: 1, kind: "detail", owner_view: "Sheet detail", start_mm: [0, 0, 0], end_mm: [1000, 0, 0] },
      { id: 2, kind: "detail", owner_view: "Sheet detail", start_mm: [1000, 0, 0], end_mm: [0, 0, 0] },
    ]);
  };
  const detail = await executePropertyLineBatch(
    [{ op: "property_line", from_ids: [1, 2], dry_run: false, closed: false }],
    false, "Site", sendDetail,
  );
  assert.equal(detail?.body.posted, false);
  assert.match(String(detail?.body.reason), /Open Sheet detail/);
  assert.deepEqual(commands, ["send_code_to_revit"]);

  const present = await executePropertyLineBatch(
    [{ op: "property_line", from_ids: [1, 2, 3, 4], dry_run: false }],
    false, "Site", async () => ({ success: true, result: { ...squareCurves.result, create_api: true, revit: "2027" } }),
  );
  assert.equal(present?.body.code, CODE_CREATE_PRESENT);
  assert.equal(present?.body.posted, false);
  assert.equal(present?.body.created, false);
});

test("a batch that mixes property lines with other ops is refused before Revit", async () => {
  assert.equal(classifyPropertyBatch([{ op: "property_line" }]), "property");
  assert.equal(classifyPropertyBatch([{ op: "create_wall" }]), "none");
  assert.equal(classifyPropertyBatch([{ op: "property_line" }, { op: "model_line" }]), "mixed");
  assert.equal(classifyPropertyBatch([{ op: "for_each", ops: [{ op: "property_line" }] }]), "for_each");
  const calls: string[] = [];
  const send = async (command: string) => { calls.push(command); return {}; };
  const mixed = await executePropertyLineBatch([{ op: "property_line", from_ids: [1] }, { op: "model_line" }], false, "Site", send);
  assert.match(String(mixed?.body.reason), /their own modify_model call/);
  const each = await executePropertyLineBatch([{ op: "for_each", ops: [{ op: "property_line_verify" }] }], false, "Site", send);
  assert.match(String(each?.body.reason), /for_each/);
  assert.equal(await executePropertyLineBatch([{ op: "create_wall" }], false, "Site", send), null);
  const batchDry = await executePropertyLineBatch(
    [{ op: "property_line", from_ids: [1, 2, 3, 4], dry_run: false }],
    true, "Site", async (command: string) => {
      calls.push(command);
      return squareCurves;
    },
  );
  assert.equal(batchDry?.body.posted, false);
  assert.equal(calls.at(-1), "send_code_to_revit");
  assert.ok(!calls.includes("fmc_post_command"));
});

test("verify reports segments and deletes source lines only after a new property line exists", async () => {
  const propertyLines = {
    success: true,
    result: {
      create_api: false,
      revit: "2025",
      property_line_segment_type: { found: true, public_properties: ["Id", "Name"], curve: false, bearing: false, distance: false },
      property_lines: [
        { id: 10, name: "Old", segment_count: 4, segments_from: "category", segments: [{ id: 11, distance_mm: 30000, bearing_shown: "N 0°0' E" }] },
        { id: 20, name: "New", segment_count: 4, segments_from: "category", segments: [{ id: 21, distance_mm: 12000, bearing_shown: "N 90°0' E", curve: { start_mm: [0, 0, 0], end_mm: [12000, 0, 0] } }] },
      ],
      unmatched_segments: [],
    },
  };
  const sent: Array<{ command: string; params: Record<string, unknown> }> = [];
  const send = async (command: string, params: Record<string, unknown>) => {
    sent.push({ command, params });
    if (String(params.code).includes("document.Delete")) return { success: true, result: { deleted_ids: [1, 2], missing_ids: [] } };
    return propertyLines;
  };
  const read = await executePropertyLineBatch(
    [{ op: "property_line_verify", known_ids: [10] }],
    false, "Site", send,
  );
  assert.equal(read?.isError, false);
  assert.deepEqual(read?.body.new_ids, [20]);
  assert.equal(read?.body.created_id, 20);
  assert.equal(read?.body.segment_count, 4);
  assert.equal(read?.body.source_kept, true);
  assert.equal((read?.body.segment_members as { curve: boolean }).curve, false);
  assert.equal((read?.body.segment_members as { bearing: boolean }).bearing, false);
  assert.equal((read?.body.segment_members as { distance: boolean }).distance, false);
  assert.equal(sent[0].params.transactionMode, "read_only");

  sent.length = 0;
  const kept = await executePropertyLineBatch(
    [{ op: "property_line", action: "verify", known_ids: [10, 20], delete_source_ids: [1, 2], dry_run: false }],
    false, "Site", send,
  );
  assert.equal(kept?.isError, true);
  assert.equal(kept?.body.source_kept, true);
  assert.deepEqual(sent.map((call) => call.command), ["send_code_to_revit"]);

  sent.length = 0;
  const dropped = await executePropertyLineBatch(
    [{ op: "property_line_verify", known_ids: [10], delete_source_ids: [1, 2], dry_run: false }],
    false, "Site", send,
  );
  assert.equal(dropped?.isError, false);
  assert.equal(dropped?.body.source_kept, false);
  assert.deepEqual(dropped?.body.deleted_ids, [1, 2]);
  assert.equal(dropped?.body.created, false);
  assert.deepEqual(sent.map((call) => call.command), ["send_code_to_revit", "send_code_to_revit"]);
  assert.equal(sent[1].params.transactionMode, "auto");
  assert.equal(sent[1].params.dry_run, false);
  const payload = JSON.parse(String((sent[1].params.parameters as string[])[0]));
  assert.deepEqual(payload.ids, [1, 2]);
});

test("the scripts do not call PropertyLine.Create, and the kit has no property-line tag", () => {
  for (const code of Object.values(PROPERTY_LINE_SCRIPTS)) {
    assert.equal(screenScript(code), null);
    assert.doesNotMatch(code, /PropertyLine\.Create\s*\(/);
    assert.doesNotMatch(code, /PostCommand|UIAutomation|SendKeys/);
  }
  assert.match(PROPERTY_LINE_SCRIPTS.verify, /PROPERTY_SEGMENT_BEARING/);
  assert.match(PROPERTY_LINE_SCRIPTS.verify, /PROPERTY_SEGMENT_DISTANCE/);
  assert.match(PROPERTY_LINE_SCRIPTS.verify, /PropertyLineSegment/);
  assert.match(PROPERTY_LINE_SCRIPTS.tag, /IndependentTag\.Create/);
  assert.match(PROPERTY_LINE_SCRIPTS.tag, new RegExp(CODE_NO_TAG));
  assert.match(PROPERTY_LINE_SCRIPTS.tag, /OST_SitePropertyLineSegmentTags/);
  const deleteAt = PROPERTY_LINE_SCRIPTS.deleteSource.indexOf("document.Delete");
  const guardAt = PROPERTY_LINE_SCRIPTS.deleteSource.indexOf("is PropertyLine");
  assert.ok(guardAt >= 0 && guardAt < deleteAt);
  const spec = fs.readFileSync(path.join(root, "scripts", "kitbuild", "annotation", "tags_spec.py"), "utf8");
  assert.doesNotMatch(spec, /SiteProperty|Property Line Tag|property line/i);
  assert.match(KIT_PROPERTY_LINE_TAG, /no property-line tag family/);
  assert.ok(MODEL_EDIT_OPS.includes("property_line"));
  assert.ok(MODEL_EDIT_OPS.includes("property_line_verify"));
  assert.ok(MODEL_EDIT_OPS.includes("property_line_tag"));
  assert.equal(batchHasExtent([{ op: "property_line" }, { op: "property_line_verify" }, { op: "property_line_tag" }]), false);
  assert.match(MODIFY_MODEL_DESCRIPTION, /FMC-NO-API-PROPERTYLINE/);
  assert.match(MODIFY_MODEL_DESCRIPTION, /FMC-NEEDS-HUMAN/);
  assert.match(MODIFY_MODEL_DESCRIPTION, /Create by sketching/);
  assert.match(FMC_INSTRUCTIONS, /never PropertyLine\.Create/);
  assert.ok(FMC_INSTRUCTIONS.split(/\s+/).filter(Boolean).length < 400);
});

test("a missing tag type is an error and does not claim a kit family", async () => {
  const out = await executePropertyLineBatch(
    [{ op: "property_line_tag", view: "Site", ids: [21], dry_run: false }],
    false, "Site",
    async () => ({ success: false, errorCode: "FMC-CODE-RUNTIME", errorMessage: `${CODE_NO_TAG}: no Site Property Line Segment tag is loaded.` }),
  );
  assert.equal(out?.isError, true);
  assert.equal(out?.body.code, CODE_NO_TAG);
  assert.equal(out?.body.kit_tag_family, null);
  assert.equal(out?.body.created, false);
  assert.match(String(out?.body.kit_note), /tags_spec.py/);
});
