import { test } from "node:test";
import assert from "node:assert/strict";
import { cursorStart, decodeCursor, encodeCursor, pagingReply, queryHash } from "./filtercursor.js";
import { z } from "zod";
import { AI_ELEMENT_FILTER_SHAPE, runAiElementFilter } from "../tools/ai_element_filter.js";

// Tool research 1-25 (ai_element_filter, approved 28 Nov): the bounding box is {x, y, z} mm, and pages have a real cursor
// in the FILTER_TOOL_SPEC 5.6 token shape (c1. + base64url {rs, d, l, a, v, h}).

const walls = { filterCategory: "OST_Walls", includeInstances: true, includeTypes: false };
const body = (r: { content: Array<{ text: string }> }) => r.content[0].text;

test("filter cursor: the token is c1.+base64url of {rs,d,l,a,v,h}; paging keys do not change the query hash", () => {
  const token = encodeCursor({ rs: "", d: 0, l: 0, a: 1234, v: "g1", h: queryHash(walls) });
  assert.match(token, /^c1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeCursor(token), { rs: "", d: 0, l: 0, a: 1234, v: "g1", h: queryHash(walls) });
  assert.equal(queryHash({ ...walls, maxElements: 10, skip: 5 }), queryHash(walls));
  assert.equal(queryHash({ includeTypes: false, includeInstances: true, filterCategory: "OST_Walls" }), queryHash(walls), "key order does not matter");
  assert.notEqual(queryHash({ ...walls, filterCategory: "OST_Doors" }), queryHash(walls));
  assert.equal(decodeCursor("nope"), null);
  assert.equal(decodeCursor("c1.!!!"), null);
});

test("filter cursor: a cursor from another filter, or a made-up one, is refused", () => {
  const other = encodeCursor({ rs: "", d: 0, l: 0, a: 1, v: "", h: queryHash({ filterCategory: "OST_Doors" }) });
  const bad = cursorStart(walls, other);
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.message : "", /another filter/);
  assert.equal(cursorStart(walls, "c1.xyz").ok, false);
  const first = cursorStart(walls, "");
  assert.deepEqual(first, { ok: true, afterId: -1, cursor: null });
});

test("filter cursor: the next cursor carries the last id and the first page's version; the last page has none; a moved version is stale", () => {
  const first = pagingReply(walls, null, { total: 120, from: 1, to: 50, remaining: 70, last_id: 5001, document_version: "g1" }, "fail");
  assert.equal(first.ok, true);
  const next = decodeCursor(String(first.page.cursor));
  assert.equal(next?.a, 5001);
  assert.equal(next?.v, "g1");
  const last = pagingReply(walls, next, { total: 120, from: 101, to: 120, remaining: 0, last_id: 9000, document_version: "g1" }, "fail");
  assert.equal(last.ok && last.page.cursor, null);
  const stale = pagingReply(walls, next, { total: 121, remaining: 20, last_id: 6000, document_version: "g2" }, "fail");
  assert.equal(stale.ok, false);
  assert.equal(!stale.ok && stale.code, "FMC-FILTER-STALE");
  const carry = pagingReply(walls, next, { total: 121, remaining: 20, last_id: 6000, document_version: "g2" }, "continue");
  assert.equal(carry.ok && carry.page.model_changed, true);
  assert.equal(decodeCursor(String(carry.ok && carry.page.cursor))?.v, "g1", "the cursor keeps the first page's version");
});

test("ai_element_filter: the second page sends afterId from the cursor, never skip, and reports skipped elements", async () => {
  const sent: Array<Record<string, any>> = [];
  const send = async (params: Record<string, unknown>) => {
    sent.push(params as Record<string, any>);
    const after = (params.data as any).afterId ?? -1;
    return after < 0
      ? { Success: true, Message: "page 1", Response: [{ id: 1 }, { id: 2 }], paging: { total: 3, from: 1, to: 2, remaining: 1, last_id: 2, document_version: "g1", ids: [1, 2] }, skipped: [] }
      : { Success: true, Message: "page 2", Response: [], paging: { total: 3, from: 3, to: 3, remaining: 0, last_id: 3, document_version: "g1", ids: [3] }, skipped: [{ id: 3, reason: "INFO_FAILED", detail: "x" }] };
  };
  const one = JSON.parse(body(await runAiElementFilter({ data: { ...walls, maxElements: 2 } }, { send })));
  assert.equal(sent[0].data.afterId, undefined);
  assert.ok(one.paging.cursor);
  const two = JSON.parse(body(await runAiElementFilter({ data: { ...walls, maxElements: 2, cursor: one.paging.cursor } }, { send })));
  assert.equal(sent[1].data.afterId, 2);
  assert.equal(sent[1].data.skip, 0);
  assert.equal(sent[1].data.cursor, undefined, "the cursor is not sent to Revit");
  assert.equal(two.paging.cursor, null);
  assert.equal(two.skipped_count, 1);
  assert.deepEqual(two.paging.ids, [3], "the skipped id is still on the page");
});

test("ai_element_filter: cursor and skip together, and a stale model, are refused out loud", async () => {
  const send = async () => ({ Success: true, Response: [], paging: { total: 1, remaining: 0, last_id: 5, document_version: "g2" }, skipped: [] });
  const token = encodeCursor({ rs: "", d: 0, l: 0, a: 4, v: "g1", h: queryHash(walls) });
  const both = await runAiElementFilter({ data: { ...walls, cursor: token, skip: 3 } }, { send });
  assert.equal(both.isError, true);
  assert.match(body(both), /cursor or skip/);
  const stale = await runAiElementFilter({ data: { ...walls, cursor: token } }, { send });
  assert.equal(stale.isError, true);
  assert.match(body(stale), /FMC-FILTER-STALE/);
  const old = JSON.parse(body(await runAiElementFilter({ data: walls }, { send: async () => ({ Success: true, Response: [] }) })));
  assert.equal(old.paging.cursor, null);
  assert.match(old.paging.note, /no cursor paging yet/);
});

test("ai_element_filter: the box is {x, y, z} mm; the old {p0, p1} shape is refused instead of filtering on the origin", () => {
  const shape = z.object(AI_ELEMENT_FILTER_SHAPE);
  const ok = shape.safeParse({ data: { ...walls, boundingBoxMin: { x: 0, y: 0, z: 0 }, boundingBoxMax: { x: 5000, y: 5000, z: 3000 } } });
  assert.equal(ok.success, true);
  assert.deepEqual(ok.success && ok.data.data.boundingBoxMax, { x: 5000, y: 5000, z: 3000 });
  const old = shape.safeParse({ data: { ...walls, boundingBoxMin: { p0: { x: 0, y: 0, z: 0 }, p1: { x: 1, y: 1, z: 1 } }, boundingBoxMax: { p0: { x: 9, y: 9, z: 9 }, p1: { x: 10, y: 10, z: 10 } } } });
  assert.equal(old.success, false);
  assert.equal(shape.safeParse({ data: { ...walls, maxElements: 0 } }).success, false);
});
