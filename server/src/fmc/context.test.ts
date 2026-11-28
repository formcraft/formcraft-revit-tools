import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, GuardConfig } from "./policy.js";
import { ContextDeps, classify, familyNamesIn, forTask, getItem, kitNoteFor, overview, words } from "./context.js";
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
