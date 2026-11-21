import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { explain } from "./explain.js";
import { screenScript } from "./scriptguard.js";
import { batchHasExtent, MODIFY_MODEL_DESCRIPTION, MODEL_EDIT_OPS } from "../tools/modify_element.js";
import {
  KEYNOTE_SCRIPT, classifyKeynoteBatch, executeKeynoteBatch, keynoteCall, shapeKeynoteResult, validateKeynoteOps,
} from "./keynote.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const tag = { op: "tag", mode: "keynote_element", view: "A201", ids: [15, 16], tag_type: "M_Keynote Tag: Keynote Text", leader: true };

test("a keynote batch is its own call; a mix and a for_each are refused before Revit", async () => {
  assert.equal(classifyKeynoteBatch([tag]), "keynote");
  assert.equal(classifyKeynoteBatch([{ op: "create_wall" }]), "model");
  assert.equal(classifyKeynoteBatch([tag, { op: "text", view: "A201", text: "note" }]), "mixed");
  assert.equal(classifyKeynoteBatch([{ op: "for_each", per: "room", ops: [tag] }]), "for_each");
  const calls: string[] = [];
  const send = async (command: string) => { calls.push(command); return {}; };
  const mixed = await executeKeynoteBatch([tag, { op: "text" }], false, "Ogala", send);
  assert.equal(mixed?.isError, true);
  assert.match(String(mixed?.body.reason), /their own modify_model call/);
  const each = await executeKeynoteBatch([{ op: "for_each", ops: [tag] }], false, "Ogala", send);
  assert.match(String(each?.body.reason), /for_each/);
  assert.equal(await executeKeynoteBatch([{ op: "create_wall" }], false, "Ogala", send), null);
  assert.deepEqual(calls, []);
});

test("keynote ops are checked before a script is sent", () => {
  assert.match(validateKeynoteOps([{ op: "tag", mode: "keynote_user", view: "A201", ids: [1] }]) ?? "", /needs key/);
  assert.match(validateKeynoteOps([{ op: "tag", mode: "keynote_element", view: "A201" }]) ?? "", /ids or select/);
  assert.match(validateKeynoteOps([{ op: "place_schedule", sheet: "A201", schedule: "KN" }]) ?? "", /point_mm/);
  assert.equal(validateKeynoteOps([tag, { op: "keynote_legend", name: "A201 Keynotes", filtered_by_sheet: true },
    { op: "place_schedule", sheet: "$2", schedule: "A201 Keynotes", point_mm: [20, 280] }]), null);
});

test("the bridge script sets Key Source and keeps a tag only when it reads back", async () => {
  const call = keynoteCall([tag, { op: "keynote_legend", name: "A201 Keynotes", filtered_by_sheet: true },
    { op: "place_schedule", sheet: "A201", schedule: "$2", point_mm: [20, 280] }], true, "Ogala Residence");
  assert.equal(screenScript(call.code), null);
  assert.match(KEYNOTE_SCRIPT, /SetInternal/);
  assert.match(KEYNOTE_SCRIPT, /KEY_SOURCE_PARAM/);
  assert.match(KEYNOTE_SCRIPT, /AsValueString/);
  assert.match(KEYNOTE_SCRIPT, /document\.Delete\(tag\.Id\)/);
  assert.match(KEYNOTE_SCRIPT, /CreateKeynoteLegend/);
  assert.match(KEYNOTE_SCRIPT, /IsFilteredBySheet = true/);
  assert.match(KEYNOTE_SCRIPT, /ScheduleSheetInstance\.Create/);
  assert.doesNotMatch(KEYNOTE_SCRIPT, /ExportImage|picture/);
  const payload = JSON.parse(String((call.params.parameters as string[])[0]));
  assert.equal(payload.dry_run, true);
  assert.equal(payload.ops[0].one_per_key, true);
  assert.equal(payload.ops[0].leader, true);
  assert.equal(payload.ops[0].mode, "keynote_element");
  assert.equal(payload.ops[1].filtered_by_sheet, true);
  assert.equal(call.params.transactionMode, "read_only");
  assert.equal(call.params.dry_run, true);
  assert.equal(call.params.document, "Ogala Residence");
  const lines = explain("send_code_to_revit", call.params);
  assert.match(lines[0], /Dry run/);
  assert.match(lines[1], /Keynote tag \(Element\) in A201/);
  assert.match(lines[2], /Keynote legend "A201 Keynotes", filtered by sheet/);
  assert.match(lines[3], /Place \$2 on sheet A201/);
  assert.ok(lines.every((line) => !line.includes("SetInternal")));
  const real = keynoteCall([{ op: "tag", mode: "keynote_material", view: "A201", ids: [4], leader: false, one_per_key: false }], false);
  assert.equal(real.params.transactionMode, "auto");
  assert.equal(JSON.parse(String((real.params.parameters as string[])[0])).ops[0].leader, false);
});

