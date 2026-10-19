import { test } from "node:test";
import assert from "node:assert/strict";
import { Intent, intentAfterReply, normalise, parseNote, planFix, resolveParam, toMm, wordsToDigits } from "./noteparse.js";

const MATERIALS = ["FMC_Metal_StainlessSteel_Brushed", "FMC_Wood_Oak_Natural", "FMC_Paint_White_Matt", "FMC_Tile_Ceramic_White"];
const opts = { materials: MATERIALS };

/** Each case: what was said, and what must come out (only the fields named are checked). */
const CASES: Array<[string, Array<Partial<Intent>>]> = [
  // resize
  ["make it 1200 wide", [{ kind: "resize", param: "Width", value_mm: 1200 }]],
  ["Width 1026", [{ kind: "resize", param: "Width", value_mm: 1026 }]],
  ["It should be 2100 high.", [{ kind: "resize", param: "Height", value_mm: 2100 }]],
  ["the height should be 2.1 m", [{ kind: "resize", param: "Height", value_mm: 2100 }]],
  ["make it 120 cm wide", [{ kind: "resize", param: "Width", value_mm: 1200 }]],
  ["change the width to 900mm", [{ kind: "resize", param: "Width", value_mm: 900 }]],
  ["make it 100 wider", [{ kind: "resize", param: "Width", by_mm: 100 }]],
  ["reduce the depth by 50", [{ kind: "resize", param: "Depth", by_mm: -50 }]],
  ["widen it by 200 mm", [{ kind: "resize", param: "Width", by_mm: 200 }]],
  ["make it 1200 wide and 2100 high", [{ kind: "resize", param: "Width", value_mm: 1200 }, { kind: "resize", param: "Height", value_mm: 2100 }]],
  ["1200x2100", [{ kind: "resize", param: "Width", value_mm: 1200 }, { kind: "resize", param: "Height", value_mm: 2100 }]],
  ["width: 1,200", [{ kind: "resize", param: "Width", value_mm: 1200 }]],
  ["the door is too narrow make it 1026", [{ kind: "resize", param: "Width", value_mm: 1026 }]],
  ["the shelf should be 350 deep", [{ kind: "resize", param: "Depth", value_mm: 350 }]],
  // written numbers
  ["make it twelve hundred wide", [{ kind: "resize", param: "Width", value_mm: 1200 }]],
  ["uh raise it to two thousand seven hundred", [{ kind: "raise_lower", value_mm: 2700 }]],
  ["move it three hundred to the left", [{ kind: "move", direction: "left", by_mm: 300 }]],
  ["lower it by a hundred and fifty", [{ kind: "raise_lower", by_mm: -150 }]],
  ["make it one point two metres wide", [{ kind: "resize", param: "Width", value_mm: 1200 }]],
  // raise and lower
  ["raise it to 2700", [{ kind: "raise_lower", value_mm: 2700 }]],
  ["lower by 150", [{ kind: "raise_lower", by_mm: -150 }]],
  ["raise it 50mm", [{ kind: "raise_lower", by_mm: 50 }]],
  ["it needs to be 100 higher", [{ kind: "raise_lower", by_mm: 100 }]],
  ["mount it at 1200 above the floor", [{ kind: "raise_lower", value_mm: 1200 }]],
  ["sill height 900", [{ kind: "set_param", param: "Sill Height", value_mm: 900 }]],
  ["set the offset to 150", [{ kind: "set_param", param: "Offset", value_mm: 150 }]],
  // move, relative to the view
  ["move it 300 left", [{ kind: "move", direction: "left", by_mm: 300 }]],
  ["move it 300 right", [{ kind: "move", direction: "right", by_mm: 300 }]],
  ["move it 300mm up", [{ kind: "move", direction: "up", by_mm: 300 }]],
  ["shift the door 250 down", [{ kind: "move", direction: "down", by_mm: 250 }]],
  ["move it forward 0.5 m", [{ kind: "move", direction: "forward", by_mm: 500 }]],
  ["push it back by 40", [{ kind: "move", direction: "back", by_mm: 40 }]],
  ["move it to the right 1.2 m", [{ kind: "move", direction: "right", by_mm: 1200 }]],
  ["move 0.3 m", [{ kind: "move", by_mm: 300 }]],
  ["300 to the left", [{ kind: "move", direction: "left", by_mm: 300 }]],
  // voice transcripts: filler, no punctuation
  ["um so i think we need to move it like 300 to the left please", [{ kind: "move", direction: "left", by_mm: 300 }]],
  ["uh yeah can you make this one uh twelve hundred wide thanks", [{ kind: "resize", param: "Width", value_mm: 1200 }]],
  ["okay so basically this socket should be at three hundred above the floor", [{ kind: "raise_lower", value_mm: 300 }]],
  ["er just delete this one", [{ kind: "delete" }]],
  // types
  ["change to 1026 single", [{ kind: "swap_type", type_name: "1026 single" }]],
  ["use type FMC Door 1026 Single", [{ kind: "swap_type", type_name: "FMC Door 1026 Single" }]],
  ["wrong type, should be the double leaf", [{ kind: "swap_type", type_name: "double leaf" }]],
  // materials, only from the list passed in
  ["wrong material, use stainless", [{ kind: "material", material: "FMC_Metal_StainlessSteel_Brushed" }]],
  ["finish should be oak", [{ kind: "material", material: "FMC_Wood_Oak_Natural" }]],
  ["change it to stainless steel", [{ kind: "material", material: "FMC_Metal_StainlessSteel_Brushed" }]],
  ["material should be white", [{ kind: "material", candidates: ["FMC_Paint_White_Matt", "FMC_Tile_Ceramic_White"] }]],
  ["wrong material use granite", [{ kind: "material", material: undefined }]],
  // delete
  ["delete this", [{ kind: "delete" }]],
  ["remove it", [{ kind: "delete" }]],
  ["this isn't needed", [{ kind: "delete" }]],
  ["don't delete it", [{ kind: "unclear" }]],
  // clearance, same as
  ["needs clearance", [{ kind: "add_clearance" }]],
  ["it needs 600 clearance in front", [{ kind: "add_clearance", value_mm: 600 }]],
  ["same as the other one", [{ kind: "same_as", ref: "other one" }]],
  ["should match the one in room 204", [{ kind: "same_as" }]],
  // generic set
  ["set mark to D-01", [{ kind: "set_param", param: "Mark", value_text: "D-01" }]],
  // engineering values never set
  ["upsize the pipe to DN50", [{ kind: "set_param", engineering: true }]],
  ["the breaker rating should be 32A", [{ kind: "set_param", engineering: true }]],
  // several in one note
  ["Make it 1200 wide. Move it 300 left. Wrong material, use oak.", [
    { kind: "resize", param: "Width", value_mm: 1200 }, { kind: "move", direction: "left", by_mm: 300 }, { kind: "material", material: "FMC_Wood_Oak_Natural" }]],
  ["delete the extra socket and move the switch 200 up", [{ kind: "delete" }, { kind: "move", direction: "up", by_mm: 200 }]],
  ["um the window uh should be like twelve hundred wide and um nine hundred high", [{ kind: "resize", param: "Width", value_mm: 1200 }, { kind: "resize", param: "Height", value_mm: 900 }]],
  ["remove 100 from the width", [{ kind: "unclear" }]],
  ["The door should be 1026 wide. The frame clashes with the column.", [{ kind: "resize", param: "Width", value_mm: 1026 }, { kind: "unclear" }]],
  // unclear
  ["this looks wrong", [{ kind: "unclear" }]],
  ["make it bigger", [{ kind: "unclear" }]],
  ["move it 3", [{ kind: "unclear" }]],
  ["", [{ kind: "unclear", confidence: 0 }]],
  ["the frame clashes with the column", [{ kind: "unclear" }]],
];

