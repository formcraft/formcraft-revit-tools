import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, GuardConfig } from "./policy.js";
import { CONTEXT_ENGINES, ContextDeps, LIST_CAP, REGISTERED_TOOLS, aiModeOf, classify, clearFolderMemos, engineGate, familyFiles, familyNamesIn, forTask, getItem, kitNoteFor, kitPaths, listNames, nextCalls, overview, search, templateFiles, words } from "./context.js";
import { contextAction, runFmcContext } from "../tools/fmc_context.js";
import { FMC_INSTRUCTIONS, NUDGE, annotateResult, installContextNudges, registerContextPrompts, registerContextResources, serverOptions } from "./mcp_context.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "../../src/fmc/fixtures/context_kit");
const REPO_RECIPES = path.resolve(HERE, "../../../tests/recipes");

/** A kit in a temp folder: the fixture slice of the real kit r4, plus staging, a released family, a template and a rulebook. */
function kit(): { root: string; deps: ContextDeps; project: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-context-"));
  fs.cpSync(FIXTURE, root, { recursive: true });
  const put = (rel: string, text = "") => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  put("04_Families/_Staging/A/FMC_A_Door_FlushSingleLeaf.rfa");
  put("04_Families/A/FMC_A_Door_AluSwing.rfa");
  put("06_Templates/FMC_Base_Template_v2.2.rte");
  put("03_Master_Data/FMC_Rulebook/FMC_Rulebook_Families.json", JSON.stringify({ feature: "Families", rulebook_version: "0.1",
    rules: [{ id: "FAM-001", title: "Library families follow FMC_[Role]_[CategoryToken]_[Description]", severity: "Must", check: { type: "human_gate" } }] }));
  const project = path.join(root, "Projects", "F26001");
  put("Projects/F26001/01_WIP/FMC_Project.json", JSON.stringify({ project: "F26001", stage: "4", issue_set: "Tender", roles: ["A", "S"], standard: "FMC-BIM v2.2", models: [{ role: "A" }, { role: "S" }] }));
  const cfg: GuardConfig = {
    ...DEFAULT_CONFIG,
    specs_path: path.join(root, "03_Master_Data", "FMC_Family_Specs.json"),
    shared_parameter_file: path.join(root, "01_Shared_Parameters", "FMC_SharedParameters.txt"),
    keynote_file: path.join(root, "02_Keynotes", "FMC_Keynotes.txt"),
    rulebooks_dir: path.join(root, "03_Master_Data", "FMC_Rulebook"),
    materials_file: path.join(root, "07_Materials", "FMC_Materials.json"),
    family_staging_root: path.join(root, "04_Families", "_Staging"),
  };
  const instances = () => [{ pid: 1, port: 8080, revit: "2025", user: "", started: "", updated: "", build: "",
    documents: [{ title: "F26001-FMC-ZZ-ZZ-M3-A-0001", path: path.join(project, "01_WIP", "A", "F26001-FMC-ZZ-ZZ-M3-A-0001.rvt"), active: true, family: false, workshared: true }] }];
  return { root, project, deps: { cfg, instances, extraRecipeDirs: [REPO_RECIPES] } };
}

const bytes = (o: unknown) => Buffer.byteLength(JSON.stringify(o));

test("the server's instructions put the kit first and carry the hard rules, under 400 words", () => {
  assert.equal(serverOptions().instructions, FMC_INSTRUCTIONS);
  const words = FMC_INSTRUCTIONS.split(/\s+/).filter(Boolean).length;
  assert.ok(words < 400, `${words} words`);
  for (const must of ["source of truth", "fmc_context", "for_task", "kit change request", "Dry run first", "Live-model lock",
    "Never release", "Never save or synchronise a workshared model",
    // owner 26 Oct: the session rules that used to be pasted
    "pass revit", "modify_model", "fmc_standards", "model_check", "fmc_ai failures", "fmc_ai wait"]) assert.ok(FMC_INSTRUCTIONS.includes(must), must);
});

