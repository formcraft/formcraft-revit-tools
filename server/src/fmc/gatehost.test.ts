import { test } from "node:test";
import assert from "node:assert/strict";
import { familyHost, hostLines, hostTestKind, hostTestKindFor } from "./recipes.js";

const passTest = { host: "wall", placement: "WorkPlaneBased", placed: true, state: "Pass", followed: true, host_kept: true, upright: true,
  detail: "Placed on the wall face, followed a 500 mm wall move, upright, 1 connector(s) into the host or along it" };

test("F-061: the host test runs on a wall or ceiling only when the register's Host needs it", () => {
  assert.equal(hostTestKind("Wall face"), "wall");
  assert.equal(hostTestKind("Ceiling face"), "ceiling");
  assert.equal(hostTestKind("Wall or ceiling"), "wall"); // face based serves both; the wall is tested
  assert.equal(hostTestKind("Face"), "wall");
  for (const h of ["Level", "Floor", "Pipe", "Level / wall", null, undefined, ""]) assert.equal(hostTestKind(h as string), null, String(h));
});

test("F-061: a face based socket that follows its wall passes both host lines", () => {
  const lines = hostLines("Wall face", passTest);
  assert.deepEqual(lines.map((l) => [l.check, l.state]), [["Hosts as the register says", "Pass"], ["Host test", "Pass"]]);
  assert.match(lines[0].detail, /host is "Wall face" and the family is face based/);
});

