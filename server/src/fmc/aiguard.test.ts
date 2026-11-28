import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enableCopy, runFmcAi, FMC_AI_SHAPE } from "../tools/fmc_ai.js";
import { z } from "zod";
import { AI_PROTECTED_CALLER, AI_PROTECTED_NONE, planEnableCopy } from "./opencopy.js";
import { addCopy, copiesFile, GUARD_FILE_WRITE, isGuardFile, readCopies } from "./aicopies.js";
import { loadAiConfig } from "./aiuse_io.js";
import { generalState } from "./aiuse.js";
import { DEFAULT_CONFIG } from "./policy.js";
// A temp APPDATA and a temp guard file for every test; the real %APPDATA%\Formcraft is never touched. Off Windows the
// state paths are backslash names in the temp working directory (the same trick the other state tests use).
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-aiguard-"));
const cwd = process.cwd();
process.chdir(root);
const saved: Record<string, string | undefined> = { APPDATA: process.env.APPDATA, FMC_GUARD_CONFIG: process.env.FMC_GUARD_CONFIG };
process.env.APPDATA = process.platform === "win32" ? path.join(root, "appdata") : "appdata";
const guardFile = path.join(root, "fmc_guard.json");
process.env.FMC_GUARD_CONFIG = guardFile;
after(() => {
    process.chdir(cwd);
    for (const k of Object.keys(saved)) {
        if (saved[k] === undefined)
            delete process.env[k];
        else
            process.env[k] = saved[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
});
const live = "D:\\Fomcraft\\Ogala\\01_WIP\\S\\Ogala-S.rvt";
const copy = "C:\\Users\\USER\\agent-tools\\ogala-R04\\Ogala-S.copy.rvt";
const guard = {
    protected_roots: ["D:\\Fomcraft"], copy_roots: ["C:\\Users\\USER\\agent-tools"],
    ai_modeller: { on: true, stop: false, mode: "strict", projects: { OGALA: { general: false } } },
};
const cfg = { ...DEFAULT_CONFIG, ...guard };
const text = JSON.stringify(guard, null, 2);
const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const args = (over: Record<string, unknown>) => z.object(FMC_AI_SHAPE).parse({ action: "enable_copy", ...over });
const fresh = () => { fs.writeFileSync(guardFile, text); try {
    fs.unlinkSync(copiesFile());
}
catch { /* none yet */ } return sha(guardFile); };
test("enable_copy turns the switch on for the copy and never touches fmc_guard.json", async () => {
    const before = fresh();
    const res = await enableCopy(args({ document: copy }), cfg);
    assert.equal(res.enabled, true, JSON.stringify(res));
    assert.equal(res.guard_file, "unchanged");
    assert.equal(sha(guardFile), before, "the guard file is byte-identical");
    assert.equal(fs.readFileSync(guardFile, "utf8"), text);
    assert.deepEqual(Object.keys(readCopies()), [path.win32.normalize(copy)], "the copy is recorded in ai_copies.json");
    assert.equal(fs.existsSync(copiesFile()), true);
});
test("legitimate enable_copy still works: On for the copy only, the live model stays Off, Stop AI still wins", async () => {
    fresh();
    await enableCopy(args({ document: copy }), cfg);
    const ai = loadAiConfig(cfg);
    assert.ok(ai);
    assert.equal(generalState(ai, "Ogala-S.copy", copy), "On");
    assert.equal(generalState(ai, "Ogala-S", live), "Off");
    assert.equal(ai.projects.OGALA?.general, false, "the project switch is unchanged");
    const stopped = { ...ai, stop: true };
    assert.equal(generalState(stopped, "Ogala-S.copy", copy), "Stopped");
});
test("enable_copy still refuses a protected original, a non-.rvt path and a copy outside copy_roots", async () => {
    const before = fresh();
    for (const document of [live, "D:\\Fomcraft\\x\\copy.rvt", "C:\\Users\\USER\\agent-tools\\a.txt", "C:\\elsewhere\\a.rvt"]) {
        const res = await enableCopy(args({ document }), cfg);
        assert.equal(res.refused, true, document);
    }
    assert.equal(sha(guardFile), before);
    assert.deepEqual(readCopies(), {});
});
test("a caller-supplied protected_roots or live_paths is refused with FMC-AI-PROTECTED-CALLER, and nothing is written", async () => {
    const before = fresh();
    const named = [{ protected_roots: ["Z:\\nothing"] }, { live_paths: [live] }, { protected_roots: ["D:\\Fomcraft"] }, { protected_roots: ["Z:\\x"], live_paths: ["Z:\\y.rvt"] }];
    for (const extra of named) {
        const res = await enableCopy(args({ document: copy, ...extra }), cfg);
        assert.equal(res.refused, true, JSON.stringify(extra));
        assert.equal(res.code, "FMC-AI-PROTECTED-CALLER");
        assert.match((res.reasons as string[]).join(" "), /FMC-AI-PROTECTED-CALLER/);
    }
    assert.equal(sha(guardFile), before);
    assert.equal(fs.existsSync(copiesFile()), false);
    assert.equal(planEnableCopy(copy, cfg, ["Z:\\x"], []).code, AI_PROTECTED_CALLER);
});
test("every fmc_ai action refuses a caller-supplied protected list (it is never merged or remembered)", async () => {
    const before = fresh();
    for (const action of ["status", "queue", "stop", "usage", "wait", "inbox", "failures", "enable_copy", "policy"]) {
        const res = await runFmcAi(args({ action, document: copy, protected_roots: ["Z:\\x"] }));
        assert.equal(res.isError, true, action);
        assert.match((res.content[0] as { text: string }).text, /FMC-AI-PROTECTED-CALLER/, action);
    }
    assert.equal(fs.existsSync(path.win32.join(process.env.APPDATA!, "Formcraft", "ai_stop")), false, "stop did not run");
    assert.equal(sha(guardFile), before);
});
test("a caller list can't stand in for the guard's: a guard with no protected_roots refuses enable_copy with FMC-AI-PROTECTED-NONE", async () => {
    const before = fresh();
    const none = { ...cfg, protected_roots: [] };
    const res = await enableCopy(args({ document: copy }), none);
    assert.equal(res.refused, true);
    assert.equal(res.code, AI_PROTECTED_NONE);
    assert.equal(planEnableCopy(copy, none, [], []).code, AI_PROTECTED_NONE);
    const viaCaller = await enableCopy(args({ document: live, protected_roots: ["Z:\\nothing"] }), none);
    assert.equal(viaCaller.code, AI_PROTECTED_CALLER, "the old trick: name a folder that protects nothing, then enable a live model");
    assert.equal(sha(guardFile), before);
});
test("no fmc_ai action changes fmc_guard.json", async () => {
    const before = fresh();
    for (const action of ["queue", "usage", "inbox", "failures", "policy"])
        await runFmcAi(args({ action, document: copy }));
    await enableCopy(args({ document: copy }), cfg);
    assert.equal(sha(guardFile), before);
    assert.equal(fs.readFileSync(guardFile, "utf8"), text);
});
test("the copies file can't be the guard file, and a copy under a protected root is dropped when the config is read", () => {
    const before = fresh();
    assert.equal(isGuardFile(guardFile), true);
    assert.equal(isGuardFile("C:\\Users\\x\\AppData\\Roaming\\Formcraft\\FMC_Guard.JSON"), true);
    assert.equal(isGuardFile(copiesFile()), false);
    const was = process.env.FMC_GUARD_CONFIG;
    // The state file's own path pointed at the guard file: refused before any write
    process.env.APPDATA = process.platform === "win32" ? path.join(root, "appdata") : "appdata";
    assert.throws(() => addCopy(copy, { ...process.env, APPDATA: "appdata", FMC_GUARD_CONFIG: copiesFile() }), new RegExp(GUARD_FILE_WRITE));
    process.env.FMC_GUARD_CONFIG = was;
    // A tampered ai_copies.json that names a protected original is ignored by loadAiConfig
    fs.mkdirSync(path.dirname(copiesFile()), { recursive: true });
    fs.writeFileSync(copiesFile(), JSON.stringify({ copies: { [live]: { general: true }, [copy]: { general: true } } }));
    const ai = loadAiConfig(cfg);
    assert.equal(generalState(ai, "Ogala-S", live), "Off");
    assert.equal(generalState(ai, "Ogala-S.copy", copy), "On");
    assert.equal(sha(guardFile), before);
});
test("enableCopy's source has no write to the guard file (configPath or the guard file name)", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(here, "..", "..", "src", "tools", "fmc_ai.ts"), "utf8");
    const from = src.indexOf("export async function enableCopy");
    const body = src.slice(from, src.indexOf("export async function runFmcAi"));
    assert.doesNotMatch(body, /configPath|guardFile|fmc_guard\.json.*write|writeFileSync/);
    assert.match(body, /addCopy\(/);
    const run = src.slice(src.indexOf("export async function runFmcAi"), src.indexOf("export async function activeDocument"));
    assert.doesNotMatch(run, /configPath/, "no fmc_ai action reaches the guard file path");
});
