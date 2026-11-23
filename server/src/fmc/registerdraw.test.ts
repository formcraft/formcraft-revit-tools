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