for (const [said, want] of CASES) {
  test(`parse: "${said}"`, () => {
    const got = parseNote(said, opts);
    assert.equal(got.length, want.length, `${JSON.stringify(got)}`);
    want.forEach((w, k) => {
      for (const [key, v] of Object.entries(w)) assert.deepEqual((got[k] as any)[key], v, `${key} in ${JSON.stringify(got[k])}`);
      assert.ok(got[k].confidence >= 0 && got[k].confidence <= 1);
      if (w.kind === "unclear" && w.confidence === undefined) assert.ok(got[k].confidence < 0.5, "unclear is low confidence");
      if (w.kind !== "unclear" && w.kind !== "material" && !(w.kind === "move" && !w.direction)) assert.ok(got[k].confidence >= 0.5, `confident: ${JSON.stringify(got[k])}`);
    });
  });
}

test("parse: a move with no direction is weak; metres and mm agree; said holds the matched words", () => {
  const [m] = parseNote("move 0.3 m");
  assert.ok(m.confidence < 0.5);
  assert.deepEqual(parseNote("raise it to 2.7 m")[0].value_mm, parseNote("raise it to 2700 mm")[0].value_mm);
  assert.equal(parseNote("um please make it 1200 wide")[0].said, "make it 1200 wide");
});

test("normalise: numbers, units and filler", () => {
  assert.equal(wordsToDigits("twelve hundred"), "1200");
  assert.equal(wordsToDigits("twenty one hundred"), "2100");
  assert.equal(wordsToDigits("one thousand two hundred and fifty"), "1250");
  assert.equal(wordsToDigits("the other one"), "the other one", "a lone 'one' stays a word");
  assert.equal(normalise("Uh, 300 millimetres to the LEFT please"), "300 mm to the LEFT");
  assert.deepEqual(toMm(3, undefined), null, "a small bare number is never guessed");
  assert.deepEqual(toMm(1.2, "m"), { mm: 1200, conf: 1 });
  assert.equal(toMm(1200, "m")!.mm, 1200, "1200 m is a slip for mm");
});

