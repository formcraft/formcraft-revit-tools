import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { aiGate } from "./aigate.js";
import { DEFAULT_CONFIG } from "./policy.js";
import { LINE_CATEGORY_ADMIN, LINE_CATEGORY_UNKNOWN, adminSession, lineBatchRefusal, lineCategoryRefusal, lineTypeIds, normaliseCategory, } from "./linecat.js";
import { kitMasterDataPath } from "./calc/kit.js";
import { FMC_SYSTEMS_SHAPE, runFmcSystems } from "../tools/fmc_systems.js";
const line = (category: string, typeId = -1) => ({ category, typeId, locationLine: { p0: { x: 0, y: 0, z: 0 }, p1: { x: 3000, y: 0, z: 0 } }, thickness: 200, height: 3000, baseLevel: 0, baseOffset: 0 });
test("a beam is refused for an AI session with FMC-LINE-CATEGORY-ADMIN", () => {
    for (const cat of ["OST_StructuralFraming", "OST_StructuralFramingSystem", "OST_StructuralColumns", "OST_StructuralFoundation", "OST_StructuralTruss"]) {
        const r = lineCategoryRefusal(cat, false);
        assert.equal(r?.code, LINE_CATEGORY_ADMIN, cat);
        assert.equal(r?.code, "FMC-LINE-CATEGORY-ADMIN");
        assert.match(r.message, /^\[FMC-LINE-CATEGORY-ADMIN\]/);
    }
    assert.equal(lineBatchRefusal([line("OST_Walls"), line("OST_StructuralFraming")], false)?.code, LINE_CATEGORY_ADMIN, "one beam refuses the whole batch");
});
test("the add-in's own spellings can't get a beam past the check: any case, dots, and it is still structure", () => {
    for (const spelled of ["ost_structuralframing", "OST_Structural.Framing", " OST_STRUCTURALFRAMING "]) {
        assert.equal(normaliseCategory(spelled), "OST_StructuralFraming");
        assert.equal(lineCategoryRefusal(spelled, false)?.code, LINE_CATEGORY_ADMIN, spelled);
    }
});
test("a wall and a duct are allowed, for an AI session and for an admin", () => {
    for (const admin of [false, true]) {
        assert.equal(lineCategoryRefusal("OST_Walls", admin), null);
        assert.equal(lineCategoryRefusal("OST_DuctCurves", admin), null);
        assert.equal(lineCategoryRefusal("ost_walls", admin), null);
        assert.equal(lineBatchRefusal([line("OST_Walls"), line("OST_DuctCurves", 77)], admin), null);
    }
});
test("an unknown category is refused with FMC-LINE-CATEGORY-UNKNOWN, for everyone", () => {
    for (const cat of ["", "Walls", "OST_Doors", "OST_PipeCurves", "OST_Nonsense", "-2001320", "2001320", "OST_Walls; drop", "../OST_Walls", "OST_"]) {
        for (const admin of [false, true]) {
            const r = lineCategoryRefusal(cat, admin);
            assert.equal(r?.code, LINE_CATEGORY_UNKNOWN, `${JSON.stringify(cat)} admin=${admin}`);
            assert.equal(r?.code, "FMC-LINE-CATEGORY-UNKNOWN");
        }
    }
    assert.equal(lineCategoryRefusal(undefined, true)?.code, LINE_CATEGORY_UNKNOWN);
    assert.equal(lineCategoryRefusal(42, true)?.code, LINE_CATEGORY_UNKNOWN);
});
test("admin behaviour is unchanged: structure is allowed through the same tool", () => {
    for (const cat of ["OST_StructuralFraming", "OST_StructuralColumns", "OST_Walls", "OST_DuctCurves"])
        assert.equal(lineCategoryRefusal(cat, true), null, cat);
    assert.equal(lineBatchRefusal([line("OST_StructuralFraming", 5)], true, new Map([[5, { found: true, category: "OST_StructuralFraming" }]])), null);
});
test("the type's own category counts: a beam type under category OST_Walls is refused for AI, allowed for an admin", () => {
    const types = new Map([[5, { found: true, category: "OST_StructuralFraming" }], [6, { found: true, category: "OST_Walls" }], [7, { found: false, category: "" }]]);
    const sneaky = [line("OST_Walls", 5)];
    const r = lineBatchRefusal(sneaky, false, types);
    assert.equal(r?.code, LINE_CATEGORY_ADMIN);
    assert.match(r.message, /type 5 is a OST_StructuralFraming/);
    assert.equal(lineBatchRefusal(sneaky, true, types), null);
    assert.equal(lineBatchRefusal([line("OST_Walls", 6)], false, types), null);
    assert.equal(lineBatchRefusal([line("OST_Walls", 7)], false, types), null, "a type Revit didn't find falls back to the claim");
    assert.equal(lineBatchRefusal([line("OST_Walls", 8)], false, new Map([[8, { found: true, category: "OST_Doors" }]]))?.code, LINE_CATEGORY_UNKNOWN);
    assert.deepEqual(lineTypeIds([line("OST_Walls", 5), line("OST_Walls", 5), line("OST_Walls", -1), line("OST_Walls", 0), line("OST_Walls", 9)]), [5, 9]);
});
test("adminSession: the full-access switch or the pane; an AI, cli, job or schedule session is not", () => {
    assert.equal(adminSession({ access: "full" }, "ai"), true);
    assert.equal(adminSession({ access: "general" }, "pane"), true);
    for (const by of ["ai", "cli", "job", "schedule", "person"])
        assert.equal(adminSession({ access: "general" }, by), false, by);
    assert.equal(adminSession(null, "ai"), false);
});
const local = {
    title: "F26001-FMC-ZZ-ZZ-M3-A-0001",
    path: "D:\\Projects\\F26001\\01_WIP\\A\\F26001-FMC-ZZ-ZZ-M3-A-0001.rvt",
    isFamily: false, isWorkshared: true, isLocal: true, isDetached: false, isLinked: false, readOnly: false,
};
function gateCfg(access: "general" | "full") {
    return { ...DEFAULT_CONFIG, ai_modeller: { on: true, stop: false, mode: "testing", access, projects: { F26001: { general: true } } } };
}
const env = () => ({ APPDATA: fs.mkdtempSync(path.join(os.tmpdir(), "fmc-linecat-")) });
test("the AI gate refuses a beam for an AI session before anything else, with the code", async () => {
    const sent = [];
    const send = async (c: string) => { sent.push(c); return {}; };
    const gate = await aiGate("create_line_based_element", { data: [line("OST_StructuralFraming")] }, local, gateCfg("general"), send, env());
    assert.equal(gate.ok, false);
    assert.match(gate.reason, /FMC-LINE-CATEGORY-ADMIN/);
    assert.match(String(gate.user), /FMC-LINE-CATEGORY-ADMIN/);
    assert.equal(sent.length, 0, "a claimed beam needs no Revit round trip");
});
test("the AI gate looks up the type: a framing type under OST_Walls is refused for an AI session", async () => {
    const send = async (c: string) => c === "fmc_type_facts" ? { types: [{ id: 5, found: true, category: "OST_StructuralFraming", name: "W-Beam" }] } : {};
    const gate = await aiGate("create_line_based_element", { data: [line("OST_Walls", 5)] }, local, gateCfg("general"), send, env());
    assert.equal(gate.ok, false);
    assert.match(gate.reason, /FMC-LINE-CATEGORY-ADMIN/);
    assert.match(gate.reason, /type 5/);
});
test("the AI gate refuses an unknown category", async () => {
    const gate = await aiGate("create_line_based_element", { data: [line("OST_Doors")] }, local, gateCfg("full"), async () => ({}), env());
    assert.equal(gate.ok, false);
    assert.match(gate.reason, /FMC-LINE-CATEGORY-UNKNOWN/);
});
test("the AI gate passes the category check for a wall, and for a beam with the admin's full access (other gates may still decide)", async () => {
    const wall = await aiGate("create_line_based_element", { data: [line("OST_Walls", 6)] }, local, gateCfg("general"), async (c: string) => c === "fmc_type_facts" ? { types: [{ id: 6, found: true, category: "OST_Walls" }] } : {}, env());
    assert.doesNotMatch(wall.reason, /FMC-LINE-CATEGORY/);
    const beam = await aiGate("create_line_based_element", { data: [line("OST_StructuralFraming")] }, local, gateCfg("full"), async () => ({}), env());
    assert.doesNotMatch(beam.reason, /FMC-LINE-CATEGORY/);
});
// The add-in has no C# test host without the Revit API (R25): pin the source of the add-in side.
const here = path.dirname(fileURLToPath(import.meta.url));
const addin = (...p: string[]) => fs.readFileSync(path.resolve(here, "..", "..", "..", "commandset", ...p), "utf8");
test("the add-in enforces the same rule: command pre-check, handler pre-pass on the type's own category, nothing made before the check", () => {
    const rule = addin("Services", "Fmc", "FmcLineCategory.cs");
    assert.match(rule, /FMC-LINE-CATEGORY-ADMIN/);
    assert.match(rule, /FMC-LINE-CATEGORY-UNKNOWN/);
    assert.match(rule, /\^OST_\[A-Za-z0-9_\]\+\$/, "only an OST_ name is a category (a number would parse as an enum)");
    assert.match(rule, /Allowed = \{ "OST_Walls", "OST_DuctCurves" \}/);
    const cmd = addin("Commands", "CreateLineElementCommand.cs");
    assert.match(cmd, /_category_admin/);
    assert.match(cmd, /FmcLineCategory\.Refusal\(item\.Category, admin\)/);
    assert.match(cmd, /_handler\.CategoryAdmin = admin/);
    const handler = addin("Services", "CreateLineElementEventHandler.cs");
    const pre = handler.indexOf("FmcLineCategory.Refusal(data.Category, CategoryAdmin)");
    const firstTx = handler.indexOf("new Transaction(");
    assert.ok(pre > 0 && firstTx > pre, "the category pre-pass comes before any transaction");
    assert.match(handler, /typeOf\.Category\.Id\.GetIntValue\(\)/, "the type's own category is checked");
    assert.match(handler, /Message = ex\.Message\.StartsWith\("\[FMC-LINE-CATEGORY-"\)/, "the refusal keeps its code first");
});
test("the tool sets the role itself; a client cannot send _category_admin (the schema has no such key)", () => {
    const tool = fs.readFileSync(path.resolve(here, "..", "..", "src", "tools", "create_line_based_element.ts"), "utf8");
    assert.match(tool, /const params = \{ data: args\.data, _category_admin: admin \}/);
    assert.match(tool, /adminSession\(loadAiConfig\(config\), startedByFrom\(process\.env, "ai"\)\)/);
});
test("fmc_systems structural: kit_folder defaults beside the guard's specs file, like create_circuits", async () => {
    const specs = "Z:\\00_Standards\\03_Master_Data\\FMC_Family_Specs.json";
    assert.equal(kitMasterDataPath("", specs), "Z:\\00_Standards\\03_Master_Data\\FMC_Master_Data.json");
    assert.equal(kitMasterDataPath("   ", specs), "Z:\\00_Standards\\03_Master_Data\\FMC_Master_Data.json");
    assert.equal(kitMasterDataPath("C:\\Kit", specs), "C:\\Kit\\03_Master_Data\\FMC_Master_Data.json");
    const res = await runFmcSystems(z.object(FMC_SYSTEMS_SHAPE).parse({ action: "structural" }));
    const text = res.content[0].text;
    assert.equal(res.isError, true);
    assert.doesNotMatch(text, /Kit master data not found: 03_Master_Data/, "the old refusal named a relative path and ignored the kit beside the specs file");
    assert.match(text, /Kit master data not found: .*FMC_Master_Data\.json/);
    assert.match(text, /00_Standards[\\/]+03_Master_Data[\\/]+FMC_Master_Data\.json/, "it looked beside the guard's specs file");
});
