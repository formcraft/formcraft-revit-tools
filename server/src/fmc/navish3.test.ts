import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, GuardConfig } from "./policy.js";
import { ClashMatrix, coverage, idOfTest, matrixProblems, planTests, testName } from "./clashmatrix.js";
import { defaultFederatedFile, federatedPathProblems, federationPlan, findDisciplineModels } from "./federate.js";
import { NavisClashRow, cloudPlan, newestTest, resolveClashItems, sameModel, statusHash } from "./clashback.js";
import { exchangeRoot, link, listPackages, loadIdentity } from "../hub/exchange.js";
import { FMC_NAVIS_SHAPE, NavisDeps, runFmcNavis } from "../tools/fmc_navis.js";
import { registerFile } from "../tools/fmc_review.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(HERE, "../../../tests/navis/FMC_Clash_Matrix_sample.json");
const sample = (): ClashMatrix => JSON.parse(fs.readFileSync(SAMPLE, "utf8"));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fmc-h3-"));
const touch = (file: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "x"); };
const parse = (a: Record<string, unknown>) => z.object(FMC_NAVIS_SHAPE).parse(a);
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

const S = "F26001-FMC-ZZ-ZZ-M3-S-0001", M = "F26001-FMC-ZZ-ZZ-M3-M-0001", A = "F26001-FMC-ZZ-ZZ-M3-A-0001";

// ---- the clash matrix ---------------------------------------------------------------------------------------------------

test("H3: the sample clash matrix is valid fmc-clash-matrix/0.1", () => {
  assert.deepEqual(matrixProblems(sample()), []);
  const proposal = JSON.parse(fs.readFileSync(path.resolve(HERE, "../../../docs/kit-proposals/FMC_Clash_Matrix.json"), "utf8"));
  assert.deepEqual(matrixProblems(proposal), [], "the kit change request's proposal is valid too");
});

test("H3: a broken matrix is refused with every reason", () => {
  const bad = { schema: "fmc-clash-matrix/9", name: "", revision: "P01", tests: [
    { id: "X", a: { role: "S" }, b: { role: "QQ" }, type: "hard" },
    { id: "X", a: { role: "S", set: "Ceilings" }, b: {}, type: "clearance" },
    { id: "Y", a: { role: "S" }, b: { role: "M" }, type: "soft", tolerance_mm: -1 },
  ] };
  const p = matrixProblems(bad).join("\n");
  assert.match(p, /schema must be/);
  assert.match(p, /needs a name/);
  assert.match(p, /QQ is not a role code/);
  assert.match(p, /id X is used twice/);
  assert.match(p, /either roles or a set/);
  assert.match(p, /side b needs a role/);
  assert.match(p, /clearance test needs tolerance_mm/);
  assert.match(p, /type must be/);
  assert.match(p, /tolerance_mm must be 0 to 5000/);
  assert.deepEqual(matrixProblems(null), ["The clash matrix isn't a JSON object"]);
});

test("H3: Formcraft tests are named FMC <id> …, and only those carry an id", () => {
  const m = sample();
  const t = m.tests.find((x) => x.id === "CLG-M")!;
  assert.equal(testName(t), "FMC CLG-M · set FMC Coordination/Ceilings vs M (clearance 50 mm)");
  assert.equal(idOfTest(testName(t)), "CLG-M");
  assert.equal(idOfTest("FMC S-M"), "S-M");
  assert.equal(idOfTest("Structure vs Ducts"), null, "a person's test");
  const planned = planTests(m, ["MEP-FP", "CLG-M"]);
  assert.deepEqual(planned.map((x) => x.id), ["MEP-FP", "CLG-M"]);
  assert.deepEqual(planned[0].a, { roles: ["M", "P", "E"] });
  assert.deepEqual(planned[1].a, { set: "FMC Coordination/Ceilings" });
  const cov = coverage(planTests(m, ["S-M", "S-FP"]), [`D:\\P\\${S}.nwc`, `D:\\P\\${M}.rvt`]);
  assert.deepEqual(cov.map((c) => [c.id, c.ready, c.missing_roles]), [["S-M", true, []], ["S-FP", false, ["FP"]]]);
});