// ---------------------------------------------------------------- the planner

const door = { unique_id: "u-1", category: "Doors", type_name: "FMC Door 926 Single", params: { Width: 926, Height: 2100, "Rough Width": 946, "Sill Height": 0 },
  types: ["FMC Door 926 Single", "FMC Door 1026 Single", "FMC Door 1026 Double"] };

test("plan: set a parameter by name, with the value it has now", () => {
  const p = planFix(parseNote("make it 1026 wide"), door, opts);
  assert.equal(p.ready, true);
  assert.deepEqual(p.steps, [{ op: "set_param", param: "Width", value_mm: 1026, was: 926, sentence: "Set Width to 1026 mm (now 926)", unique_id: "u-1" }]);
  assert.equal(p.dry_run, true);
});

test("plan: by a change, from the current value; already as asked is a note, not a step", () => {
  assert.equal(planFix(parseNote("make it 100 wider"), door, opts).steps[0].sentence, "Set Width to 1026 mm (now 926, +100)");
  const same = planFix(parseNote("height 2100"), door, opts);
  assert.deepEqual(same.steps, []);
  assert.deepEqual(same.notes, ["Height is already 2100 mm"]);
});

test("plan: a parameter is picked only when exactly one matches", () => {
  assert.deepEqual(resolveParam("Width", door.params), { name: "Width" });
  assert.deepEqual(resolveParam("width", { "Rough Width": 1, "Frame Width": 2 }).name, undefined);
  const p = planFix(parseNote("make it 1200 wide"), { category: "Casework", params: { "Rough Width": 1, "Frame Width": 2 } }, opts);
  assert.equal(p.steps.length, 0);
  assert.match(p.unclear[0], /could be Rough Width, Frame Width/);
  assert.match(planFix(parseNote("make it 600 deep"), door, opts).unclear[0], /no Depth parameter/);
});

test("plan: raise to a height uses the element's one height parameter; raise by moves up", () => {
  assert.equal(planFix(parseNote("raise it to 900"), door, opts).steps[0].sentence, "Set Sill Height to 900 mm (now 0)");
  const by = planFix(parseNote("lower by 150"), door, opts).steps[0];
  assert.deepEqual(by.op === "move" && by.vector_mm, [0, 0, -150]);
});

