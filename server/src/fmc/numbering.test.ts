import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import {
  DEFAULT_RULES, alphaLabel, formatNumber, naturalCompare, planNumbering, referenceProblems, resolveRules,
  type NumberingSnapshot,
} from "./numbering.js";
import { FMC_NUMBERING_SHAPE, runFmcNumbering, type FmcNumberingArgs } from "../tools/fmc_numbering.js";

function args(partial: Record<string, unknown>): FmcNumberingArgs {
  return z.object(FMC_NUMBERING_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> {
  return { ...(JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: result.isError === true };
}

const snapshot: NumberingSnapshot = {
  title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  path: "D:\\Jobs\\_Staging\\F26901.rvt",
  doors: [
    { id: "101", current: "7", level: "Level 1", level_elev: 0, x: 5000, y: 1000 },
    { id: "102", current: "3", level: "Level 1", level_elev: 0, x: 1000, y: 1000 },
    { id: "103", current: "", level: "Level 2", level_elev: 3000, x: 500, y: 500 },
  ],
  windows: [{ id: "201", current: "W-01", level: "Level 1", level_elev: 0, x: 100, y: 0 }],
  rooms: [
    { id: "301", current: "12", name: "Hall", level: "Level 1", level_elev: 0, x: 2000, y: 2000, placed: true },
    { id: "302", current: "5", name: "Store", level: "Level 1", level_elev: 0, x: 1000, y: 2000, placed: true },
    { id: "303", current: "", name: "Not placed", level: "", placed: false },
  ],
  sheets: [
    { id: "401", current: "A-10", name: "Plan 10" },
    { id: "402", current: "A-2", name: "Plan 2" },
    { id: "403", current: "A-3", name: "Plan 3" },
  ],
  views: [
    { id: "501", current: "9", sheet_id: "401", sheet_number: "A-10", view_name: "L1", x: 2, y: 0 },
    { id: "502", current: "4", sheet_id: "401", sheet_number: "A-10", view_name: "L2", x: 1, y: 0 },
    { id: "503", current: "1", sheet_id: "402", sheet_number: "A-2", view_name: "S1", x: 0, y: 0 },
  ],
  views_off_sheet: [{ id: "504", current: "", view_name: "Loose" }],
  grids: [
    { id: "601", current: "Z", name: "Z", direction: "horizontal", x: 0, y: 9000 },
    { id: "602", current: "Q", name: "Q", direction: "horizontal", x: 0, y: 3000 },
    { id: "603", current: "9", name: "9", direction: "vertical", x: 8000, y: 0 },
    { id: "604", current: "8", name: "8", direction: "vertical", x: 2000, y: 0 },
    { id: "605", current: "Dia", name: "Dia", direction: "other", x: 0, y: 0 },
  ],
};

const byId = (plan: ReturnType<typeof planNumbering>, category: string, id: string) =>
  plan.rows.find((r) => r.category === category && r.id === id)!;

test("alphaLabel runs A..Z, AA.. and can skip letters", () => {
  assert.equal(alphaLabel(1), "A");
  assert.equal(alphaLabel(26), "Z");
  assert.equal(alphaLabel(27), "AA");
  assert.equal(alphaLabel(28), "AB");
  assert.equal(alphaLabel(8, "IO"), "H");
  assert.equal(alphaLabel(9, "IO"), "J");
  assert.equal(alphaLabel(14, "IO"), "P");
});

test("formatNumber uses the prefix, separator and width", () => {
  assert.equal(formatNumber(DEFAULT_RULES.Doors, 5), "D-05");
  assert.equal(formatNumber({ ...DEFAULT_RULES.Doors, prefix: "" }, 5), "05");
  assert.equal(formatNumber(DEFAULT_RULES.Views, 12), "12");
  assert.equal(formatNumber({ ...DEFAULT_RULES.Rooms, prefix: "G", separator: "" }, 7), "G007");
});

test("naturalCompare puts A-2 before A-10", () => {
  assert.deepEqual(["A-10", "A-2", "A-3"].sort(naturalCompare), ["A-2", "A-3", "A-10"]);
});

test("doors and windows: level, then x, then y; old -> new for every item", () => {
  const plan = planNumbering(snapshot, { categories: ["Doors", "Windows"] });
  assert.equal(plan.rows.filter((r) => r.category === "Doors").length, 3);
  assert.deepEqual(
    [byId(plan, "Doors", "102").new, byId(plan, "Doors", "101").new, byId(plan, "Doors", "103").new],
    ["D-01", "D-02", "D-03"],
  );
  assert.equal(byId(plan, "Doors", "101").old, "7");
  assert.equal(byId(plan, "Doors", "101").status, "rename");
  assert.equal(byId(plan, "Windows", "201").new, "W-01");
  assert.equal(byId(plan, "Windows", "201").status, "unchanged");
  assert.equal(plan.counts.total, 4);
  assert.equal(plan.can_write, true);
});

test("y_then_x ordering and level blocks", () => {
  const plan = planNumbering(snapshot, {
    categories: ["Rooms"],
    rules: { Rooms: { order: "y_then_x", level_block: 100, prefix: "" } },
  });
  assert.equal(byId(plan, "Rooms", "302").new, "001");
  assert.equal(byId(plan, "Rooms", "301").new, "002");
  const doors = planNumbering(snapshot, { categories: ["Doors"], rules: { Doors: { level_block: 100, width: 3 } } });
  assert.equal(byId(doors, "Doors", "102").new, "D-001");
  assert.equal(byId(doors, "Doors", "101").new, "D-002");
  assert.equal(byId(doors, "Doors", "103").new, "D-101");
});

test("an unplaced room is skipped with a reason and still has a row", () => {
  const plan = planNumbering(snapshot, { categories: ["Rooms"] });
  const row = byId(plan, "Rooms", "303");
  assert.equal(row.status, "skipped");
  assert.equal(row.code, "FMC-NUM-SKIPPED");
  assert.ok(row.reason);
  assert.equal(plan.rows.length, 3);
});

test("sheets keep their natural order and take the prefix", () => {
  const plan = planNumbering(snapshot, { categories: ["Sheets"] });
  assert.equal(byId(plan, "Sheets", "402").new, "A-0001");
  assert.equal(byId(plan, "Sheets", "403").new, "A-0002");
  assert.equal(byId(plan, "Sheets", "401").new, "A-0003");
});

test("views restart on each sheet; a view off a sheet is skipped", () => {
  const plan = planNumbering(snapshot, { categories: ["Views"] });
  assert.equal(byId(plan, "Views", "502").new, "1");
  assert.equal(byId(plan, "Views", "501").new, "2");
  assert.equal(byId(plan, "Views", "503").new, "1");
  assert.equal(byId(plan, "Views", "503").status, "unchanged");
  assert.equal(byId(plan, "Views", "504").status, "skipped");
  assert.equal(plan.duplicates.length, 0);
});

test("grids: vertical numeric by x, horizontal alphabetic by y, others skipped", () => {
  const plan = planNumbering(snapshot, { categories: ["Grids"] });
  assert.equal(byId(plan, "Grids", "604").new, "1");
  assert.equal(byId(plan, "Grids", "603").new, "2");
  assert.equal(byId(plan, "Grids", "602").new, "A");
  assert.equal(byId(plan, "Grids", "601").new, "B");
  assert.equal(byId(plan, "Grids", "605").status, "skipped");
});

test("a swap is not a duplicate: the final numbers are what count", () => {
  const swap: NumberingSnapshot = {
    sheets: [{ id: "1", current: "A-0002", name: "a" }, { id: "2", current: "A-0001", name: "b" }],
  };
  const plan = planNumbering(swap, { categories: ["Sheets"] });
  assert.equal(plan.duplicates.length, 0);
  assert.equal(byId(plan, "Sheets", "2").new, "A-0001");
  assert.equal(byId(plan, "Sheets", "1").new, "A-0002");
  assert.equal(plan.can_write, false, "already in order: nothing to write");
  assert.equal(plan.counts.unchanged, 2);
});

test("a number kept outside the scope that collides is a duplicate error on every item that carries it", () => {
  const snap: NumberingSnapshot = {
    doors: [
      { id: "1", current: "5", level: "Level 1", level_elev: 0, x: 0, y: 0 },
      { id: "2", current: "D-01", level: "Level 2", level_elev: 3000, x: 0, y: 0 },
    ],
  };
  const plan = planNumbering(snap, { categories: ["Doors"], levels: ["Level 1"] });
  assert.equal(byId(plan, "Doors", "2").status, "error");
  assert.equal(byId(plan, "Doors", "1").status, "error");
  assert.equal(byId(plan, "Doors", "1").code, "FMC-NUM-DUPLICATE");
  assert.deepEqual(plan.duplicates.map((d) => d.number), ["D-01"]);
  assert.equal(plan.can_write, false);
  assert.equal(plan.counts.error, 2);
});

test("duplicates that already exist are errors, case does not hide them", () => {
  const snap: NumberingSnapshot = { rooms: [
    { id: "1", current: "r1", placed: false }, { id: "2", current: "R1", placed: false },
  ] };
  const plan = planNumbering(snap, { categories: ["Rooms"] });
  assert.equal(plan.counts.error, 2);
});

test("bad rules and unknown categories are refused", () => {
  assert.throws(() => resolveRules({ Doors: { prefix: "D:" } }, ["Doors"]), /FMC-NUM-BAD-RULE/);
  assert.throws(() => resolveRules({ Doors: { step: 0 } }, ["Doors"]), /FMC-NUM-BAD-RULE/);
  assert.throws(() => resolveRules({ Doors: { width: 12 } }, ["Doors"]), /FMC-NUM-BAD-RULE/);
  assert.throws(() => planNumbering({}, { categories: ["Stairs"] }), /Unknown category/);
});

test("referenceProblems needs kit, standards and rulebook", () => {
  assert.ok(referenceProblems(undefined));
  assert.ok(referenceProblems({ kit: ["a"], standards: ["b"] }));
  assert.equal(referenceProblems({ kit: ["a"], standards: ["b"], rulebook: ["c"] }), null);
});

test("policy: the read is a read, the apply is a write", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_numbering"));
  assert.ok(WRITE_COMMANDS.has("fmc_numbering_apply"));
  assert.ok(!WRITE_COMMANDS.has("fmc_numbering"));
});

const guard: GuardConfig = { ...DEFAULT_CONFIG };

test("dry run is the default: every item is reported and nothing is applied", async () => {
  let applied = 0;
  const out = textOf(await runFmcNumbering(args({ document: "F26901" }), {
    read: async () => snapshot,
    apply: async () => { applied += 1; return {}; },
    guard,
  }));
  assert.equal(out.dry_run, true);
  assert.equal(out.read_only, true);
  assert.equal(applied, 0);
  assert.equal(out.items.length, out.counts.total);
  assert.equal(out.counts.total, 3 + 1 + 3 + 3 + 4 + 5);
  assert.ok(out.items.every((i: any) => typeof i.old === "string" && typeof i.new === "string" && i.status));
  assert.equal(out.saved, false);
  assert.ok(out.defaults_need_confirmation);
});

test("a document is required", async () => {
  const out = textOf(await runFmcNumbering(args({}), { read: async () => snapshot, guard }));
  assert.equal(out.code, "FMC-DOC-REQUIRED");
  assert.equal(out.isError, true);
});

test("a write is refused while a duplicate exists, and the add-in is never called", async () => {
  let applied = 0;
  const dup: NumberingSnapshot = { rooms: [{ id: "1", current: "1", placed: false }, { id: "2", current: "1", placed: false }, { id: "3", current: "9", x: 0, y: 0, placed: true }] };
  const out = textOf(await runFmcNumbering(
    args({ document: "F26901", categories: ["Rooms"], dry_run: false, batch_lease: "L1", references: { kit: ["k"], standards: ["s"], rulebook: ["r"] } }),
    { read: async () => dup, apply: async () => { applied += 1; return {}; }, guard },
  ));
  assert.equal(out.code, "FMC-NUM-DUPLICATE");
  assert.equal(out.isError, true);
  assert.equal(applied, 0);
});

test("a write needs a lease and references", async () => {
  const io = { read: async () => snapshot, apply: async () => ({}), guard };
  const noLease = textOf(await runFmcNumbering(args({ document: "F26901", categories: ["Doors"], dry_run: false }), io));
  assert.equal(noLease.code, "FMC-BATCH-LOCKED");
  const noRefs = textOf(await runFmcNumbering(args({ document: "F26901", categories: ["Doors"], dry_run: false, batch_lease: "L1" }), io));
  assert.equal(noRefs.code, "FMC-NUM-REFERENCES");
});

test("a clean write sends only the renames and merges the add-in's results", async () => {
  let body: Record<string, any> = {};
  const out = textOf(await runFmcNumbering(
    args({ document: "F26901", categories: ["Doors", "Windows"], dry_run: false, batch_lease: "L1", references: { kit: ["k"], standards: ["s"], rulebook: ["r"] } }),
    {
      read: async () => snapshot,
      apply: async (b) => {
        body = b;
        return { ok: true, renamed: 3, results: (b.ops as any[]).map((o) => ({ category: o.category, id: o.id, written: true, result: "ok" })) };
      },
      guard,
    },
  ));
  assert.equal(out.isError, false);
  assert.equal(body.ops.length, 3, "the unchanged window is not sent");
  assert.deepEqual(body.ops[0], { category: "Doors", id: "102", old: "3", new: "D-01" });
  const written = out.items.filter((i: any) => i.written === true);
  assert.equal(written.length, 3);
  assert.equal(out.saved, false);
  assert.equal(out.synced, false);
});

test("a central model and HEBERT HOSTELS are not written", async () => {
  const refs = { kit: ["k"], standards: ["s"], rulebook: ["r"] };
  const central = textOf(await runFmcNumbering(args({ document: "x", categories: ["Doors"], dry_run: false, batch_lease: "L", references: refs }),
    { read: async () => ({ ...snapshot, is_central: true }), apply: async () => ({}), guard }));
  assert.equal(central.code, "FMC-NUM-GUARD");
  const hebert = textOf(await runFmcNumbering(args({ document: "x", categories: ["Doors"], dry_run: false, batch_lease: "L", references: refs }),
    { read: async () => ({ ...snapshot, title: "HEBERT HOSTELS A" }), apply: async () => ({}), guard }));
  assert.equal(hebert.code, "FMC-NUM-GUARD");
});

test("a refused read is passed on", async () => {
  const out = textOf(await runFmcNumbering(args({ document: "x" }), { read: async () => ({ refused: true, code: "FMC-DOC-NOT-OPEN", message: "not open" }), guard }));
  assert.equal(out.code, "FMC-DOC-NOT-OPEN");
});