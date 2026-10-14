import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PORT, connectFile, notListening, revitPort } from "./connect.js";

const env = { APPDATA: "C:\\Users\\X\\AppData\\Roaming" } as NodeJS.ProcessEnv;

test("the port comes from fmc_connect.json, shared with the add-in", () => {
  assert.equal(connectFile(env), "C:\\Users\\X\\AppData\\Roaming\\Formcraft\\fmc_connect.json");
  assert.equal(revitPort(env, () => '{"start_with_revit": true, "port": 8095}'), 8095);
});

test("a missing or broken file, or a bad port, falls back to 8080; REVIT_PORT wins", () => {
  assert.equal(revitPort(env, () => { throw new Error("missing"); }), DEFAULT_PORT);
  assert.equal(revitPort(env, () => "{not json"), DEFAULT_PORT);
  assert.equal(revitPort(env, () => '{"port": 70000}'), DEFAULT_PORT);
  assert.equal(revitPort({ ...env, REVIT_PORT: "8099" }, () => '{"port": 8095}'), 8099);
});

test("the failure says what to click in Revit", () => {
  assert.match(notListening(8080), /127\.0\.0\.1:8080.*Formcraft tab › Core.*AI: off/);
});
