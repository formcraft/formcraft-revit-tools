import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { FAM_DELETE_OPS, OP, OPS, opsProblems, splitProblems } from "./ops.js";
import { SpParam } from "./specs.js";
import { TOKEN_HOURS, confirmProblems, confirmToken, deleteLines, deleteOpsIn, matrixSummary, paramOps, refOps, stableJson, typeOps } from "./famedit.js";

const dict = new Map<string, SpParam>([["FMC_Keynote_Code", { name: "FMC_Keynote_Code", guid: "1111-AAAA", datatype: "TEXT", group: "FMC_Identity" }]]);
const errors = (ops: unknown[]) => splitProblems(opsProblems(OPS.parse(ops), dict)).errors;

test("the op layout parses as promised (names and fields)", () => {
  const ok = [
    { op: "param_rename", name: "Width", new_name: "Overall Width" }, { op: "param_regroup", name: "Width", group: "Constraints" },
    { op: "param_set_reporting", name: "Width", on: true }, { op: "param_set_formula", name: "Width", formula: "Depth * 2" },
    { op: "param_set_formula", name: "Width", formula: null }, { op: "param_remove", name: "Old" },
    { op: "type_rename", name: "A", new_name: "B" }, { op: "type_flex_matrix", params: ["Width"], ranges: { Width: { low: 300, high: 900 } } },
    { op: "type_delete", name: "A" }, { op: "plane_rename", name: "Left", new_name: "Side L" }, { op: "plane_rename", id: 12345, new_name: "Head" },
    { op: "plane_move", name: "Left", offset_mm: -50 }, { op: "plane_delete", id: 77 },
  ];
  for (const o of ok) assert.ok(OP.safeParse(o).success, JSON.stringify(o));
  assert.ok(!OP.safeParse({ op: "param_rename", name: "Width" }).success, "new_name is required");
  assert.ok(!OP.safeParse({ op: "param_set_reporting", name: "Width" }).success, "on is required");
  assert.ok(!OP.safeParse({ op: "param_regroup", name: "Width", group: "Nowhere" }).success, "group from the list");
  assert.ok(!OP.safeParse({ op: "plane_move", name: "Left" }).success, "offset_mm is required");
  const m = OP.parse({ op: "type_flex_matrix", params: ["Width"], ranges: { Width: { low: 300, high: 900 } } }) as any;
  assert.equal(m.ranges.Width.steps, 3);
  assert.equal(m.name, "flex matrix");
});

test("exactly three ops are deletes", () => {
  assert.deepEqual([...FAM_DELETE_OPS].sort(), ["param_remove", "plane_delete", "type_delete"]);
  assert.deepEqual(deleteOpsIn([{ op: "param_rename" }, { op: "param_remove" }, { op: "plane_delete" }]).map((o) => o.op), ["param_remove", "plane_delete"]);
});

test("a clean family editor batch has no errors", () => {
  assert.deepEqual(errors([{ op: "param_rename", name: "Width", new_name: "W2" }, { op: "param_regroup", name: "W2", group: "Constraints" },
    { op: "type_rename", name: "A", new_name: "B" }, { op: "plane_move", name: "Left", offset_mm: 10 }]), []);
});