test("the initialize result carries the instructions (real MCP SDK; skipped with the stub)", async (t) => {
  let Client: any, InMemoryTransport: any, McpServer: any;
  try {
    ({ McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js"));
    ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js" as string));
    ({ InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js" as string));
  } catch { t.skip("the real MCP SDK isn't installed here"); return; }
  const server = new McpServer({ name: "mcp-server-for-revit", version: "1.0.0" }, serverOptions());
  installContextNudges(server);
  const { registerFmcContextTool } = await import("../tools/fmc_context.js");
  registerFmcContextTool(server);
  assert.ok(registerContextResources(server).includes("fmc://kit/overview"));
  assert.deepEqual(registerContextPrompts(server), ["build-family", "assign-material", "work-on-project", "test-new-build"]);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  assert.equal(client.getInstructions(), FMC_INSTRUCTIONS);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((x: any) => x.name === "fmc_context"));
  const prompts = await client.listPrompts();
  assert.ok(prompts.prompts.some((x: any) => x.name === "build-family"));
  await client.close();
});

test("words and intents: bi-fold, CamelCase family names, materials kept apart from a door's frame", () => {
  assert.deepEqual(words("FMC_A_Door_AluSlidingFolding"), ["fmc", "a", "door", "alu", "sliding", "folding"]);
  assert.deepEqual(words("make a bi-fold door"), ["make", "a", "bifold", "door"]);
  assert.deepEqual(classify("make a bi-fold aluminium door").sort(), ["door", "family"]);
  assert.ok(classify("trim profile georgian").includes("profile"));
  assert.ok(classify("terrazzo floor material").includes("material"));
  assert.ok(classify("single line diagram for the DB").includes("line_diagram"));
});

test("for_task: a bi-fold aluminium door returns the kit's door specs, folding and sliding first, and recipe pointers", () => {
  const { deps } = kit();
  const a = forTask("make a bi-fold aluminium door", deps) as any;
  assert.ok(bytes(a) < 6000, `${bytes(a)} bytes`);
  const names = a.family_specs.map((s: any) => s.family);
  assert.equal(names[0], "FMC_A_Door_AluSlidingFolding");
  assert.ok(names.some((n: string) => /Sliding/.test(n) && n !== "FMC_A_Door_AluSlidingFolding"), names.join(", "));
  assert.ok(!names.includes("FMC_TAG_A_Door"), "a tag isn't a door");
  assert.equal(a.family_specs[0].template, "Metric Door.rft");
  assert.deepEqual(a.family_specs[0].types, ["3000x2400_4Leaf", "4500x2400_6Leaf"]);
  // no recipe for the bi-fold yet: the nearest door recipes are the pattern, and the next calls say so
  assert.equal(a.family_specs[0].recipe, null);
  assert.ok(a.nearest_recipes.length >= 1 && a.nearest_recipes.every((r: any) => r.family.startsWith("FMC_A_Door_") && r.file && r.ops > 0));
  assert.ok(a.next.some((n: string) => n.includes("spec:FMC_A_Door_AluSlidingFolding")));
  assert.ok(a.next.some((n: string) => /fmc_recipe check/.test(n)));
  // the released AluSwing is pointed at, not rebuilt
  const swing = a.family_specs.find((s: any) => s.family === "FMC_A_Door_AluSwing");
  assert.ok(swing?.released);
});

test("for_task: a door the repo has a recipe for gives fmc_recipe check and build, and the staged file's gate", () => {
  const { deps } = kit();
  const a = forTask("flush single leaf door", deps) as any;
  assert.equal(a.family_specs[0].family, "FMC_A_Door_FlushSingleLeaf");
  assert.ok(a.family_specs[0].recipe.ops > 0);
  assert.ok(a.next[0].startsWith('fmc_recipe {"action":"check","recipe_file":'));
  assert.ok(a.next.some((n: string) => n.includes('"action":"gate"')));
  assert.ok(bytes(a) < 6000);
});

test("for_task: a georgian trim profile returns the profile set rows and the profile recipes", () => {
  const { deps } = kit();
  const a = forTask("trim profile georgian", deps) as any;
  assert.ok(bytes(a) < 6000, `${bytes(a)} bytes`);
  const ps = a.profile_sets;
  assert.deepEqual(ps.movements, ["7 Georgian"]);
  assert.deepEqual(ps.elements, ["Architrave", "Skirting", "DadoRail", "PictureRail", "PanelMould"]);
  assert.ok(ps.rows.every((r: any) => r.movement === "Georgian"));
  assert.ok(ps.rows.find((r: any) => r.family === "FMC_Profile_Architrave_Georgian").recipe);
  assert.match(ps.design_movement_param, /FMC_Design_Movement/);
  assert.ok(a.next[0].includes("FMC_Profile_Architrave_Georgian.recipe.json"));
  assert.ok(a.keynotes.some((k: string) => k.startsWith("J.TRM")), "the trims' keynotes");
  // "greek revival" names Greek Revival only
  const g = forTask("architrave profile greek revival", deps) as any;
  assert.deepEqual(g.profile_sets.movements, ["9 Greek Revival"]);
});

test("for_task: a terrazzo floor material returns FMC_Finish_Terrazzo_InSitu with its keynote, and no price is guessed", () => {
  const { deps } = kit();
  const a = forTask("terrazzo floor material", deps) as any;
  assert.ok(bytes(a) < 6000, `${bytes(a)} bytes`);
  const m = a.materials[0];
  assert.equal(m.name, "FMC_Finish_Terrazzo_InSitu");
  assert.equal(m.keynote, "I.FLR_01");
  assert.match(m.keynote_text, /terrazzo/i);
  assert.equal(m.price, "price needed");
  assert.ok(a.keynotes.some((k: string) => k.startsWith("I.FLR_01")));
  assert.ok(a.next[0].startsWith('fmc_material {"action":"assign","material":"FMC_Finish_Terrazzo_InSitu"'));
  // a priced material shows its price as the kit has it
  const p = forTask("maxpan clay floor unit material", deps) as any;
  assert.match(p.materials[0].price, /^UGX 4,150-7,530/);
});

test("for_task: engines route by the registry; one not in this build is named as such", () => {
  const { deps } = kit();
  const c = forTask("kitchen casework run", deps) as any;
  assert.equal(c.engines[0].tool, "fmc_casework");
  assert.equal(c.engines[0].available, true);
  const ceiling = forTask("suspended ceiling layout", deps) as any;
  const e = ceiling.engines.find((x: any) => x.id === "ceiling");
  assert.equal(typeof e.available, "boolean");
  if (!e.available) assert.match(e.note, /not in this build/);
});

test("overview: kit, counts, open documents, the project manifest, AI-use state and the tool map, small", () => {
  const { deps } = kit();
  const o = overview(deps) as any;
  assert.ok(bytes(o) < 6000, `${bytes(o)} bytes`);
  assert.equal(o.kit.found, true);
  assert.equal(o.kit.version, "2.2");
  assert.equal(o.kit.revision, "r4");
  assert.equal(o.counts.family_specs, 44);
  for (const key of ["recipes", "staged_families", "released_families"]) assert.equal(typeof o.count_notes[key], "string", key);
  assert.equal(typeof o.counts.staged_families, "number", "counts stay plain numbers");
  // F63 rec 3 and 4: the revision is labelled as the file's, and staged never reads as released.
  assert.match(o.kit.revision_note, /as written in FMC_Kit\.json \(r4, 2026-10-15\); the counts below are read from the kit folders now/);
  assert.match(o.count_notes.staged_families, /^staged, NOT released/);
  assert.match(o.count_notes.released_families, /^released/);
  assert.match(o.count_notes.recipes, /^build instructions, not families/);
  assert.match(o.count_notes.families, /^1 staged \(not released\), 1 released; \d+ recipes are build instructions/);
  assert.ok(o.counts.profile_recipes >= 7, "the kit fixture's seven, plus any in the repo's own recipe folders");
  assert.ok(o.counts.recipes > 7, "the repo's door and window recipes too");
  assert.equal(o.counts.design_movements, 4);
  assert.equal(o.counts.materials, 8);
  assert.equal(o.counts.staged_families, 1);
  assert.equal(o.counts.released_families, 1);
  assert.equal(o.counts.templates, 1);
  assert.deepEqual(o.rulebooks, ["Families"]);
  assert.equal(o.revit[0].title, "F26001-FMC-ZZ-ZZ-M3-A-0001");
  assert.equal(o.project.code, "F26001");
  assert.match(o.ai_use.aiuse_rulebook, /missing/);
  assert.match(o.ai_use.ai_modeller, /^off/);
  assert.ok(o.use["build a family from a recipe"].startsWith("fmc_recipe"));
});

test("get: a spec, a recipe summary, a material, a rulebook and a profile row, each in full and capped", () => {
  const { deps } = kit();
  const s = getItem("spec:FMC_TAG_A_Door", deps) as any;
  assert.equal(s.spec.shared_parameters[0].name, "FMC_Fire_Resistance_Min");
  assert.ok(s.spec.shared_parameters[0].guid);
  const r = getItem("recipe:FMC_Profile_Architrave_Georgian", deps) as any;
  assert.equal(r.recipe.template, "Metric Profile.rft");
  assert.ok(r.recipe.ops > 0 && r.recipe.op_kinds.profile_lines === 1);
  assert.ok(r.values.Keynote);
  const m = getItem("FMC_Finish_Terrazzo_InSitu", deps) as any;
  assert.equal(m.kind, "material");
  assert.equal(m.price_status, "price needed");
  const b = getItem("rulebook:Families", deps) as any;
  assert.equal(b.count, 1);
  const p = getItem("profile:FMC_Profile_Skirting_Georgian", deps) as any;
  assert.equal(p.profile.element, "Skirting");
  assert.equal((getItem("spec:FMC_Nope", deps) as any).found, false);
  for (const x of [s, r, m, b, p]) assert.ok(bytes(x) < 12500);
});

test("get: a miss is an error at the tool, a hit is not", async () => {
  const { deps } = kit();
  const miss = await runFmcContext({ action: "get", ref: "spec:FMC_Nope" }, deps);
  assert.equal(miss.isError, true);
  assert.equal(JSON.parse(miss.content[0].text).found, false);
  const hit = await runFmcContext({ action: "get", ref: "spec:FMC_TAG_A_Door" }, deps);
  assert.equal(hit.isError, false);
});

test("action may be left out: ref means get, task means for_task, query means search, none means overview", async () => {
  assert.equal(contextAction({}), "overview");
  assert.equal(contextAction({ ref: "spec:X" }), "get");
  assert.equal(contextAction({ task: "a door" }), "for_task");
  assert.equal(contextAction({ query: "sill" }), "search");
  assert.equal(contextAction({ action: "overview", task: "a door" }), "overview", "an explicit action wins");
  const { deps } = kit();
  const o = JSON.parse((await runFmcContext({}, deps)).content[0].text);
  assert.equal(o.kit.found, true);
  const t = JSON.parse((await runFmcContext({ task: "make a bi-fold aluminium door" }, deps)).content[0].text);
  assert.ok(t.family_specs.length > 0);
  const r = await runFmcContext({ action: "search" }, deps);
  assert.equal(r.isError, true, "search with no query is refused");
});

test("get list:<kind> names every item of a kind, sorted, with the true count", () => {
  const { deps } = kit();
  const specs = getItem("list:spec", deps) as any;
  assert.equal(specs.kind, "list");
  assert.equal(specs.count, 44);
  assert.equal(specs.names.length, 44);
  assert.deepEqual(specs.names, [...specs.names].sort((a: string, b: string) => a.localeCompare(b)));
  assert.equal(specs.truncated, false);
  assert.deepEqual((getItem("list:rulebook", deps) as any).names, ["Families"]);
  assert.ok((getItem("list:engine", deps) as any).names.includes("clash"));
  assert.equal((getItem("list:nonsense", deps) as any).found, false);
  const k = kitPaths(deps.cfg, deps.extraRecipeDirs);
  assert.ok(LIST_CAP >= 100);
  assert.equal((listNames("material", k) as any).count, 8);
});

test("get list:tool reads the registered tools, and says so when none are registered", () => {
  const { deps } = kit();
  const k = kitPaths(deps.cfg, deps.extraRecipeDirs);
  const saved = [...REGISTERED_TOOLS];
  REGISTERED_TOOLS.clear();
  try {
    const none = listNames("tool", k) as any;
    assert.equal(none.count, 0);
    assert.match(none.note, /running MCP server/);
    REGISTERED_TOOLS.add("fmc_clash"); REGISTERED_TOOLS.add("fmc_coord");
    assert.deepEqual((listNames("tool", k) as any).names, ["fmc_clash", "fmc_coord"]);
    const o = overview(deps) as any;
    assert.equal(o.tools.registered, 2);
    assert.equal(o.tools.not_in_use, 2, "neither is in TOOL_MAP");
  } finally {
    REGISTERED_TOOLS.clear();
    for (const t of saved) REGISTERED_TOOLS.add(t);
  }
});

test("search: every word must appear; results per data set, capped, with totals", () => {
  const { deps } = kit();
  const r = search("terrazzo", deps) as any;
  assert.ok(r.results.material.count >= 1);
  assert.ok(r.results.material.items.some((x: string) => x.startsWith("FMC_Finish_Terrazzo_InSitu")));
  assert.equal(r.total, Object.values(r.results).reduce((s: number, x: any) => s + x.count, 0));
  const only = search("terrazzo", deps, ["material"]) as any;
  assert.deepEqual(Object.keys(only.results), ["material"]);
  const none = search("zzqqxx nothing", deps) as any;
  assert.equal(none.total, 0);
  assert.match(none.next, /don't invent/);
  const rule = search("library families", deps, ["rule"]) as any;
  assert.deepEqual(rule.results.rule.items.map((x: string) => x.split(":")[0]), ["Families/FAM-001"]);
});

test("engines: the MEP and coordination tools route, with ai_mode and a lease note for a real step", () => {
  for (const [task, id] of [["clash the pipes with the beams", "clash"], ["check the survey point coordination", "coordination"],
    ["cable tray open ends", "conduit"], ["circuit the sockets", "circuits"], ["pipe sizing calculation", "calc"],
    ["trace the drainage continuity", "trace"], ["typical eaves detail", "details"], ["headroom under the ducts", "headroom"]] as const) {
    assert.ok(classify(task).includes(id), `${task} -> ${id}`);
    assert.ok(CONTEXT_ENGINES.some((e) => e.id === id && e.intent === id), id);
  }
  const { deps } = kit();
  const c = forTask("cable tray open ends", deps) as any;
  const e = c.engines.find((x: any) => x.id === "conduit");
  assert.equal(e.ai_mode, "refused", "fmc_conduit_apply is a write in no AI group");
  assert.match(e.lease, /fmc_batch request/);
  const clash = (forTask("clash the pipes with the beams", deps) as any).engines.find((x: any) => x.id === "clash");
  assert.equal(clash.ai_mode, "allowed");
  assert.equal(clash.lease, undefined);
  // the older routes are unchanged
  assert.deepEqual(classify("make a bi-fold aluminium door").sort(), ["door", "family"]);
});

test("aiModeOf follows the gate's lists: NEVER and group-less writes refused, grouped writes approval, reads allowed", () => {
  assert.equal(aiModeOf("fmc_coord_apply"), "refused");
  assert.equal(aiModeOf("send_code_to_revit"), "refused");
  assert.equal(aiModeOf("create_level"), "approval");
  assert.equal(aiModeOf("fmc_details_apply"), "refused");
  assert.equal(aiModeOf("fmc_clash"), "allowed");
  assert.deepEqual(engineGate({ id: "x", intent: "qa", tool: "t", about: "", calls: [], kit: [] }), { ai_mode: "allowed" });
  assert.equal(engineGate({ id: "x", intent: "qa", tool: "t", about: "", calls: [], kit: [], writes: ["create_level", "fmc_coord_apply"] }).ai_mode, "refused", "the strictest write wins");
});

test("next_calls: tool-plus-JSON strings become {tool, args}; other strings are left as strings only", () => {
  const calls = nextCalls([
    'fmc_recipe {"action":"check","recipe_file":"C:\\\\k\\\\a.recipe.json"}',
    'fmc_recipe {"action":"build","dry_run":true} → show the dry run → dry_run=false after a yes',
    'fmc_conduit {"action":"fix","document":"<doc>","dry_run":true}',
    'fmc_casework {"action":"units", ...run}',
    "Write X.recipe.json from the spec",
  ]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { tool: "fmc_recipe", args: { action: "check", recipe_file: "C:\\k\\a.recipe.json" } });
  assert.deepEqual(calls[1].args, { action: "build", dry_run: true });
  assert.equal(calls[2].placeholders, true);
  assert.equal(calls[2].real_run?.ai_mode, "refused");
  const { deps } = kit();
  const t = forTask("make a bi-fold aluminium door", deps) as any;
  assert.ok(Array.isArray(t.next));
  for (const c of t.next_calls ?? []) assert.equal(typeof c.tool, "string");
});

test("for_task limit sets how many family specs come back", () => {
  const { deps } = kit();
  const all = forTask("door", deps) as any;
  const two = forTask("door", deps, { limit: 2 }) as any;
  assert.ok(all.family_specs.length > 2);
  assert.equal(two.family_specs.length, 2);
  assert.equal((forTask("door", deps, { limit: 99 }) as any).family_specs.length <= 20, true);
});

test("a rulebook with no QA rules names its top-level keys instead of looking empty", () => {
  const { root, deps } = kit();
  fs.writeFileSync(path.join(root, "03_Master_Data", "FMC_Rulebook", "FMC_Rulebook_AIUse.json"), JSON.stringify({ groups: {}, bands: [] }));
  const b = getItem("rulebook:AIUse", deps) as any;
  assert.equal(b.count, 0);
  assert.deepEqual(b.top_level_keys, ["groups", "bands"]);
  assert.match(b.note, /No QA rules/);
  assert.equal((getItem("rulebook:Families", deps) as any).top_level_keys, undefined);
});

test("F63: get rulebook:AIUse shows the AI-use limits (fmc-aiuse schema), never 0 rules", () => {
  const { root, deps } = kit();
  const proposal = fs.readFileSync(path.resolve(HERE, "../../../docs/kit-proposals/FMC_Rulebook_AIUse.json"), "utf8");
  fs.writeFileSync(path.join(root, "03_Master_Data", "FMC_Rulebook", "FMC_Rulebook_AIUse.json"), "\ufeff" + proposal);
  const b = getItem("rulebook:AIUse", deps) as any;
  assert.equal(b.kind, "ai-use limits");
  assert.equal(b.valid, true);
  assert.ok(b.count > 10, `${b.count} lines`);
  assert.equal(b.count, b.rules.length);
  assert.ok(b.rules.includes("limits: batch_elements 50, daily_elements 500, failed_batches_per_day 3"));
  assert.ok(b.rules.some((l: string) => l.startsWith("band Assist 1-20: data, views")));
  assert.ok(b.rules.some((l: string) => l.startsWith("override S: max_involvement 5")));
  assert.ok(b.rules.some((l: string) => l.startsWith("general switch: Fix with approval")));
  assert.ok(b.rules.includes("cap: none"));
  // A broken one says so instead of looking empty or valid.
  fs.writeFileSync(path.join(root, "03_Master_Data", "FMC_Rulebook", "FMC_Rulebook_AIUse.json"), JSON.stringify({ schema: "fmc-aiuse/0.1", bands: [] }));
  const bad = getItem("rulebook:AIUse", deps) as any;
  assert.equal(bad.valid, false);
  assert.ok(bad.problems.length > 0);
  assert.equal(bad.rules[0], "limits: batch_elements 0, daily_elements 0, failed_batches_per_day 0");
  // Raw non-numbers are shown as the gate's num() defaults, not the raw text.
  fs.writeFileSync(path.join(root, "03_Master_Data", "FMC_Rulebook", "FMC_Rulebook_AIUse.json"),
    JSON.stringify({ schema: "fmc-aiuse/0.1", limits: { batch_elements: "50", daily_elements: null, failed_batches_per_day: 3 }, bands: [] }));
  const coerced = getItem("rulebook:AIUse", deps) as any;
  assert.equal(coerced.rules[0], "limits: batch_elements 0, daily_elements 0, failed_batches_per_day 3");
});

test("F63: overview.ai_use says mode, access, auto-approve and code, read-only", () => {
  const { deps } = kit();
  const on = { ...deps, cfg: { ...deps.cfg, ai_modeller: { on: true, mode: "testing", auto_approve: true, access: "full", levels: {} } } as unknown as GuardConfig };
  const a = (overview(on) as any).ai_use;
  assert.equal(a.ai_modeller, "on");
  assert.equal(a.mode, "testing");
  assert.equal(a.access, "full (configured, effective where General is On)");
  assert.equal(a.auto_approve, true);
  assert.equal(a.allow_code, false);
  assert.match(a.approvals, /^auto-approve: applies only while the AI is on and not stopped/);
  assert.match(a.approvals, /Relinquish, shared items and a direct sync still wait for a person/);
  const strict = { ...deps, cfg: { ...deps.cfg, ai_modeller: { on: true, auto_approve: true, levels: {} } } as unknown as GuardConfig };
  const s = (overview(strict) as any).ai_use;
  assert.equal(s.mode, "strict");
  assert.match(s.approvals, /^no auto-approve/, "auto_approve only acts in testing mode (aigate.ts)");
  assert.match(s.approvals, /Relinquish, shared items and a direct sync still wait for a person/);
  const stopped = { ...deps, cfg: { ...deps.cfg, ai_modeller: { on: true, stop: true, mode: "testing", auto_approve: true, levels: {} } } as unknown as GuardConfig };
  assert.match((overview(stopped) as any).ai_use.approvals, /does not apply: the AI is stopped/);
  const offSwitch = { ...deps, cfg: { ...deps.cfg, ai_modeller: { on: false, mode: "testing", auto_approve: true, levels: {} } } as unknown as GuardConfig };
  assert.match((overview(offSwitch) as any).ai_use.approvals, /does not apply: the AI is off/);
  const off = (overview(deps) as any).ai_use;
  assert.equal(off.auto_approve, undefined, "no ai_modeller section: nothing to report");
});

test("F63: AI-use limits can be loaded from FMC_Rulebook_ClaudeUse.json when AIUse is missing", () => {
  const { root, deps } = kit();
  const proposal = JSON.parse(fs.readFileSync(path.resolve(HERE, "../../../docs/kit-proposals/FMC_Rulebook_AIUse.json"), "utf8"));
  fs.writeFileSync(path.join(root, "03_Master_Data", "FMC_Rulebook", "FMC_Rulebook_ClaudeUse.json"), JSON.stringify(proposal));
  const o = (overview(deps) as any).ai_use;
  assert.match(o.aiuse_rulebook, /FMC_Rulebook_ClaudeUse\.json \(whole file; used because FMC_Rulebook_AIUse.json is not in the kit\)/);
  const b = getItem("rulebook:ClaudeUse", deps) as any;
  assert.equal(b.kind, "ai-use limits");
  assert.equal(b.valid, true);
  fs.writeFileSync(path.join(root, "03_Master_Data", "FMC_Rulebook", "FMC_Rulebook_ClaudeUse.json"), JSON.stringify({
    feature: "ClaudeUse", rulebook_version: "0.1",
    rules: [{ id: "AI-001", title: "A QA rule", severity: "Must", check: { type: "human_gate" } }],
    ai_use: proposal,
  }));
  const mixed = getItem("rulebook:ClaudeUse", deps) as any;
  assert.equal(mixed.count, 1);
  assert.equal(mixed.ai_use.kind, "ai-use limits");
  assert.equal(mixed.ai_use.valid, true);
  assert.match((overview(deps) as any).ai_use.aiuse_rulebook, /FMC_Rulebook_ClaudeUse\.json \(ai_use;/);
});

test("family and template listings are kept 10 s, and clearFolderMemos drops them", () => {
  const { root, deps } = kit();
  const k = kitPaths(deps.cfg, deps.extraRecipeDirs);
  clearFolderMemos();
  assert.equal(familyFiles(k).staged.size, 1);
  assert.equal(templateFiles(k).length, 1);
  fs.writeFileSync(path.join(root, "04_Families", "_Staging", "A", "FMC_A_Door_Second.rfa"), "");
  fs.writeFileSync(path.join(root, "06_Templates", "FMC_Second.rte"), "");
  assert.equal(familyFiles(k).staged.size, 1, "memo: not listed again within 10 s");
  assert.equal(templateFiles(k).length, 1);
  clearFolderMemos();
  assert.equal(familyFiles(k).staged.size, 2);
  assert.equal(templateFiles(k).length, 2);
});

test("nudge: family- and material-making tools start with the line; others don't; results that make a kit family get a pointer", async () => {
  const seen: Record<string, string> = {};
  const fake: any = { tool: (name: string, description: string, _shape: unknown, cb: Function) => { seen[name] = description; fake.handlers[name] = cb; }, handlers: {} };
  const { deps } = kit();
  installContextNudges(fake, () => deps);
  fake.tool("fmc_recipe", "Formcraft family recipes", {}, () => ({}));
  fake.tool("fmc_qa", "Formcraft QA", {}, () => ({}));
  fake.tool("send_code_to_revit", "Send C# code", {}, () => ({ content: [{ type: "text", text: "Code execution successful!" }] }));
  assert.ok(seen.fmc_recipe.startsWith(NUDGE));
  assert.ok(seen.send_code_to_revit.startsWith(NUDGE));
  assert.equal(seen.fmc_qa, "Formcraft QA");
  const r = await fake.handlers.send_code_to_revit({ code: 'var d = app.NewFamilyDocument(t); d.SaveAs(@"C:\\x\\FMC_A_Door_FlushSingleLeaf.rfa");' }, {});
  assert.equal(r.content.length, 2);
  assert.match(r.content[1].text, /FMC_A_Door_FlushSingleLeaf: the kit has a spec .* and a recipe/);
  const quiet = await fake.handlers.send_code_to_revit({ code: "TaskDialog.Show(\"hi\", \"there\");" }, {});
  assert.equal(quiet.content.length, 1);
  const saved = annotateResult("fmc_doc", { action: "save", path: "Z:\\00_Standards\\04_Families\\_Staging\\A\\FMC_A_Door_AluSlidingFolding.rfa" }, { content: [{ type: "text", text: "{}" }] }, () => deps);
  assert.match(saved.content![1].text!, /FMC_A_Door_AluSlidingFolding: the kit has a spec/);
  assert.deepEqual(familyNamesIn("FMC_A_Door_X.rfa and FMC_I_Casework_Vanity"), ["FMC_A_Door_X", "FMC_I_Casework_Vanity"]);
  assert.equal(kitNoteFor(["FMC_Not_A_Family"], deps), null);
});
