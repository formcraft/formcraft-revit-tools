import { test } from "node:test";
import assert from "node:assert/strict";
import { auditWorksets, missingFromSet, preflight, standardSet, syncMessage, worksetNameProblems } from "./workshare.js";

test("workset names follow [Role]_[Content] with a real role code", () => {
  assert.deepEqual(worksetNameProblems("A_Facade"), []);
  assert.deepEqual(worksetNameProblems("Z_Links_S"), []);
  assert.match(worksetNameProblems("Workset1")[0], /doesn't follow \[Role\]_\[Content\]/);
  assert.match(worksetNameProblems("X_Facade")[0], /isn't a role code/);
  assert.equal(auditWorksets([{ id: 1, name: "Shared Levels and Grids", owner: "", open: true, editable: false, default_visible: true }])[0].problem.length > 0, true);
});

test("the standard set for an architectural model linking S and M", () => {
  assert.deepEqual(standardSet("A", ["S", "M", "A", "s"]), ["Z_Grids_Levels", "Z_Links_M", "Z_Links_S", "A_Shell", "A_Interior", "A_Site"]);
  assert.deepEqual(standardSet("Z", ["A"]), ["Z_Grids_Levels", "Z_Links_A"]);
  assert.deepEqual(missingFromSet(["z_grids_levels", "A_Shell"], standardSet("A", [])), ["A_Interior", "A_Site"]);
});

test("the sync message keeps the fixed format and never breaks it with a |", () => {
  assert.equal(syncMessage({ project: "F26001", role: "A", revision: "P02", worked: ["ISS-0014"], raised: ["ISS-0015"], what: "Beam B12 | reduced", who: "NAME B" }),
    "F26001 | A | P02 | Worked: ISS-0014 | New: ISS-0015 | Beam B12 / reduced | NAME B");
  assert.equal(syncMessage({ project: "", role: "", revision: "", worked: [], raised: [], what: "Walls", who: "" }), "PROJ | ? | No revision | Walls | ?");
});

test("preflight: advice, not a guarantee", () => {
  assert.equal(preflight({ workshared: false, central: "", central_reachable: null, cloud: false, warnings: 0, last_warnings: null, mine: [] })[0].state, "N/A");
  const p = preflight({ workshared: true, central: "Z:\\C.rvt", central_reachable: false, cloud: false, warnings: 12, last_warnings: 9, mine: ["A_Shell"] });
  assert.deepEqual(p.map((x) => x.state), ["Fail", "Warn", "Warn"]);
  assert.match(p[1].detail, /\+3/);
});
