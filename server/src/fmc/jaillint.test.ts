/** JAIL lint (T19): a tool path argument that is not routed through the jail fails, unless the Phase 5 baseline lists it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lintTools, pathArgs, routed } from "./jaillint.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = path.resolve(here, "../../src/tools");
const baselineFile = path.resolve(here, "../../src/fmc/fixtures/jail_lint_baseline.json");

function toolSources(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(toolsDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) out[f] = fs.readFileSync(path.join(toolsDir, f), "utf8");
  return out;
}

test("JAIL lint: every tool path argument is routed through the jail or listed in the Phase 5 baseline", () => {
  const baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8")).unrouted as string[];
  const r = lintTools(toolSources(), baseline);
  assert.deepEqual(r.unrouted, [], `Route these through jailArgs/checkArg (fmc/jailctx.ts): ${r.unrouted.join(", ")}`);
  assert.deepEqual(r.staleBaseline, [], `Now routed: take them out of jail_lint_baseline.json: ${r.staleBaseline.join(", ")}`);
  assert.ok(r.routedCount >= 10, `expected the core tools to be routed (got ${r.routedCount})`);
  assert.ok(baseline.length <= 92, "the baseline only shrinks");
});

test("JAIL lint: the four known tools (91-95) are routed", () => {
  const src = toolSources();
  for (const [file, param] of [["fmc_tables.ts", "workbook"], ["fmc_tables.ts", "kit_folder"], ["fmc_template.ts", "seed_path"], ["fmc_testrun.ts", "scenarios_dir"], ["fmc_trace.ts", "copy_to"], ["fmc_trace.ts", "path"]] as const)
    assert.equal(routed(src[file], param), true, `${file} ${param}`);
});

test("JAIL lint catches a new unrouted path argument and accepts a routed one", () => {
  const bad = `const S = {\n  report_folder: z.string(),\n  count: z.number(),\n};`;
  assert.deepEqual(pathArgs(bad), ["report_folder"]);
  assert.deepEqual(lintTools({ "x.ts": bad }, []).unrouted, ["x.ts:report_folder"]);
  const good = bad + `\njailArgs("x", j, [["report_folder", "write", a.report_folder]]);`;
  assert.deepEqual(lintTools({ "x.ts": good }, []).unrouted, []);
  assert.deepEqual(lintTools({ "x.ts": good }, ["x.ts:report_folder"]).staleBaseline, ["x.ts:report_folder"]);
});