test("plan: a move is a vector in the view's frame", () => {
  const s = planFix(parseNote("move it 300 left"), door, opts).steps[0];
  assert.equal(s.op, "move");
  assert.deepEqual(s.op === "move" && [s.frame, s.vector_mm], ["view", [-300, 0, 0]]);
  assert.match(s.sentence, /Move FMC Door 926 Single \(Doors\) 300 mm left/);
  assert.match(planFix(parseNote("move 0.3 m"), door, opts).unclear[0], /which way/);
});

test("plan: change type by name, only to a loaded type", () => {
  assert.equal(planFix(parseNote("change to 1026 single"), door, opts).steps[0].sentence, "Change the type to FMC Door 1026 Single (now FMC Door 926 Single)");
  assert.match(planFix(parseNote("change to 1026"), door, opts).unclear[0], /which type: FMC Door 1026 Single, FMC Door 1026 Double/);
  assert.match(planFix(parseNote("change to 1200 single"), door, opts).unclear[0], /no type "1200 single" is loaded/);
});

test("plan: materials come from the kit list only (rule 7)", () => {
  assert.equal(planFix(parseNote("wrong material, use stainless", opts), door, opts).steps[0].sentence, "Give FMC Door 926 Single (Doors) the kit material FMC_Metal_StainlessSteel_Brushed");
  assert.match(planFix(parseNote("wrong material use granite", opts), door, opts).unclear[0], /kit change request/);
  // a material the parser matched but the planner's list doesn't hold is never set
  assert.equal(planFix([{ kind: "material", confidence: 0.9, said: "x", material: "FMC_Invented" }], door, opts).steps.length, 0);
});

test("plan: engineering values go to an engineer (rule 5)", () => {
  const pipe = { category: "Pipes", type_name: "Copper", params: { Diameter: 22, Offset: 2700 } };
  assert.equal(planFix(parseNote("make it 28 wide"), pipe, opts).ask_engineer.length, 1);
  assert.equal(planFix(parseNote("upsize the pipe to DN50"), pipe, opts).ask_engineer.length, 1);
  assert.equal(planFix(parseNote("change to 254x146 UB"), { category: "Structural Framing", type_name: "203x133 UB" }, opts).ask_engineer.length, 1);
  assert.equal(planFix(parseNote("move it 100 up"), pipe, opts).steps.length, 1, "moving a pipe isn't an engineering value");
});

test("a reply that asks for something replaces the intent; a thank-you keeps it", () => {
  const first = parseNote("make it 1200 wide");
  assert.equal(intentAfterReply(first, parseNote("thanks, see the photo"))[0].kind, "resize");
  assert.equal(intentAfterReply(first, parseNote("actually make it 1100 wide"))[0].value_mm, 1100);
  assert.equal(intentAfterReply(undefined, parseNote("hmm"))[0].kind, "unclear");
});

test("plan: from the note alone it says so and is never ready; delete, clearance and same-as", () => {
  const p = planFix(parseNote("make it 1200 wide. delete this"), null, opts);
  assert.equal(p.from_note_only, true);
  assert.equal(p.ready, false);
  assert.match(p.summary, /planned from the note alone/);
  assert.equal(p.steps[0].sentence, "Set Width to 1200 mm (now unknown: planned from the note alone)");
  assert.equal(p.steps[1].op, "delete");
  assert.match(planFix(parseNote("needs clearance"), door, opts).unclear[0], /kit's rules for Doors/);
  assert.equal(planFix(parseNote("needs 600 clearance"), door, opts).steps[0].op, "add_clearance");
  assert.match(planFix(parseNote("same as the other one"), door, opts).unclear[0], /which one/);
  assert.equal(planFix(parseNote("same as the other one"), { ...door, reference: { type_name: "FMC Door 1026 Single" } }, opts).steps[0].op, "change_type");
});