// ---- federation ---------------------------------------------------------------------------------------------------------

function project() {
  const pf = tmp();
  touch(path.join(pf, "02_Shared", "S", `${S}.nwc`));
  touch(path.join(pf, "01_WIP", "S", `${S}.rvt`)); // shared wins
  touch(path.join(pf, "01_WIP", "M", `${M}.rvt`));
  touch(path.join(pf, "01_WIP", "M", `${M}.nwc`)); // NWC wins over RVT
  touch(path.join(pf, "01_WIP", "M", "_Archive", "F26001-FMC-ZZ-ZZ-M3-M-0002.rvt")); // archived: never
  touch(path.join(pf, "01_WIP", "A", `${A}.0001.rvt`)); // a Revit backup: never
  touch(path.join(pf, "01_WIP", "A", `${A}.rvt`));
  touch(path.join(pf, "01_WIP", "Z", "F26001-FMC-ZZ-ZZ-M3-Z-0001.nwd")); // a federation: never
  touch(path.join(pf, "01_WIP", "A", "notes.rvt")); // not a container name
  return pf;
}

test("H3: discipline models are found by container name, shared before WIP, NWC before RVT", () => {
  const pf = project();
  const found = findDisciplineModels(pf);
  assert.deepEqual(found.map((m) => [m.role, path.basename(m.file), m.area]), [
    ["A", `${A}.rvt`, "wip"], ["M", `${M}.nwc`, "wip"], ["S", `${S}.nwc`, "shared"]]);
  assert.deepEqual(findDisciplineModels(pf, { source: "wip", roles: ["s"] }).map((m) => path.basename(m.file)), [`${S}.rvt`]);
  const out = defaultFederatedFile(pf, found);
  assert.equal(out, path.win32.join(pf, "01_WIP", "_Navisworks", "F26001-FMC-ZZ-ZZ-M3-Z-0001.nwf"));
  const plan = federationPlan(found, [`C:\\x\\${S}.nwc`]);
  assert.deepEqual(plan.append.map((m) => m.role), ["A", "M"]);
  assert.deepEqual(plan.already.map((m) => m.role), ["S"]);
});

