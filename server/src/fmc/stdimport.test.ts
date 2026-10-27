import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeDigest, normKey, sameValue } from "./stdimport.js";

const kit = { standards: { "doors.width": { value: 900, unit: "mm", note: "kit" }, "stairs.riser_max": { value: 175, unit: "mm" } } };
const reg = { sources: [{ id: "OLD", title: "Old", keys: ["doors.width"], gaps: [] }] };

test("digests merge into the kit (owner 27 Oct): new keys proposed, same values corroborate, different values are conflicts, never overwritten", () => {
  const d = { id: "UG-X-2019", file: "x.pdf", title: "X", relevance: "high", rules: [
    { key: "Doors.Width", value: "900", clause: "12(3)" }, { key: "stairs.riser_max", value: 190, clause: "41" }, { key: "rooms.height_min", value: 2600, unit: "mm", clause: "14" },
  ], gaps: ["Fig 3 is an image"] };
  const { kit: k, reg: r, report } = mergeDigest(kit, reg, d, { date: "2026-10-27" });
  assert.deepEqual(report.added, ["rooms.height_min"]);
  assert.deepEqual(report.corroborated, ["doors.width"], "900 and '900' are the same value");
  assert.deepEqual(report.conflicts.map((c) => c.key), ["stairs.riser_max"]);
  assert.equal((k.standards["stairs.riser_max"] as { value: number }).value, 175, "a conflict never overwrites");
  assert.equal((k.standards["rooms.height_min"] as { status: string }).status, "proposed");
  assert.deepEqual((k.standards["doors.width"] as unknown as { sources: string[] }).sources, ["UG-X-2019"]);
  const s = r.sources.find((x) => x.id === "UG-X-2019")!;
  assert.deepEqual(s.keys, ["doors.width", "rooms.height_min", "stairs.riser_max"]);
  assert.deepEqual(s.gaps!.map((g) => g.kind), ["", "conflict"], "the image gap and the conflict are both logged");
  assert.equal(kit.standards["doors.width"].value, 900, "inputs untouched");

  const again = mergeDigest(k, r, d, { date: "2026-10-27" });
  assert.equal(again.reg.sources.filter((x) => x.id === "UG-X-2019").length, 1, "reading again replaces the record");
  assert.equal(again.reg.sources.find((x) => x.id === "UG-X-2019")!.gaps!.length, 2, "and its gaps, not doubles them");
});

test("business law digests register the source but add no building standards", () => {
  const { kit: k, reg: r, report } = mergeDigest(kit, reg, { id: "UG-VAT", relevance: "none", rules: [{ key: "business.vat.threshold", value: 50000000 }] });
  assert.equal(report.added.length, 0);
  assert.equal(Object.keys(k.standards).length, 2);
  assert.ok(r.sources.find((x) => x.id === "UG-VAT"));
  assert.throws(() => mergeDigest(kit, reg, { id: "" } as never), /needs an id/);
});

test("a conflict the reader found under another key name lands on the kit's key", () => {
  const { kit: k, report } = mergeDigest(kit, reg, { id: "UG-PPSG", relevance: "high", rules: [{ key: "planning.riser", value: 190 }],
    conflicts: [{ key: "stairs.riser_max", kit_value: 175, doc_value: 190, clause: "4.2" }, { key: "no.such.key", doc_value: 1 }] });
  assert.deepEqual(report.conflicts.map((c) => c.key), ["stairs.riser_max"]);
  assert.equal((k.standards["stairs.riser_max"] as { value: number }).value, 175);
});

test("keys are dotted lowercase; values compare by content", () => {
  assert.equal(normKey(" Concrete Cover.Min XC1 "), "concrete_cover.min_xc1");
  assert.ok(sameValue({ a: 1, b: [2, "3"] }, { b: [2, 3], a: "1" }));
  assert.ok(!sameValue(175, 190));
});
