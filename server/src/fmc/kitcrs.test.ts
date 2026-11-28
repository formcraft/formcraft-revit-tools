import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  BUILD_PARAMS, KIT_CHANGE_REQUESTS, KIT_CR_DOC, buildParamsUnbound, buildParamsUnboundMessage,
  kitCr, kitCrForTarget, kitCrLines, missingKitMessage, syncExcludeSpellingProblem,
} from "./kitcrs.js";

const probeOf = (root: string) => ({
  exists: (p: string) => fs.existsSync(p),
  isDir: (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
  list: (p: string) => { try { return fs.readdirSync(p); } catch { return []; } },
});

test("every approved request has a stable id and the missing-file message names it and the CR doc", () => {
  const ids = KIT_CHANGE_REQUESTS.map((r) => r.id);
  assert.deepEqual(ids, ["K-02", "K-03", "K-04", "K-05", "K-06", "K-14", "CR-TagScale", "K-15"]);
  assert.equal(kitCr("K-04")?.target, "05_Scripts\\library\\index.json");
  assert.equal(kitCrForTarget("03_Master_Data/FMC_KeynoteLegend.json")?.id, "K-14");
  const msg = missingKitMessage("K-04", "Can't read index.json: ENOENT");
  assert.match(msg, /kit file missing, see K-04/);
  assert.match(msg, /library index/);
  assert.match(msg, new RegExp(KIT_CR_DOC.replace(/[\\/]/g, "[\\\\/]")));
  assert.doesNotMatch(msg, /K-16|K-18|K-19|K-20/);
});

test("build quantities: unbound kit parameters are listed and do not look like a pass", () => {
  assert.deepEqual(buildParamsUnbound({}), [...BUILD_PARAMS]);
  assert.deepEqual(buildParamsUnbound({ FMC_Keynote_Code: false, FMC_Construction_Status: false, FMC_Trade_Package: false }), [...BUILD_PARAMS]);
  assert.deepEqual(buildParamsUnbound({ FMC_Keynote_Code: true, FMC_Construction_Status: true, FMC_Trade_Package: true }), []);
  const msg = buildParamsUnboundMessage([...BUILD_PARAMS]);
  assert.match(msg, /FMC_Keynote_Code/);
  assert.match(msg, /nothing was measured/);
  assert.match(msg, /kit file missing, see K-15/);
});

test("sync_exclude spelling: both HEBERT and HERBERT is a K-15 problem; one spelling is not", () => {
  assert.equal(syncExcludeSpellingProblem({ sync_exclude: ["HEBERT HOSTELS"] }), null);
  assert.equal(syncExcludeSpellingProblem({ sync_exclude: ["HERBERT HOSTELS"] }), null);
  assert.equal(syncExcludeSpellingProblem({ sync_exclude: [] }), null);
  const both = syncExcludeSpellingProblem({ sync_exclude: ["HEBERT HOSTELS", "HERBERT HOSTELS"] });
  assert.match(both ?? "", /kit file missing, see K-15/);
  assert.match(both ?? "", /HEBERT/);
  const split = syncExcludeSpellingProblem({ sync_exclude: ["HEBERT HOSTELS"], save_exclude: ["HERBERT HOSTELS"] });
  assert.match(split ?? "", /see K-15/);
});

test("kitCrLines: a missing catalogue, library index and legend are Warn with the CR id; staging-only rte is K-05", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc_kitcr_"));
  try {
    fs.mkdirSync(path.join(dir, "06_Templates", "_Staging"), { recursive: true });
    fs.writeFileSync(path.join(dir, "06_Templates", "_Staging", "FMC_Base_Template_v2.2.rte"), "rte");
    const lines = kitCrLines(dir, probeOf(dir), { sync_exclude: ["HEBERT HOSTELS", "HERBERT HOSTELS"] });
    const by = Object.fromEntries(lines.map((l) => [l.check, l]));
    assert.equal(by["K-02 keynote seed"].state, "Warn");
    assert.match(by["K-02 keynote seed"].detail, /see K-02/);
    assert.equal(by["K-03 details catalogue"].state, "Warn");
    assert.match(by["K-03 details catalogue"].detail, /see K-03/);
    assert.equal(by["K-04 library index"].state, "Warn");
    assert.match(by["K-04 library index"].detail, /see K-04/);
    assert.equal(by["K-05 project templates"].state, "Warn");
    assert.match(by["K-05 project templates"].detail, /_Staging/);
    assert.match(by["K-05 project templates"].detail, /see K-05/);
    assert.equal(by["K-06 schedule sets"].state, "Warn");
    assert.equal(by["K-14 keynote legend"].state, "Warn");
    assert.match(by["K-14 keynote legend"].detail, /see K-14/);
    assert.equal(by["CR-TagScale tag scale"].state, "Warn");
    assert.match(by["CR-TagScale tag scale"].detail, /see CR-TagScale/);
    assert.equal(by["K-15 sync_exclude spelling"].state, "Warn");
    assert.ok(lines.every((l) => l.state !== "Fail"), "a missing CR file is Warn, not Fail");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("kitCrLines: present kit files and a single exclude spelling pass", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc_kitcr_ok_"));
  try {
    const write = (rel: string, body = "{}") => {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    };
    write("02_Keynotes\\Seeds\\FMC_Keynote_Seed.rvt", "rvt");
    write("Details\\FMC_Details.json");
    write("05_Scripts\\library\\index.json", '{"scripts":[]}');
    write("06_Templates\\FMC_Base_Template_v2.2.rte", "rte");
    write("03_Master_Data\\FMC_Schedule_Sets.json");
    write("03_Master_Data\\FMC_KeynoteLegend.json");
    write("03_Master_Data\\FMC_TagScale.json");
    const lines = kitCrLines(dir, probeOf(dir), { sync_exclude: ["HEBERT HOSTELS"] });
    assert.ok(lines.every((l) => l.state === "Pass"), JSON.stringify(lines, null, 2));
    assert.ok(!lines.some((l) => l.check.startsWith("K-15")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