test("H3: the federation is saved only as a container-named .nwf in 01_WIP inside the write roots", () => {
  const cfg: GuardConfig = { ...DEFAULT_CONFIG, write_roots: ["D:\\Projects\\*\\01_WIP"] };
  assert.deepEqual(federatedPathProblems("D:\\Projects\\F26001\\01_WIP\\_Navisworks\\F26001-FMC-ZZ-ZZ-M3-Z-0001.nwf", cfg), []);
  assert.match(federatedPathProblems("D:\\Projects\\F26001\\02_Shared\\F26001-FMC-ZZ-ZZ-M3-Z-0001.nwf", cfg).join(" "), /only in the project's 01_WIP.*02_shared is a CDE gate/i);
  assert.match(federatedPathProblems("D:\\Projects\\F26001\\01_WIP\\fed.nwd", cfg).join(" "), /\.nwf/);
  assert.match(federatedPathProblems("D:\\Projects\\F26001\\01_WIP\\federated.nwf", cfg).join(" "), /container name/);
});

// ---- the tool, with a stand-in bridge --------------------------------------------------------------------------------------

function bridge(answers: Record<string, (p: any) => Record<string, unknown>>) {
  const calls: Array<{ method: string; params: any }> = [];
  const deps: NavisDeps = {
    state: () => ({ port: 1, pid: 1, started: "" }),
    alive: () => true,
    call: async (method, params = {}) => {
      calls.push({ method, params });
      const a = answers[method];
      if (!a) throw new Error(`unexpected ${method}`);
      return a(params);
    },
  };
  return { calls, deps };
}

function setup() {
  const pf = project();
  const reports = tmp();
  const config: GuardConfig = { ...DEFAULT_CONFIG, write_roots: [path.win32.join(pf, "01_WIP")], reports_dir: reports, clash_matrix_file: path.join(reports, "none.json") };
  return { pf, config };
}

test("H3 federate: a dry run plans and writes nothing; the real run appends, archives the old .nwf and saves", async () => {
  const { pf, config } = setup();
  const out = path.win32.join(pf, "01_WIP", "_Navisworks", "F26001-FMC-ZZ-ZZ-M3-Z-0001.nwf");
  touch(out); // an older federation
  const b = bridge({
    navis_info: () => ({ file: "", models: [{ file: path.win32.join(pf, "02_Shared", "S", `${S}.nwc`), source: "" }] }),
    navis_append: (p) => ({ files: p.files.map((f: string) => ({ file: f, result: p.dry_run ? "would append" : "appended" })) }),
    navis_save_as: (p) => ({ saved: true, file: p.file }),
  });
  const dry = body(await runFmcNavis(parse({ action: "federate", project_folder: pf }), { ...b.deps, config }));
  assert.equal(dry.dry_run, true);
  assert.equal(dry.append.length, 2);
  assert.equal(dry.already_in_document.length, 1);
  assert.match(dry.archives, /_Archive/);
  assert.equal(b.calls.find((c) => c.method === "navis_append")!.params.dry_run, true);
  assert.ok(!b.calls.some((c) => c.method === "navis_save_as"), "a dry run never saves");
  assert.ok(fs.existsSync(out), "nothing moved in a dry run");

  const done = body(await runFmcNavis(parse({ action: "federate", project_folder: pf, dry_run: false }), { ...b.deps, config }));
  assert.equal(done.done, true);
  assert.ok(!fs.existsSync(out), "the old .nwf went to _Archive");
  assert.equal(fs.readdirSync(path.join(path.dirname(out), "_Archive")).length, 1);
  assert.equal(b.calls.filter((c) => c.method === "navis_save_as")[0].params.file, out);
  assert.equal(listPackages(exchangeRoot(pf, config.reports_dir))[0].what, "federation");
});

test("H3 federate: refused outside 01_WIP, and nothing is appended", async () => {
  const { pf, config } = setup();
  const b = bridge({ navis_info: () => ({ models: [] }) });
  const r = await runFmcNavis(parse({ action: "federate", project_folder: pf, output: path.win32.join(pf, "02_Shared", "F26001-FMC-ZZ-ZZ-M3-Z-0001.nwf"), dry_run: false }), { ...b.deps, config });
  assert.equal(r.isError, true);
  assert.ok(!b.calls.some((c) => c.method === "navis_append"));
});

test("H3 clash tests: no kit matrix is a kit change request; a named matrix makes FMC tests, dry run first", async () => {
  const { config } = setup();
  const b = bridge({
    navis_clash_create: (p) => ({ tests: p.tests.map((t: any) => ({ id: t.id, name: t.name, action: p.dry_run ? "create" : "created" })) }),
    navis_clash_tests: () => ({ tests: [{ name: "FMC S-M · S vs M (hard 10 mm)" }, { name: "Structure vs Ducts" }] }),
    navis_clash_run: (p) => ({ tests: p.tests.map((n: string) => ({ test: n, result: p.dry_run ? "would run" : "ran" })) }),
  });
  const none = body(await runFmcNavis(parse({ action: "clash_create" }), { ...b.deps, config }));
  assert.match(none.reasons[0], /kit change request/);

  const dry = body(await runFmcNavis(parse({ action: "clash_create", matrix: SAMPLE, tests: ["S-M", "DUP-A"] }), { ...b.deps, config }));
  assert.equal(dry.dry_run, true);
  const sent = b.calls.find((c) => c.method === "navis_clash_create")!.params;
  assert.equal(sent.dry_run, true);
  assert.ok(sent.tests.every((t: any) => t.name.startsWith("FMC ")));
  assert.equal(sent.tests[1].type, "duplicates");

  const run = body(await runFmcNavis(parse({ action: "clash_run", matrix: SAMPLE, tests: ["S-M", "S-P"] }), { ...b.deps, config }));
  assert.deepEqual(b.calls.find((c) => c.method === "navis_clash_run")!.params.tests, ["FMC S-M · S vs M (hard 10 mm)"], "only the matrix's FMC tests, never a person's");
  assert.deepEqual(run.not_created_yet, ["S-P"]);
});

// ---- clashes back to Revit ----------------------------------------------------------------------------------------------

const item = (model: string, id: string, category: string, guid = "") => ({ name: category, category, revit_id: id, source: `D:\\P\\${model}.nwc`, guid });
const rows = (): NavisClashRow[] => [
  { name: "Clash1", status: "New", distance_mm: -80, center_mm: [1000, 2000, 3000], item1: item(S, "412233", "Structural Framing", "11111111-2222-3333-4444-555555555555"), item2: item(M, "412233", "Ducts") },
  { name: "Clash2", status: "Active", distance_mm: -10, item1: item(S, "500", "Structural Columns"), item2: item(M, "900", "Ducts") },
  { name: "Clash3", status: "Resolved", distance_mm: -5, item1: item(S, "501", "Structural Columns"), item2: item(M, "901", "Ducts") },
];

test("H3 back: identity lookups keep element ids of different models apart", () => {
  const map = { version: 1 as const, entries: {} };
  const uid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-000649a9";
  const known = link(map, "revit", uid, { file: `${S}.rvt` });
  link(map, "navisworks", "11111111-2222-3333-4444-555555555555", { fmc: known });
  const dry = resolveClashItems(map, rows(), { record: false });
  assert.equal(dry.rows[0].item1.fmc, known, "found by its Navisworks item");
  assert.equal(dry.rows[0].item1.unique_id, uid);
  assert.equal(dry.known, 1);
  assert.equal(dry.unknown, 5);
  assert.equal(Object.keys(map.entries).length, 1, "a dry run links nothing");
  const real = resolveClashItems(map, rows(), { record: true, at: "2026-10-19T08:00:00Z" });
  assert.notEqual(real.rows[0].item2.fmc, real.rows[0].item1.fmc, "412233 in S and 412233 in M are two elements");
  assert.equal(real.linked, 5);
  const again = resolveClashItems(map, rows(), { record: true });
  assert.equal(again.linked, 0, "the second time every element is known");
  assert.ok(sameModel(`${S}_jdoe.rvt`, `D:\\P\\${S}.nwc`), "a workshared local copy is the same model");
  assert.equal(newestTest([{ name: "a", last_run: "2026-10-18T10:00:00" }, { name: "b", last_run: "2026-10-19T09:00:00" }, { name: "c" }]), "b");
});

test("H3 back: tickets through fmc_review's clash logic, dry run first; then clouds in the open model", async () => {
  const { pf, config } = setup();
  const b = bridge({
    navis_clash_tests: () => ({ tests: [{ name: "FMC S-M · S vs M (hard 10 mm)", last_run: "2026-10-19T08:00:00" }, { name: "Old", last_run: "2026-10-01T08:00:00" }] }),
    navis_clash_results: (p) => ({ test: p.test, results: rows() }),
  });
  const dry = body(await runFmcNavis(parse({ action: "back", project_folder: pf }), { ...b.deps, config }));
  assert.equal(dry.test, "FMC S-M · S vs M (hard 10 mm)", "the newest results");
  assert.equal(dry.would_add, 2);
  assert.ok(!fs.existsSync(registerFile(pf)), "a dry run writes no register");

  const done = body(await runFmcNavis(parse({ action: "back", project_folder: pf, dry_run: false, by: "Coordinator" }), { ...b.deps, config }));
  assert.equal(done.added.length, 2);
  const reg = JSON.parse(fs.readFileSync(registerFile(pf), "utf8"));
  assert.ok(reg.items[0].links.clash.items[0].fmc, "each clash item carries its Formcraft id");
  assert.equal(reg.items[0].source, "clash");
  assert.equal(Object.keys(loadIdentity(exchangeRoot(pf, config.reports_dir)).entries).length, 6, "every element of every clash, resolved ones too");
  const twice = body(await runFmcNavis(parse({ action: "back", project_folder: pf, dry_run: false }), { ...b.deps, config }));
  assert.equal(twice.added.length, 0, "a clash is ticketed once");

  const clouds: string[] = [];
  const review: NavisDeps["review"] = async (a) => { clouds.push(String(a.id)); return { content: [{ type: "text", text: JSON.stringify({ done: true }) }] }; };
  const plan = body(await runFmcNavis(parse({ action: "back", handover: "clouds", project_folder: pf, model: `${M}.rvt` }), { ...b.deps, config, review }));
  assert.equal(plan.dry_run, true);
  assert.deepEqual(plan.tickets.map((t: any) => t.element_ids), [[412233], [900]], "the M model's elements only");
  assert.equal(clouds.length, 0);
  const drawn = body(await runFmcNavis(parse({ action: "back", handover: "clouds", project_folder: pf, model: `${M}.rvt`, dry_run: false }), { ...b.deps, config, review }));
  assert.equal(drawn.clouds.length, 2);
  assert.equal(clouds.length, 2);
  const after = JSON.parse(fs.readFileSync(registerFile(pf), "utf8"));
  assert.deepEqual(after.items[1].element_ids, [900]);
});

test("H3 back: clouds wait for tickets", async () => {
  const { pf, config } = setup();
  const b = bridge({
    navis_clash_tests: () => ({ tests: [] }),
    navis_clash_results: () => ({ results: rows() }),
  });
  const r = body(await runFmcNavis(parse({ action: "back", handover: "clouds", project_folder: pf, test: "X", model: "m.rvt" }), { ...b.deps, config }));
  assert.match(r.reasons[0], /handover=tickets first/);
  assert.deepEqual(cloudPlan({ project: "", items: [] }, "X", "m.rvt").tickets, []);
});

test("H3 clash_status: only named results, only with a person's yes on the plan they saw", async () => {
  const { config } = setup();
  const b = bridge({
    navis_clash_status: (p) => ({ results: p.names.map((n: string) => ({ name: n, result: n === "Clash9" ? "missing" : p.dry_run ? "would set " + p.status : "set " + p.status })) }),
  });
  const deps = { ...b.deps, config };
  const none = body(await runFmcNavis(parse({ action: "clash_status", test: "FMC S-M", set_status: "Approved" }), deps));
  assert.match(none.reasons.join(" "), /Name the clash results/);
  const dry = body(await runFmcNavis(parse({ action: "clash_status", test: "FMC S-M", names: ["Clash1", "Clash9"], set_status: "Approved", comment: "Accepted: sleeve" }), deps));
  assert.equal(dry.dry_run, true);
  assert.equal(dry.plan_hash, statusHash("FMC S-M", ["Clash1"], "Approved", "Accepted: sleeve"));
  const base = { action: "clash_status", test: "FMC S-M", names: ["Clash1", "Clash9"], set_status: "Approved", comment: "Accepted: sleeve", dry_run: false };
  assert.match(body(await runFmcNavis(parse({ ...base, plan_hash: dry.plan_hash }), deps)).reasons[0], /person's yes/);
  assert.match(body(await runFmcNavis(parse({ ...base, approved_by: "Claude", plan_hash: dry.plan_hash }), deps)).reasons[0], /never the AI/);
  assert.match(body(await runFmcNavis(parse({ ...base, approved_by: "J. Mukasa", plan_hash: "000000000000" }), deps)).reasons[0], /plan changed/);
  assert.equal(b.calls.filter((c) => c.params.dry_run === false).length, 0, "nothing changed yet");
  const done = body(await runFmcNavis(parse({ ...base, approved_by: "J. Mukasa", plan_hash: dry.plan_hash }), deps));
  assert.equal(done.done, true);
  const real = b.calls.find((c) => c.params.dry_run === false)!.params;
  assert.deepEqual(real.names, ["Clash1"], "only the results found");
  assert.equal(real.author, "J. Mukasa");
  assert.match(real.comment, /Accepted: sleeve \(J\. Mukasa, via Formcraft\)/);
  assert.equal(statusHash("t", ["b", "a"], "Resolved", ""), statusHash("T", ["a", "b"], "resolved", ""));
});
