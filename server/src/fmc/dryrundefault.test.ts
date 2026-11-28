import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { MODIFY_MODEL_DESCRIPTION, MODIFY_MODEL_DRY_RUN_DEFAULT, registerModifyModelTool } from "../tools/modify_element.js";
import { ANNOTATE_INCOMPLETE, ANNOTATE_NOT_CHECKED, AnnotationCheck, annotationVerdict, checkAnnotation } from "./annotation.js";

function modifyShape(): Record<string, z.ZodTypeAny> {
  const shapes = new Map<string, Record<string, z.ZodTypeAny>>();
  registerModifyModelTool({ tool: (name: string, _d: string, shape: Record<string, z.ZodTypeAny>) => { shapes.set(name, shape); } } as never);
  return shapes.get("modify_model")!;
}

test("(g) modify_model: dry_run defaults to true; an explicit false still applies", () => {
  assert.equal(MODIFY_MODEL_DRY_RUN_DEFAULT, true);
  const schema = z.object(modifyShape());
  const ops = [{ op: "delete", ids: [1] }];
  assert.equal(schema.parse({ ops }).dry_run, true, "omitted means a preview");
  assert.equal(schema.parse({ ops, dry_run: false }).dry_run, false);
  assert.equal(schema.parse({ ops, dry_run: true }).dry_run, true);
  assert.match(MODIFY_MODEL_DESCRIPTION, /dry_run defaults to TRUE/);
  assert.match(MODIFY_MODEL_DESCRIPTION, /pass dry_run false to apply/);
});

const check = (state: AnnotationCheck["state"], name = "c"): AnnotationCheck => ({ check: name, found: state === "Fail" ? 1 : 0, state, items: [], ids: [] });

test("(h) annotationVerdict: all Not checked is Not checked with a code and an error, never Pass", () => {
  const unreadable = checkAnnotation({ model: "m", text_types: [], line_patterns: [], dimension_types: [], tag_families: [] }, null);
  assert.equal(unreadable.length, 4);
  assert.ok(unreadable.every((c) => c.state === "Not checked"));
  const v = annotationVerdict(unreadable);
  assert.equal(v.status, "Not checked");
  assert.equal(v.code, ANNOTATE_NOT_CHECKED);
  assert.equal(v.code, "FMC-ANNOTATE-NOT-CHECKED");
  assert.equal(v.is_error, true);
  assert.match(v.message ?? "", /not a pass/i);
  assert.match(v.message ?? "", /isn't readable/);
  assert.equal(annotationVerdict([]).status, "Not checked");
});

test("(h) annotationVerdict: failures win, partial is Incomplete, proposed and pass stay as they were", () => {
  assert.deepEqual(annotationVerdict([check("Pass"), check("Pass")]), { status: "Pass", is_error: false });
  assert.equal(annotationVerdict([check("Pass"), check("Proposed")]).status, "Proposed");
  assert.equal(annotationVerdict([check("Pass"), check("Fail")]).status, "Fail");
  assert.equal(annotationVerdict([check("Not checked"), check("Fail")]).status, "Fail");
  const partial = annotationVerdict([check("Pass", "Text types"), check("Not checked", "Dimension types")]);
  assert.equal(partial.status, "Incomplete");
  assert.equal(partial.code, ANNOTATE_INCOMPLETE);
  assert.equal(partial.is_error, false);
  assert.match(partial.message ?? "", /Dimension types/);
});
