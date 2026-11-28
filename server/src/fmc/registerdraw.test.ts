import { test } from "node:test";
import assert from "node:assert/strict";
import { planRegister, sheetParked } from "./registerdraw.js";

test("a drawing list gains the sheet fields and a PARKED filter, and parked sheets are the ones that drop", () => {
  assert.equal(sheetParked("PARKED", ""), true);
  assert.equal(sheetParked("In work", "Parked"), true);
  assert.equal(sheetParked("In work", ""), false);
  const plan = planRegister({
    name: "G100",
    exists: true,
    fields: ["Sheet Number"],
    filters: [],
    status_parameter: "FMC_Sheet_Status",
  }, [
    { number: "A-101", name: "Plan", revision: "P1", status: "In work", parked: false },
    { number: "A-901", name: "Spare", revision: "", status: "PARKED", parked: true },
  ]);
  assert.deepEqual(plan.add_fields, ["Sheet Name", "Current Revision", "FMC_Sheet_Status"]);
  assert.deepEqual(plan.add_filters.map((row) => row.value), ["PARKED", "Parked"]);
  assert.deepEqual(plan.excluded.map((row) => row.number), ["A-901"]);
  assert.equal(plan.shown.length, 1);
  assert.equal(plan.changes, true);
  const ready = planRegister({
    name: "G100",
    exists: true,
    fields: ["Sheet Number", "Sheet Name", "Current Revision", "FMC_Sheet_Status"],
    filters: [
      { field: "FMC_Sheet_Status", type: "NotEqual", value: "PARKED" },
      { field: "FMC_Sheet_Status", type: "NotEqual", value: "Parked" },
    ],
    status_parameter: "FMC_Sheet_Status",
  }, []);
  assert.equal(ready.add_fields.length, 0);
  assert.equal(ready.add_filters.length, 0);
  const missing = planRegister({ name: "G100", exists: false, fields: [], filters: [], status_parameter: null }, []);
  assert.equal(missing.code, "FMC-REGISTER-STATUS");
  assert.equal(missing.create, true);
});

test("RG-5/RG-6/RG-10: a missing status says no changes, sheets without or with an empty status and an unbound parameter are reported, counts come first", async () => {
  const missing = planRegister({ name: "G100", exists: false, fields: [], filters: [], status_parameter: null }, [{ number: "A-1", name: "", revision: "", status: "", parked: false }]);
  assert.equal(missing.changes, false);
  assert.deepEqual(missing.counts, { sheets: 1, parked: 0, shown: 1 });
  const plan = planRegister({ name: "G100", exists: true, fields: [], filters: [], status_parameter: "FMC_Sheet_Status", status_bound_to_sheets: false }, [
    { number: "A-101", name: "Plan", revision: "", status: "In work", parked: false, has_status: true },
    { number: "A-102", name: "Plan", revision: "", status: "", parked: false, has_status: true },
    { number: "A-103", name: "Plan", revision: "", status: "", parked: false, has_status: false },
  ]);
  assert.deepEqual(plan.sheets_without_status, ["A-103"]);
  assert.deepEqual(plan.sheets_empty_status, ["A-102"]);
  assert.equal(plan.warnings?.length, 3);
  const { runFmcRegister } = await import("../tools/fmc_register.js");
  const res = await runFmcRegister({ document: "A", schedule: "G100", dry_run: true, full: false, batch_lease: "" }, { read: async () => ({}) });
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.can_apply, false);
  assert.equal(body.changes, false);
  assert.equal("shown" in body, false);
  assert.match(body.next, /FMC_Sheet_Status/);
});