test("F-061: the Wave 1 socket on Metric Generic Model.rft fails: unhosted, and it can't be placed on the wall", () => {
  const unhosted = { host: "wall", placement: "OneLevelBased", placed: false, state: "Fail",
    detail: "OneLevelBased: the family doesn't host, so it can't be placed on a wall (use a face based template…)" };
  const lines = hostLines("Wall face", unhosted);
  assert.equal(lines[0].state, "Fail");
  assert.match(lines[0].detail, /the family is OneLevelBased \(unhosted\), so it can't be placed there: build it on a face based template/);
  assert.equal(lines[1].state, "Fail");
});

test("F-061: a family that loses or doesn't follow its host fails the host test, with the reason", () => {
  const lost = { ...passTest, state: "Fail", followed: false, detail: "moved 0 mm when the wall moved 500 mm" };
  const lines = hostLines("Wall face", lost);
  assert.equal(lines[0].state, "Pass"); // it is face based, as the register says
  assert.deepEqual([lines[1].state, lines[1].detail], ["Fail", "moved 0 mm when the wall moved 500 mm"]);
});

test("F-061: never a pass on nothing: no register Host, or no answer from Revit, is Not checked with the reason", () => {
  assert.deepEqual(hostLines(null, null).map((l) => l.state), ["Not checked"]);
  const noRevit = hostLines("Ceiling face", null, "connect to revit client failed");
  assert.deepEqual(noRevit.map((l) => l.state), ["Not checked", "Not checked"]);
  assert.match(noRevit[1].detail, /connect to revit client failed/);
  // an unhosted register host needs no test
  assert.deepEqual(hostLines("Level", null).map((l) => [l.check, l.state]), [["Hosts as the register says", "Pass"]]);
});

test("F-061: with no register Host, the host kind comes from the family's template, else its category", () => {
  const kind = (f: string, t: string | null, c?: string) => familyHost(f, t, c)?.kind ?? null;
  assert.equal(kind("FMC_A_Door_FlushSingle_Hygienic_Detailed", "Metric Door.rft"), "wall");
  assert.equal(kind("FMC_A_Window_Observation_Internal_Nurse_Detailed", "Metric Window.rft"), "wall");
  assert.equal(kind("FMC_E_LightFixture_OperatingLight_Ceiling_Detailed", "Metric Generic Model face based.rft"), "ceiling", "face based, Ceiling in the name");
  assert.equal(kind("FMC_E_LightFixture_Downlight", "Metric Lighting Fixture ceiling based face based.rft"), "ceiling");
  assert.equal(kind("FMC_E_Socket_Double", "Metric Electrical Fixture face based.rft"), "face");
  assert.equal(kind("FMC_E_Socket_Double", "Metric Electrical Fixture wall based.rft"), "wall");
  assert.equal(kind("FMC_E_Light_X", "Metric Lighting Fixture ceiling based.rft"), "ceiling");
  assert.equal(kind("FMC_S_Pad", "Metric Generic Model floor based.rft"), "floor");
  assert.equal(kind("FMC_I_MedEq_Bed_ICU_Electric_Detailed", "Metric Generic Model.rft"), "none");
  assert.equal(kind("FMC_A_Door_X", "C:\\Templates\\Metric Door.rft"), "wall", "a full template path");
  assert.equal(familyHost("FMC_A_Door_X", "Metric Door.rft")?.from, "its template Metric Door.rft");
  assert.deepEqual(familyHost("FMC_A_Door_X", null, "Doors"), { host: "Wall", kind: "wall", from: "its category Doors" });
  assert.equal(familyHost("FMC_I_Chair", null, "Furniture"), null);
  assert.equal(familyHost("FMC_I_Chair", "", null), null);
});

test("F-061: the host test runs on the register's Host, else on the family's own (walls and ceilings only)", () => {
  assert.equal(hostTestKindFor("Ceiling face", familyHost("FMC_A_Door_X", "Metric Door.rft")), "ceiling", "the register wins");
  assert.equal(hostTestKindFor(null, familyHost("FMC_A_Door_X", "Metric Door.rft")), "wall");
  assert.equal(hostTestKindFor(null, familyHost("FMC_E_Socket", "Metric Electrical Fixture face based.rft")), "wall");
  assert.equal(hostTestKindFor(null, familyHost("FMC_E_Light_Ceiling", "Metric Generic Model face based.rft")), "ceiling");
  assert.equal(hostTestKindFor(null, familyHost("FMC_S_Pad", "Metric Generic Model floor based.rft")), null);
  assert.equal(hostTestKindFor(null, familyHost("FMC_I_Bed", "Metric Generic Model.rft")), null);
  assert.equal(hostTestKindFor(null, null), null);
});

test("F-061: a family the register gives no Host is checked on its own host, and the line says so", () => {
  const door = familyHost("FMC_A_Door_FlushSingle_Hygienic_Detailed", "Metric Door.rft");
  const hosted = { host: "wall", placement: "OneLevelBasedHosted", placed: true, state: "Pass", detail: "Placed in the wall, followed a 500 mm wall move" };
  const lines = hostLines(null, hosted, "", door);
  assert.deepEqual(lines.map((l) => [l.check, l.state]), [["Hosts as the register says", "Pass"], ["Host test", "Pass"]]);
  assert.match(lines[0].detail, /The register gives no Host; from the family \(its template Metric Door\.rft, not the register\) the host is "Wall" and the family is hosted/);
  const noRevit = hostLines(null, null, "connect to revit client failed", door);
  assert.deepEqual(noRevit.map((l) => l.state), ["Not checked", "Not checked"]);
  const bed = hostLines(null, null, "", familyHost("FMC_I_Bed", "Metric Generic Model.rft"));
  assert.deepEqual(bed.map((l) => l.state), ["Pass"]);
  assert.match(bed[0].detail, /unhosted \(its template Metric Generic Model\.rft, not the register\)/);
  const pad = hostLines(null, null, "", familyHost("FMC_S_Pad", "Metric Generic Model floor based.rft"));
  assert.deepEqual([pad[0].state, /walls and ceilings only/.test(pad[0].detail)], ["Not checked", true]);
  // the register's wording is unchanged when it has a Host
  assert.match(hostLines("Wall face", passTest, "", door)[0].detail, /^The register's host is "Wall face" and the family is face based/);
});
