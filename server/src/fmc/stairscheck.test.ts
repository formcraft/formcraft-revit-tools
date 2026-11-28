import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";
import {
  overall, parseInverseSlope, resolveRules, runChecks, summarise,
  type CheckInput, type CheckRow, type ElementRow, type RuleSet,
} from "./stairscheck.js";
import { FMC_STAIRS_CHECK_SHAPE, runFmcStairsCheck, type FmcStairsCheckArgs } from "../tools/fmc_stairs_check.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function args(partial: Record<string, unknown>): FmcStairsCheckArgs {
  return z.object(FMC_STAIRS_CHECK_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> & { isError: boolean } {
  const body = JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, any>;
  return { ...body, isError: result.isError === true };
}

/** The shape of the real kit bank for the keys this tool reads (values and notes as in FMC_Standards_Building.json). */
const bank = {
  standards: {
    "stairs.riser_max": { value: 175, range: [150, 190], uses: { residential: 175, office: 170, education: 170 }, note: "Uganda National Building Code 2019, para 41(3)(a)" },
    "stairs.going_min": { value: 280, uses: { residential: 250 }, note: "Uganda National Building Code 2019, para 41(3)(a)" },
    "stairs.width_min": { value: 1200, uses: { residential: 900 }, note: "Uganda National Building Code 2019, para 41(3)(a)" },
    "stairs.headroom": { value: 2100, note: "Uganda National Building Code 2019, paras 41-42" },
    "stairs.risers_per_flight_max": { value: 16, uses: { default: 16, assembly_buildings: 15 }, note: "a landing after at most 16 risers" },
    "stairs.landing_depth": { value: "stair width", note: "at least the stair width" },
    "stairs.handrail_height": { value: 900, range: [850, 1000], note: "kit" },
    "guards.stair_and_landing": { value: 900, note: "Uganda National Building Code 2019, para 43(5)" },
    "accessibility.ramp_gradient_max": { value: "1:12", note: "SI 52, para 12(3)(a)" },
    "accessibility.ramp": { value: { gradient_max: "1:12", width_min_mm: 1100, landing_length_min_mm: 1500, rise_max_combined_mm: 3600, handrails: "both sides; middle rail when wider than 2400" }, note: "SI 52 para 12(3)" },
    "accessibility.stair": { value: { width_min_mm: 900, riser_max_mm: 170, landing_length_min_mm: 1100, handrails: "both sides" }, note: "SI 52 para 13" },
    "accessibility.handrail": { value: { height_mm: [870, 1000] }, note: "SI 52 para 14" },
  },
};

const goodStair = {
  id: "100", name: "Stair 1", type: "Monolithic", level: "Level 1", source: "host",
  riser_mm: 170, tread_mm: 280, risers: 18,
  runs: [{ id: "101", width_mm: 1250, risers: 9 }, { id: "102", width_mm: 1250, risers: 9 }],
  landings: [{ id: "103", width_mm: 1300, depth_mm: 1250 }],
  railing_ids: ["200", "201"],
};
const badStair = {
  id: "110", name: "Stair 2", level: "Level 2", source: "host",
  riser_mm: 190, tread_mm: 230, risers: 20,
  runs: [{ id: "111", width_mm: 1000, risers: 20 }],
  landings: [{ id: "113", width_mm: 900, depth_mm: 800 }],
  railing_ids: [],
};
const sketchStair = { id: "120", name: "Sketch stair", level: "Level 1", source: "host", method: "sketch", riser_mm: 175, tread_mm: 280, risers: 10, railing_ids: [] };
const ramp = { id: "300", name: "Ramp 1", level: "Level 1", source: "host", max_incline_inv: 12, rise_mm: 900, railing_ids: ["202"] };
const steepRamp = { id: "310", name: "Ramp 2", level: "Level 1", source: "host", max_incline_inv: 8, rise_mm: 4000, railing_ids: [] };
const railings = [
  { id: "200", level: "Level 1", source: "host", host_id: "100", host_kind: "stair", handrail_height_mm: 900, top_rail_height_mm: 950 },
  { id: "201", level: "Level 1", source: "host", host_id: "100", host_kind: "stair", handrail_height_mm: 900, top_rail_height_mm: 900 },
  { id: "202", level: "Level 1", source: "host", host_id: "300", host_kind: "ramp", handrail_height_mm: 1100, top_rail_height_mm: null },
  { id: "203", level: "Level 1", source: "host", host_id: "9", host_kind: "other", handrail_height_mm: null, top_rail_height_mm: 1100 },
  { id: "204", level: "Level 2", source: "link", link: "S", host_id: "1", host_kind: "stair", handrail_height_mm: 800, top_rail_height_mm: 800 },
];
const input: CheckInput = { stairs: [goodStair, badStair, sketchStair], ramps: [ramp, steepRamp], railings };

function find(rows: ElementRow[], id: string): ElementRow {
  const hit = rows.find((row) => row.id === id);
  assert.ok(hit, `no row for ${id}`);
  return hit;
}
function check(row: ElementRow, name: string, where?: string): CheckRow {
  const hit = row.checks.find((c) => c.check === name && (where == null || c.where === where));
  assert.ok(hit, `no check ${name} on ${row.id}`);
  return hit;
}

test("kit numbers come from the bank, with the clause, and the use class picks the uses table", () => {
  const rules = resolveRules(bank, {});
  assert.equal(rules.stair.riser.value, 175);
  assert.equal(rules.stair.riser.can_pass, true);
  assert.equal(rules.stair.riser.source, "standards");
  assert.match(rules.stair.riser.clause, /Uganda National Building Code/);
  assert.equal(rules.stair.going.value, 280);
  assert.equal(rules.stair.landing_depth.relative_to, "stair_width");
  assert.equal(rules.stair.handrail_height.value, 850);
  assert.equal(rules.stair.handrail_height.value_max, 1000);
  assert.equal(rules.ramp.gradient.value, 12);
  assert.equal(rules.ramp.rise.value, 3600);
  assert.equal(rules.ramp.width.value, 1100);
  assert.equal(rules.ramp.handrail_count.value, 2);
  const office = resolveRules(bank, { use: "Office" });
  assert.equal(office.stair.riser.value, 170);
  assert.equal(office.stair.going.value, 280);
  const home = resolveRules(bank, { use: "residential" });
  assert.equal(home.stair.going.value, 250);
  assert.equal(home.stair.width.value, 900);
  assert.equal(parseInverseSlope("1:12"), 12);
  assert.equal(parseInverseSlope("1 in 20"), 20);
  assert.equal(parseInverseSlope("steep"), null);
});

test("a missing bank key is a labelled provisional default and cannot pass", () => {
  const none = resolveRules(null, {});
  assert.equal(none.stair.riser.value, null);
  assert.equal(none.stair.riser.can_pass, false);
  const twoRG = none.stair.two_r_plus_g;
  assert.equal(twoRG.value, 550);
  assert.equal(twoRG.value_max, 700);
  assert.equal(twoRG.source, "provisional");
  assert.equal(twoRG.can_pass, false);
  assert.match(twoRG.clause, /PROVISIONAL/);
  const rows = runChecks({ stairs: [goodStair], railings }, none, {});
  const stair = find(rows, "100");
  assert.equal(check(stair, "two_r_plus_g").status, "provisional");
  assert.equal(check(stair, "riser_height").status, "not_applicable");
  assert.equal(stair.checks.some((c) => c.status === "pass"), false);
  const asked = resolveRules(bank, { overrides: { two_r_plus_g_min_mm: 600, two_r_plus_g_max_mm: 650 } });
  assert.equal(asked.stair.two_r_plus_g.value, 600);
  assert.equal(asked.stair.two_r_plus_g.can_pass, false);
  const proposed = resolveRules({ standards: { "stairs.riser_max": { value: 175, status: "proposed", note: "x" } } }, {});
  assert.equal(proposed.stair.riser.can_pass, false);
});

test("a good stair passes, a bad stair fails with measured against required", () => {
  const rows = runChecks(input, resolveRules(bank, {}), {});
  const good = find(rows, "100");
  assert.equal(check(good, "riser_height").status, "pass");
  assert.equal(check(good, "riser_height").measured, 170);
  assert.equal(check(good, "riser_height").required, 175);
  assert.equal(check(good, "going").status, "pass");
  assert.equal(check(good, "run_width").status, "pass");
  assert.equal(check(good, "risers_per_flight").status, "pass");
  assert.equal(check(good, "landing_depth").status, "pass");
  assert.equal(check(good, "landing_depth").required, 1250);
  assert.equal(check(good, "headroom").status, "not_applicable");
  assert.match(check(good, "headroom").note, /fmc_headroom/);
  // 2 x 170 + 280 = 620, inside the provisional 550 to 700: it cannot pass
  assert.equal(check(good, "two_r_plus_g").measured, 620);
  assert.equal(check(good, "two_r_plus_g").status, "provisional");
  assert.equal(check(good, "handrail_count").status, "provisional");
  assert.equal(check(good, "handrail_height", "handrail 1").status, "pass");
  assert.equal(good.status, "provisional");

  const bad = find(rows, "110");
  assert.equal(bad.status, "fail");
  assert.equal(check(bad, "riser_height").status, "fail");
  assert.equal(check(bad, "riser_height").measured, 190);
  assert.equal(check(bad, "going").status, "fail");
  assert.equal(check(bad, "run_width").status, "fail");
  assert.equal(check(bad, "risers_per_flight").status, "fail");
  assert.equal(check(bad, "risers_per_flight").measured, 20);
  assert.equal(check(bad, "landing_depth").status, "fail");
  assert.equal(check(bad, "landing_depth").required, 1000);
  assert.equal(check(bad, "landing_depth").measured, 800);
  assert.equal(check(bad, "handrail_count").status, "fail");
  assert.equal(check(bad, "handrail_height").status, "not_applicable");
});

test("tolerance, and a sketch stair has not_applicable for what Revit does not give", () => {
  const rules = resolveRules(bank, {});
  const edge = runChecks({ stairs: [{ ...goodStair, id: "1", riser_mm: 175.4, tread_mm: 279.6 }] }, rules, {});
  assert.equal(check(edge[0], "riser_height").status, "pass");
  assert.equal(check(edge[0], "going").status, "pass");
  const over = runChecks({ stairs: [{ ...goodStair, id: "2", riser_mm: 175.6 }] }, rules, {});
  assert.equal(check(over[0], "riser_height").status, "fail");
  const sketch = find(runChecks(input, rules, {}), "120");
  assert.equal(check(sketch, "run_width").status, "not_applicable");
  assert.match(check(sketch, "run_width").note, /Sketch-based/);
  assert.equal(check(sketch, "risers_per_flight").status, "not_applicable");
  assert.equal(check(sketch, "riser_height").status, "pass");
});

test("ramps: gradient and rise, an approximate rise cannot pass, width is not applicable", () => {
  const rows = runChecks(input, resolveRules(bank, {}), {});
  const ok = find(rows, "300");
  assert.equal(check(ok, "ramp_gradient").status, "pass");
  assert.equal(check(ok, "ramp_gradient").measured, "1:12");
  assert.equal(check(ok, "ramp_rise").status, "provisional");
  assert.equal(check(ok, "ramp_rise").approximate, true);
  assert.equal(check(ok, "ramp_width").status, "not_applicable");
  assert.equal(check(ok, "handrail_count").status, "fail");
  assert.equal(check(ok, "handrail_count").required, 2);
  const steep = find(rows, "310");
  assert.equal(steep.status, "fail");
  assert.equal(check(steep, "ramp_gradient").status, "fail");
  assert.equal(check(steep, "ramp_gradient").measured, "1:8");
  assert.equal(check(steep, "ramp_rise").status, "fail");
});

test("railings: handrail range and the stair guard height, and other hosts are not applicable", () => {
  const rows = runChecks(input, resolveRules(bank, {}), {});
  const a = find(rows, "200");
  assert.equal(check(a, "handrail_height").status, "pass");
  assert.equal(check(a, "guard_height").status, "pass");
  const b = find(rows, "201");
  assert.equal(check(b, "guard_height").status, "pass");
  const ramps = find(rows, "202");
  assert.equal(check(ramps, "guard_height").status, "not_applicable");
  assert.equal(check(ramps, "handrail_height").status, "fail");
  const other = find(rows, "203");
  assert.equal(check(other, "handrail_height").status, "not_applicable");
  assert.equal(check(other, "guard_height").status, "not_applicable");
  assert.equal(other.status, "not_applicable");
  const link = find(rows, "204");
  assert.equal(link.status, "fail");
  assert.equal(link.source, "link");
});

test("accessible adds the accessible-route checks", () => {
  const rules = resolveRules(bank, { accessible: true });
  assert.equal(rules.stair.handrail_count.value, 2);
  assert.equal(rules.stair.handrail_height.value, 870);
  const rows = runChecks({ stairs: [goodStair, { ...goodStair, id: "9", riser_mm: 172, railing_ids: ["200"] }], railings }, rules, { accessible: true });
  const a = find(rows, "100");
  assert.equal(check(a, "riser_height_accessible").status, "pass");
  assert.equal(check(a, "landing_length_accessible").status, "pass");
  assert.equal(check(a, "handrail_count").status, "pass");
  const b = find(rows, "9");
  assert.equal(check(b, "riser_height_accessible").status, "fail");
  assert.equal(check(b, "riser_height_accessible").required, 170);
  assert.equal(check(b, "handrail_count").status, "fail");
});

test("kinds and levels filter, every element gets a row, duplicates are errors, and the summary adds up", () => {
  const rules = resolveRules(bank, {});
  const all = runChecks(input, rules, {});
  assert.equal(all.length, 3 + 2 + 5);
  assert.ok(all.every((row) => row.checks.length > 0));
  const summary = summarise(all);
  assert.equal(summary.elements, 10);
  assert.equal(summary.by_kind.stair, 3);
  assert.equal(summary.by_kind.ramp, 2);
  assert.equal(summary.by_kind.railing, 5);
  assert.equal(summary.by_status.pass + summary.by_status.fail + summary.by_status.provisional + summary.by_status.not_applicable, 10);
  assert.equal(overall(summary), "FAIL");
  assert.equal(overall(summarise([])), "NO_ELEMENTS");
  const rampsOnly = runChecks(input, rules, { kinds: ["ramp"] });
  assert.deepEqual(rampsOnly.map((row) => row.kind), ["ramp", "ramp"]);
  const level2 = runChecks(input, rules, { levels: ["level 2"] });
  assert.deepEqual(level2.map((row) => row.id).sort(), ["110", "204"]);
  assert.throws(() => runChecks({ stairs: [goodStair, goodStair] }, rules, {}), /FMC-STAIRS-DUPLICATE/);
  assert.equal(overall(summarise(runChecks({ stairs: [{ ...goodStair, id: "x" }], railings: [] }, resolveRules(bank, {}), { kinds: ["stair"] }))), "PROVISIONAL");
});

test("the tool is read-only, names the document, writes a full report, and the add-in starts no transaction", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-stairs-check-"));
  const env = { ...process.env, APPDATA: dir, LOCALAPPDATA: dir, FMC_STAIRS_CHECK_DIR: path.join(dir, "stairs_check"), FMC_STANDARDS_FILE: path.join(dir, "missing.json") } as NodeJS.ProcessEnv;
  const missing = textOf(await runFmcStairsCheck(args({}), { env, standards: bank }));
  assert.equal(missing.code, "FMC-DOC-REQUIRED");
  assert.equal(missing.isError, true);

  const refused = textOf(await runFmcStairsCheck(args({ document: "A" }), { env, standards: bank, read: async () => ({ code: "FMC-DOC-NOT-OPEN", message: "not open" }) }));
  assert.equal(refused.code, "FMC-DOC-NOT-OPEN");
  assert.equal(refused.refused, true);

  const seen: Record<string, unknown>[] = [];
  const body = textOf(await runFmcStairsCheck(args({ document: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", element_limit: 3, use: "residential" }), {
    env, standards: bank,
    read: async (b) => {
      seen.push(b);
      return { resolved_document: { title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", path: "D:\\Jobs\\_Staging\\A.rvt" }, notes: ["note"], unloaded_links: ["L"], ...input };
    },
  }));
  assert.equal(seen.length, 1);
  assert.equal(body.isError, false);
  assert.equal(body.read_only, true);
  assert.equal(body.transaction, false);
  assert.equal(body.applied, false);
  assert.equal(body.status, "FAIL");
  assert.equal(body.summary.elements, 10);
  assert.equal(body.elements.length, 3);
  assert.equal(body.truncated, true);
  assert.ok(Array.isArray(body.needs_confirmation) && body.needs_confirmation.some((n: { key: string }) => n.key === "stairs.two_r_plus_g_mm"));
  const saved = JSON.parse(fs.readFileSync(body.report, "utf8"));
  assert.equal(saved.elements.length, 10);
  assert.equal(saved.summary.elements, 10);

  const source = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcStairsCheck.cs"), "utf8");
  assert.equal(source.includes("new Transaction"), false);
  assert.equal(source.includes("TransactionGroup"), false);
  assert.equal(source.includes("RollBack"), false);
  assert.equal(/\.(Delete|Move|SetValue)\(/.test(source), false);
  assert.equal(/\.Set\([^)]/.test(source), false);
  assert.match(source, /GetStairsRuns/);
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_stairs_check"));
  assert.equal(WRITE_COMMANDS.has("fmc_stairs_check"), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  assert.ok(manifest.commands.some((c) => c.commandName === "fmc_stairs_check"));
});