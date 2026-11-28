import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

// fmc_fam_param, fmc_fam_type and fmc_fam_ref are thin wrappers over fmc_doc ops: every path below answers before Revit.
test("wrappers refuse before Revit: missing fields, and a real delete without a token", async () => {
  const { FMC_FAM_PARAM_SHAPE, runFmcFamParam } = await import("../tools/fmc_fam_param.js");
  const { FMC_FAM_TYPE_SHAPE, runFmcFamType } = await import("../tools/fmc_fam_type.js");
  const { FMC_FAM_REF_SHAPE, runFmcFamRef } = await import("../tools/fmc_fam_ref.js");
  const body = (r: any) => ({ err: r.isError, b: JSON.parse(r.content[0].text) });
  const a = body(await runFmcFamParam(z.object(FMC_FAM_PARAM_SHAPE).parse({ action: "rename", session: "s", name: "W" })));
  assert.equal(a.err, true); assert.match(a.b.reasons[0], /new_name/);
  const d = body(await runFmcFamParam(z.object(FMC_FAM_PARAM_SHAPE).parse({ action: "remove", session: "s", name: "W", dry_run: false })));
  assert.equal(d.err, true); assert.match(d.b.reasons[0], /dry run first/); assert.equal(d.b.tool, "fmc_fam_param");
  const t = body(await runFmcFamType(z.object(FMC_FAM_TYPE_SHAPE).parse({ action: "delete", session: "s", name: "A", dry_run: false })));
  assert.match(t.b.reasons[0], /dry run first/);
  const p = body(await runFmcFamRef(z.object(FMC_FAM_REF_SHAPE).parse({ action: "delete", session: "s", name: "Center (Front/Back)", dry_run: false })));
  assert.match(p.b.reasons.join(), /origin/);
  const pd = body(await runFmcFamRef(z.object(FMC_FAM_REF_SHAPE).parse({ action: "delete", session: "s", id: 42, dry_run: false })));
  assert.match(pd.b.reasons[0], /dry run first/);
});