test("select is resolved, then one script runs, and the answer is counts without a picture", async () => {
  const sent: Array<{ command: string; params: Record<string, unknown> }> = [];
  const out = await executeKeynoteBatch(
    [{ op: "tag", mode: "keynote_element", view: "A201", select: { category: "Walls" }, ids: [15], tag_type: "FMC_TAG_Keynote: Key" }],
    false,
    "A-0002",
    async (command, params) => {
      sent.push({ command, params });
      if (command === "fmc_select_by") return { ids: [15, 20] };
      return {
        success: true,
        undoId: "3a0112",
        document: { title: "A-0002", path: "Z:\\Ogala\\A-0002.rvt" },
        result: {
          applied: true,
          ops: [{
            kind: "tag", mode: "keynote_element", tagged: 1, created_ids: [88],
            skipped: [{ id: 20, key: "A.WAL_01", reason: "key already tagged in this view" }],
            counts: { created: 1, skipped: 1 },
          }],
          note: "kept",
        },
      };
    },
  );
  assert.deepEqual(sent.map((call) => call.command), ["fmc_select_by", "send_code_to_revit"]);
  assert.equal((sent[0].params as { category?: string }).category, "Walls");
  const payload = JSON.parse(String((sent[1].params.parameters as string[])[0]));
  assert.deepEqual(payload.ops[0].ids, [15, 20]);
  assert.equal(out?.isError, false);
  assert.equal(out?.body.applied, true);
  assert.equal(out?.body.batch_id, "3a0112");
  assert.equal((out?.body.document as { title: string }).title, "A-0002");
  const op = (out?.body.ops as Array<Record<string, unknown>>)[0];
  assert.deepEqual(op.counts, { created: 1, skipped: 1 });
  assert.deepEqual(op.created_ids, [88]);
  assert.equal((op.skipped as Array<{ reason: string }>)[0].reason, "key already tagged in this view");
  assert.equal(batchHasExtent([{ op: "tag" }, { op: "keynote_legend" }, { op: "place_schedule" }]), false);
  assert.ok(MODEL_EDIT_OPS.includes("keynote_legend") && MODEL_EDIT_OPS.includes("place_schedule"));
  assert.match(MODIFY_MODEL_DESCRIPTION, /keynote_element/);
  assert.match(MODIFY_MODEL_DESCRIPTION, /place_schedule/);
  assert.match(MODIFY_MODEL_DESCRIPTION, /create_stair/);
});

test("a rolled-back script is an error and does not claim the model changed", () => {
  const shaped = shapeKeynoteResult({ success: false, errorCode: "FMC-CODE-RUNTIME", errorMessage: "no view A201" }, false);
  assert.equal(shaped.isError, true);
  assert.equal(shaped.body.applied, false);
  assert.equal(shaped.body.rolled_back, true);
  assert.match(String(shaped.body.reason), /no view A201/);
});

test("FMC_TAG_Keynote is built from the Keynote Tag template with Key and Key+Text", () => {
  const spec = fs.readFileSync(path.join(root, "scripts", "kitbuild", "annotation", "tags_spec.py"), "utf8");
  const line = spec.split("\n").find((row) => row.includes('fam("FMC_TAG_Keynote"'));
  assert.ok(line, "FMC_TAG_Keynote is declared in tags_spec.py");
  assert.match(line!, /Metric Keynote Tag\.rft/);
  assert.doesNotMatch(line!, /Generic Tag/);
  assert.match(line!, /\["Key", "Key\+Text"\]/);
  assert.match(spec, /Show_Key": \[1, 1\], "Show_Text": \[0, 1\]/);
});
