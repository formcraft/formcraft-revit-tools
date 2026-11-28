import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { guardModelCheck, judgeModelCheck } from "./modelcheck.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// The reply the OLD add-in sent when a check threw: count 0 + check_failed, problems 0, next "No problems found".
const OLD_BUG_REPLY = {
  model: "M", problems: 0,
  checks: { revit_warnings: { count: 0 }, clashes: { count: 0, check_failed: "The input curve is not bound" } },
  next: "No problems found by these checks",
};

test("a check that threw is an error, never 'No problems found' (old add-in reply)", () => {
  const verdict = judgeModelCheck(OLD_BUG_REPLY);
  assert.equal(verdict.status, "error");
  assert.equal(verdict.isError, true);
  assert.equal(verdict.complete, false);
  assert.deepEqual(verdict.checks_failed, [{ check: "clashes", error: "The input curve is not bound" }]);
  const g = guardModelCheck(OLD_BUG_REPLY);
  assert.equal(g.isError, true);
  assert.equal(g.body.status, "error");
  assert.doesNotMatch(String(g.body.next), /no problems found/i);
  assert.match(String(g.body.next), /clashes/);
  assert.match(String(g.body.next), /NOT/);
});

test("the new add-in's failed flag and checks_failed list are honoured, and problems found elsewhere are kept", () => {
  const reply = {
    problems: 3, status: "error", checks_failed: [{ check: "rooms", error: "NullReferenceException: x" }],
    checks: { duplicates: { count: 3, items: [] }, rooms: { count: 0, failed: true, check_failed: "NullReferenceException: x" } },
    next: "ERROR: ...",
  };
  const g = guardModelCheck(reply);
  assert.equal(g.isError, true);
  assert.equal(g.body.problems, 3);
  assert.equal(g.body.complete, false);
  assert.deepEqual((g.body.checks_failed as Array<{ check: string }>).map((c) => c.check), ["rooms"]);
});

test("no checks at all, no reply, or a garbled reply is an error, not clean", () => {
  for (const bad of [undefined, null, "ok", {}, { problems: 0, checks: {}, next: "No problems found by these checks" }]) {
    const g = guardModelCheck(bad);
    assert.equal(g.isError, true, JSON.stringify(bad));
    assert.equal(g.body.status, "error");
    assert.doesNotMatch(String(g.body.next), /no problems found/i);
  }
});

test("a check that returned nothing for its name is a failed check", () => {
  const v = judgeModelCheck({ problems: 0, checks: { rooms: null, duplicates: { count: 0 } } });
  assert.equal(v.status, "error");
  assert.equal(v.checks_failed[0].check, "rooms");
});

test("skipped elements make the report partial: not an error, but never 'No problems found'", () => {
  const reply = { problems: 0, checks: { blind_openings: { count: 0, skipped: 4 }, rooms: { count: 0 } }, next: "No problems found by these checks" };
  const g = guardModelCheck(reply);
  assert.equal(g.body.status, "partial");
  assert.equal(g.isError, false);
  assert.equal(g.body.complete, false);
  assert.equal(g.body.skipped, 4);
  assert.doesNotMatch(String(g.body.next), /No problems found/);
  assert.match(String(g.body.next), /4 element/);
});

test("a clean run says so, and a run with problems keeps the add-in's own advice; guarding twice changes nothing", () => {
  const clean = { problems: 0, checks: { rooms: { count: 0 }, duplicates: { count: 0 } }, next: "No problems found by these checks" };
  const g1 = guardModelCheck(clean);
  assert.equal(g1.body.status, "ok");
  assert.equal(g1.isError, false);
  assert.equal(g1.body.next, "No problems found by these checks");
  assert.deepEqual(guardModelCheck(g1.body).body, g1.body);
  const found = { problems: 2, checks: { rooms: { count: 2 } }, next: "Look at each with see_view ids [...]; fix with modify_model" };
  const g2 = guardModelCheck(found);
  assert.equal(g2.body.status, "problems");
  assert.equal(g2.body.complete, true);
  assert.equal(g2.body.next, found.next);
  // the count says problems but the add-in's text said clean: the text is replaced
  const lie = guardModelCheck({ problems: 2, checks: { rooms: { count: 2 } }, next: "No problems found by these checks" });
  assert.doesNotMatch(String(lie.body.next), /no problems found/i);
});

test("Revit side (source): a throwing check is recorded as failed and the verdict is computed from it", () => {
  const src = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcVision.cs"), "utf8");
  const handler = src.slice(src.indexOf("class FmcModelCheckHandler"));
  assert.doesNotMatch(handler, /\["check_failed"\] = e\.Message \}/, "the old swallow is gone");
  assert.match(handler, /failed\.Add\(new JObject \{ \["check"\] = name, \["error"\] = why \}\)/);
  assert.match(handler, /\["failed"\] = true/);
  assert.match(handler, /string status = failed\.Count > 0 \|\| r\.Count == 0 \? "error"/);
  assert.match(handler, /\["status"\] = status/);
  assert.match(handler, /\["checks_failed"\] = failed/);
  // "No problems found" is only reachable from status ok
  const clean = handler.split("\n").filter((l) => l.includes("No problems found by these checks"));
  assert.equal(clean.length, 1);
  assert.match(clean[0], /total == 0 \?/);
  // the silent per-element skips are counted now
  assert.doesNotMatch(handler, /catch \(Exception\) \{ continue; \}/);
  assert.match(handler, /_skipped\+\+/);
});

test("the model_check tool hands the reply through the guard", () => {
  const tool = fs.readFileSync(path.join(root, "server", "src", "tools", "see_view.ts"), "utf8");
  assert.match(tool, /guardModelCheck\(r\)/);
  assert.match(tool, /g\.isError/);
});