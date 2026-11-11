import { test } from "node:test";
import assert from "node:assert/strict";
import { WRITE_COMMANDS } from "./policy.js";
import { writeGuard } from "./opencopy.js";
import { DEFAULT_CONFIG } from "./policy.js";
import {
  B3_BEAM_1666251_ROW, B7_NEW_CF1_ROW, B7_PEDESTAL_ROW, KEYNOTE_RE, REPLACE_DELETION_PASS, REPLACE_ROW, REPLACE_ROWS,
  REPLACE_TRANSACTION_MODEL, REPLACE_TRANSACTION_REASON, replaceProblems,
} from "./replace.js";

const copy = "C:\\Users\\USER\\agent-tools\\ogala-R04\\F26901-FMC-ZZ-ZZ-M3-S-0001-B3B7-preview.rvt";
const live = "D:\\Fomcraft\\FMC_PROJECTS_27\\THE OGALA RESIDENCE\\01_WIP\\S\\F26901-FMC-ZZ-ZZ-M3-S-0001.rvt";
const cfg = { ...DEFAULT_CONFIG, protected_roots: ["D:\\Fomcraft"], copy_roots: ["C:\\Users\\USER\\agent-tools"] };

test("fmc_replace is a locked write, and the transaction is sequential with deletion after every row passes", () => {
  assert.ok(WRITE_COMMANDS.has("fmc_replace"));
  assert.equal(REPLACE_TRANSACTION_MODEL, "sequential");
  assert.equal(REPLACE_DELETION_PASS, "after_all_rows_pass");
  assert.match(REPLACE_TRANSACTION_REASON, /sequential sub-transactions/);
  assert.match(REPLACE_TRANSACTION_REASON, /always rolled back/);
  assert.match(REPLACE_TRANSACTION_REASON, /no apply mode/);
  assert.doesNotMatch(REPLACE_TRANSACTION_REASON, /Assimilate/);
});

test("a B7 foundation row and a B3 beam row from the manifests parse, and a pedestal must follow its pad", () => {
  assert.equal(REPLACE_ROW.safeParse(B7_NEW_CF1_ROW).success, true);
  assert.equal(REPLACE_ROW.safeParse(B3_BEAM_1666251_ROW).success, true);
  assert.equal(KEYNOTE_RE.test("S.FND_01"), true);
  assert.equal(KEYNOTE_RE.test("S.FRM_01"), true);
  assert.equal(KEYNOTE_RE.test("foundation"), false);
  assert.equal(KEYNOTE_RE.test("SFND_01"), false);
  const batch = REPLACE_ROWS.safeParse([B7_NEW_CF1_ROW, B7_PEDESTAL_ROW]);
  assert.equal(batch.success, true, JSON.stringify(batch.success ? "" : batch.error.issues));
  const reversed = replaceProblems([B7_PEDESTAL_ROW, B7_NEW_CF1_ROW]);
  assert.ok(reversed.some((p) => /not an earlier row/.test(p)));
  const beam = REPLACE_ROW.safeParse({ ...B3_BEAM_1666251_ROW, z_justification: undefined });
  assert.equal(beam.success, true, "the field is optional on the object; the batch check requires it");
  assert.ok(replaceProblems([{ ...B3_BEAM_1666251_ROW, z_justification: undefined }]).some((p) => /z_justification/.test(p)));
});

test("duplicate old ids, a bad keynote and a slab material_id are rejected before Revit", () => {
  const shared = replaceProblems([
    B7_NEW_CF1_ROW,
    { ...B7_NEW_CF1_ROW, id: "B7:AGAIN", old_ids: [1666458] },
  ]);
  assert.ok(shared.some((p) => /1666458/.test(p)));
  const key = REPLACE_ROW.safeParse({ ...B7_NEW_CF1_ROW, keynote: "pad" });
  assert.equal(key.success, false);
  assert.ok(replaceProblems([{ ...B7_NEW_CF1_ROW, material_id: 5 }]).some((p) => /material_id/.test(p)));
  const cascade = replaceProblems([{ ...B7_NEW_CF1_ROW, expected_deleted_ids: [1666458] }]);
  assert.ok(cascade.some((p) => /1666478/.test(p)));
});

test("fmc_replace is allowed on a read-only copy and refused on the original and on a live path", () => {
  const original = { title: "Ogala-S", path: live, isFamily: false, isWorkshared: false, isDetached: false, readOnly: false };
  const detached = { title: "preview", path: copy, isFamily: false, isWorkshared: false, isDetached: true, readOnly: true, isActive: false };
  const copySession = { ...detached, isDetached: false, readOnly: true };
  assert.equal(writeGuard(original, "fmc_replace", {}, cfg).ok, false);
  assert.match(writeGuard(original, "fmc_replace", {}, cfg).reasons.join(" "), /open_copy|Protected original/);
  assert.equal(writeGuard({ ...original, path: copy, readOnly: false }, "fmc_replace", {}, cfg).ok, false);
  assert.equal(writeGuard(detached, "fmc_replace", {}, cfg).ok, true);
  assert.equal(writeGuard(copySession, "fmc_replace", {}, cfg).ok, true);
  assert.equal(writeGuard({ ...copySession, path: live, readOnly: true }, "fmc_replace", { live_paths: [live] }, cfg).ok, false);
  assert.equal(writeGuard({ ...detached, isLinked: true }, "fmc_replace", {}, cfg).ok, false);
});