test("parameter checks: kit shared names, same name, use after remove, reporting only on dimensions", () => {
  assert.match(errors([{ op: "param_rename", name: "FMC_Keynote_Code", new_name: "X" }])[0], /kit shared parameter/);
  assert.match(errors([{ op: "param_rename", name: "Width", new_name: "FMC_Keynote_Code" }])[0], /kit shared parameter's name/);
  assert.match(errors([{ op: "param_rename", name: "Width", new_name: "Width" }])[0], /same as the old/);
  assert.match(errors([{ op: "param_remove", name: "Old" }, { op: "param_set_formula", name: "Old", formula: "1" }])[0], /removed earlier/);
  assert.match(errors([{ op: "param_remove", name: "Old" }, { op: "param_remove", name: "Old" }]).join("\n"), /removed twice/);
  assert.match(errors([{ op: "add_family_param", name: "Has", type: "YesNo" }, { op: "param_set_reporting", name: "Has", on: true }])[0], /only a dimension-type/);
  assert.deepEqual(errors([{ op: "add_family_param", name: "Has", type: "YesNo" }, { op: "param_set_reporting", name: "Has", on: false }]), []);
  assert.match(errors([{ op: "param_set_formula", name: "W", formula: "   " }])[0], /blank formula/);
});

test("type checks: rename to itself, delete twice, rename after delete", () => {
  assert.match(errors([{ op: "type_rename", name: "A", new_name: "A" }])[0], /same as the old/);
  assert.match(errors([{ op: "type_delete", name: "A" }, { op: "type_delete", name: "A" }]).join("\n"), /deleted twice/);
  assert.match(errors([{ op: "type_delete", name: "A" }, { op: "type_rename", name: "A", new_name: "C" }])[0], /deleted earlier/);
});

test("type_flex_matrix is a read on its own, with a range per parameter", () => {
  const fm = { op: "type_flex_matrix", params: ["Width"], ranges: { Width: { low: 300, high: 900 } } };
  assert.deepEqual(errors([fm]), []);
  assert.match(errors([fm, { op: "type_rename", name: "A", new_name: "B" }]).join("\n"), /on its own/);
  assert.match(errors([{ op: "type_flex_matrix", params: ["Width", "Depth"], ranges: { Width: { low: 300, high: 900 } } }])[0], /no range for "Depth"/);
  assert.match(errors([{ op: "type_flex_matrix", params: ["Width"], ranges: { Width: { low: 900, high: 300 } } }])[0], /high above low/);
  assert.match(errors([{ op: "type_flex_matrix", params: ["Width"], ranges: { Width: { low: 1, high: 2 }, Depth: { low: 1, high: 2 } } }])[0], /isn't in params/);
});

test("plane checks: origin planes are never touched; name or id, not both; offset 0", () => {
  for (const op of ["plane_rename", "plane_move", "plane_delete"]) {
    const e = errors([{ op, name: "Center (Left/Right)", new_name: "X", offset_mm: 5 }]);
    assert.match(e.join("\n"), /holds the family's origin/, op);
  }
  assert.match(errors([{ op: "plane_delete" }])[0], /name the plane/);
  assert.match(errors([{ op: "plane_delete", name: "Left", id: 5 }])[0], /not both/);
  assert.match(errors([{ op: "plane_move", name: "Left", offset_mm: 0 }])[0], /moves nothing/);
  assert.match(errors([{ op: "plane_rename", name: "Left", new_name: "Ref. Level" }])[0], /origin plane's name/);
  assert.match(errors([{ op: "plane_delete", id: 9 }, { op: "plane_move", id: 9, offset_mm: 3 }])[0], /deleted earlier/);
  assert.deepEqual(errors([{ op: "plane_delete", id: 9 }, { op: "plane_delete", id: 10 }]), []);
});

test("builders: each action becomes its op; missing fields refuse", () => {
  assert.deepEqual(paramOps({ action: "rename", name: "W", new_name: "X" }), { ops: [{ op: "param_rename", name: "W", new_name: "X" }] });
  assert.deepEqual(paramOps({ action: "formula", name: "W", formula: null }), { ops: [{ op: "param_set_formula", name: "W", formula: null }] });
  assert.deepEqual(paramOps({ action: "reporting", name: "W", on: false }), { ops: [{ op: "param_set_reporting", name: "W", on: false }] });
  assert.deepEqual(paramOps({ action: "remove", name: "W" }), { ops: [{ op: "param_remove", name: "W" }] });
  assert.ok("refused" in paramOps({ action: "rename", name: "W" }));
  assert.ok("refused" in paramOps({ action: "formula", name: "W" }));
  assert.ok("refused" in paramOps({ action: "regroup", name: "W" }));
  assert.deepEqual(typeOps({ action: "delete", name: "A" }), { ops: [{ op: "type_delete", name: "A" }] });
  const fm = typeOps({ action: "flex_matrix", params: ["W"], ranges: { W: { low: 1, high: 2 } } }) as any;
  assert.equal(fm.ops[0].ranges.W.steps, 3);
  assert.ok("refused" in typeOps({ action: "flex_matrix", params: ["W"] }));
  assert.deepEqual(refOps({ action: "move", id: 5, offset_mm: 20 }), { ops: [{ op: "plane_move", name: "", id: 5, offset_mm: 20 }] });
  assert.deepEqual(refOps({ action: "delete", name: "Left" }), { ops: [{ op: "plane_delete", name: "Left" }] });
  assert.ok("refused" in refOps({ action: "delete" }));
  // every built op passes the op schema
  for (const b of [paramOps({ action: "regroup", name: "W", group: "Data" }), typeOps({ action: "rename", name: "A", new_name: "B" }), refOps({ action: "rename", id: 3, new_name: "Head" })])
    for (const o of (b as any).ops) assert.ok(OP.safeParse(o).success, JSON.stringify(o));
});

test("the confirm token is bound to the session and the exact ops, not key order", () => {
  const ops = [{ op: "param_remove", name: "Old" }];
  assert.equal(confirmToken("s1", ops), confirmToken("s1", [{ name: "Old", op: "param_remove" }]));
  assert.notEqual(confirmToken("s1", ops), confirmToken("s2", ops));
  assert.notEqual(confirmToken("s1", ops), confirmToken("s1", [{ op: "param_remove", name: "Other" }]));
  assert.equal(stableJson({ b: 1, a: [{ d: 2, c: 1 }] }), '{"a":[{"c":1,"d":2}],"b":1}');
});

test("confirmProblems: no token, unknown token, other ops, other session, expired", () => {
  const ops = [{ op: "type_delete", name: "A" }];
  const token = confirmToken("s1", ops);
  const now = new Date("2026-11-28T12:00:00Z");
  const p = { token, session: "s1", document: "", created: "2026-11-28T11:00:00Z", ops, plan: [] };
  assert.deepEqual(confirmProblems(p, token, "s1", ops, now), []);
  assert.match(confirmProblems(p, "", "s1", ops, now)[0], /dry run first/);
  assert.match(confirmProblems(null, token, "s1", ops, now)[0], /No plan/);
  assert.match(confirmProblems(p, token, "s1", [{ op: "type_delete", name: "B" }], now).join(), /other ops/);
  assert.match(confirmProblems(p, token, "s2", ops, now).join(), /for session s1/);
  assert.match(confirmProblems(p, token, "s1", ops, new Date(Date.parse(p.created) + (TOKEN_HOURS + 1) * 3600000)).join(), /older than/);
});

test("person lines say what goes, with Revit's plan", () => {
  const lines = deleteLines([{ op: "param_remove", name: "Old" }, { op: "type_rename", name: "A", new_name: "B" }, { op: "plane_delete", name: "", id: 9 }],
    [{ op: "param_remove", name: "Old", result: "delete", detail: "also clears 1 label" }]);
  assert.deepEqual(lines, ['Remove family parameter "Old": also clears 1 label', "Delete reference plane #9"]);
});

test("matrix summary lists each failing type and value", () => {
  assert.deepEqual(matrixSummary({ types: [{ type: "A", runs: [{ param: "W", value: 300, ok: true }, { param: "W", value: 900, ok: false, errors: ["constraints not satisfied"] }] }] }),
    { ok: false, failing: ["A: W = 900 (constraints not satisfied)"] });
  assert.deepEqual(matrixSummary({ types: [] }), { ok: true, failing: [] });
});

// ---- the gate in fmc_doc apply and the wrappers (no Revit: every path below answers before Revit is called) ----------

test("fmc_doc apply: a real delete needs the dry run's token, then only queues it for a person; it never runs", async () => {
  const { FMC_DOC_SHAPE, runFmcDoc } = await import("../tools/fmc_doc.js");
  const { loadConfig, expandEnv } = await import("./policy.js");
  const { saveProposal } = await import("./famedit.js");
  const { readItem, setStatus } = await import("./aiuse_io.js");
  const call = async (a: Record<string, unknown>) => { const r: any = await runFmcDoc(z.object(FMC_DOC_SHAPE).parse(a)); return { err: r.isError, body: JSON.parse(r.content[0].text) }; };
  const ops = [{ op: "type_delete", name: "Old type" }];
  const none = await call({ action: "apply", session: "fe01", ops, dry_run: false });
  assert.equal(none.err, true);
  assert.match(none.body.reasons[0], /dry run first/);
  const bad = await call({ action: "apply", session: "fe01", ops, dry_run: false, confirm_token: "0123456789abcdef" });
  assert.match(bad.body.reasons[0], /No plan/);
  // the dry run would save this proposal (it needs Revit for the plan); write it as the dry run does
  const reports = expandEnv(loadConfig().config.reports_dir);
  const parsed = OPS.parse(ops);
  const token = confirmToken("fe01", parsed);
  saveProposal(reports, { token, session: "fe01", document: "", created: new Date().toISOString(), ops: parsed, plan: [{ op: "type_delete", name: "Old type", result: "delete", detail: "2 types left" }] },
    (f, t) => { fs.mkdirSync(path.win32.dirname(f).replace(/\\/g, path.sep), { recursive: true }); fs.writeFileSync(f.replace(/\\/g, path.sep), t); });
  if (path.sep === "/") return; // the proposal path is a Windows path: the queue half runs on Windows (crafty27, CI)
  const q = await call({ action: "apply", session: "fe01", ops, dry_run: false, confirm_token: token });
  assert.equal(q.body.queued, true, JSON.stringify(q.body));
  assert.equal(q.body.status, "pending");
  assert.deepEqual(q.body.person_lines, ['Delete family type "Old type": 2 types left']);
  const again = await call({ action: "apply", session: "fe01", ops, dry_run: false, confirm_token: token });
  assert.equal(again.body.approval_id, q.body.approval_id, "the same batch keeps its queue item");
  assert.equal(readItem(q.body.approval_id)?.status, "pending");
  setStatus(q.body.approval_id, "used", "Emlyn");
  const ran = await call({ action: "apply", session: "fe01", ops, dry_run: false, confirm_token: token });
  assert.equal(ran.body.queued, false);
  assert.match(ran.body.next, /already ran/);
});
