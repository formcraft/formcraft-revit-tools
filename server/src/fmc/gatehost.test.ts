import { test } from "node:test";
import assert from "node:assert/strict";
import { hostLines, hostTestKind } from "./recipes.js";

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
