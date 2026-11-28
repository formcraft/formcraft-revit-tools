import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_NEVER_WRITE, neverWriteMatch, neverWriteNames } from "./protectednames.js";

test("the built-in protected name is always in force", () => {
  assert.deepEqual([...BUILTIN_NEVER_WRITE], ["HEBERT HOSTELS"]);
  assert.deepEqual(neverWriteNames(), ["HEBERT HOSTELS"]);
  assert.deepEqual(neverWriteNames({ never_write_titles: [] }), ["HEBERT HOSTELS"]);
  assert.deepEqual(neverWriteNames({ never_write_titles: "HEBERT HOSTELS" }), ["HEBERT HOSTELS"], "a non-array is ignored");
});

test("the guard can add names, never remove the built-in one", () => {
  assert.deepEqual(neverWriteNames({ never_write_titles: ["Ogala Live", " ", 7, "hebert hostels"] }), ["HEBERT HOSTELS", "Ogala Live"]);
});

test("matching is a case-insensitive substring of title, path or named document", () => {
  assert.equal(neverWriteMatch(["HEBERT HOSTELS_USER", ""]), "HEBERT HOSTELS");
  assert.equal(neverWriteMatch(["Model", "C:\\Live\\hebert hostels plumbing.rvt"]), "HEBERT HOSTELS");
  assert.equal(neverWriteMatch(["F26901_USER", "C:\\x.rvt", "Ogala live"], { never_write_titles: ["Ogala Live"] }), "Ogala Live");
  assert.equal(neverWriteMatch(["F26901_USER", "C:\\x.rvt"]), null);
  assert.equal(neverWriteMatch([undefined, null, ""]), null);
});
