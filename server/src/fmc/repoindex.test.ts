import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildIndex, describe, entryOf, liveLine, loadIndex, queryIndex, words } from "./repoindex.js";

// A throwaway git repo with one of each kind the index knows; nothing here reads the real repo.
function fixtureRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-index-"));
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put("docs/TEST_FEEDBACK.md", "# Test feedback\n\n| ID | Severity | Area | What | State |\n|---|---|---|---|---|\n| F-001 | High | AI rules | The switch is missing; see fmc_demo | Open: retest |\n");
  put("docs/STATUS.md", "# Status\n\n| Step | State | Note |\n|---|---|---|\n| U01 Pane frame | Done | PR #7 |\n");
  put("docs/UI_DEVELOPMENT.md", "# UI\n\n- [~] U02 General AI switch — pane top. Needs F-001 fixed.\n");
  put("docs/DECISIONS.md", "# Decisions\n\n| ID | Decision | State |\n|---|---|---|\n| D1 | Shared models need the toggle | Decided |\n");
  put("docs/GUIDE.md", "# Guide\n\nHow the plugin works.\n\n## Approval queue\n\nEvery AI batch waits in the approval queue until the author approves it. F-001 and fmc_demo.\n");
  put("server/src/tools/fmc_demo.ts", "export const FMC_DEMO_DESCRIPTION =\n  \"Demo tool for the index tests.\";\nexport const FMC_DEMO_SHAPE = { action: z.enum([\"status\", \"stop\"]) };\nexport async function runFmcDemo() {}\n");
  put("commandset/Demo.cs", "/// <summary>Reads the demo state.</summary>\npublic class DemoCommand { public override string CommandName => \"demo_cmd\"; }\n");
  put("server/src/hub/apps.ts", "export const APPS: AppDef[] = [\n  { id: \"rhino\", name: \"Rhino 8\", kind: \"bridge\", tools: [\"fmc_demo\"] },\n];\n");
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: root, stdio: "pipe" });
  git("init", "-q"); git("add", "."); git("commit", "-q", "-m", "Demo setup (#7)");
  return root;
}

const root = fixtureRepo();
const ix = buildIndex(root);

test("IDs are defined at their homes, with status, including checklist items", () => {
  assert.equal(entryOf(ix, "F-001")?.status, "Open");
  assert.equal(entryOf(ix, "U01")?.status, "Done");
  assert.equal(entryOf(ix, "U02")?.status, "In progress");
  assert.equal(entryOf(ix, "U02")?.where, "docs/UI_DEVELOPMENT.md");
  assert.equal(entryOf(ix, "D1")?.kind, "decision");
});

test("exact keys are hashtable hits; an undefined ID is not found, never a guess", () => {
  for (const [q, key] of [["F-001", "F-001"], ["f-1", "F-001"], ["#7", "PR-7"], ["fmc_demo", "tool:fmc_demo"], ["demo_cmd", "cmd:demo_cmd"], ["rhino", "app:rhino"]]) {
    const r = queryIndex(ix, q);
    assert.ok(r.exact && r.strong, q);
    assert.equal(r.results[0].entry.key, key, q);
  }
  for (const q of ["F-999", "D99", "PR-12345"]) {
    const r = queryIndex(ix, q);
    assert.equal(r.results.length, 0, q);
    assert.equal(r.strong, false, q);
  }
});

test("words land on the section, and words the index doesn't know make the answer weak", () => {
  const r = queryIndex(ix, "approval queue");
  assert.equal(r.results[0].entry.key, "sec:docs/GUIDE.md#approval-queue");
  assert.ok(r.strong);
  assert.equal(queryIndex(ix, "zebra quantum flux").results.length, 0);
  assert.equal(queryIndex(ix, "approval zebra quantum flux capacitor").strong, false, "one known word out of five is not an answer");
});

test("links: same line, same PR, tool to its app; tools carry their actions", () => {
  const f = entryOf(ix, "F-001")!;
  assert.ok(f.links.includes("tool:fmc_demo"), f.links.join(","));
  assert.ok(entryOf(ix, "tool:fmc_demo")!.links.includes("app:rhino"));
  assert.ok(entryOf(ix, "PR-7")!.links.includes("file:server/src/tools/fmc_demo.ts"));
  assert.deepEqual(entryOf(ix, "tool:fmc_demo")!.actions, ["status", "stop"]);
  assert.equal(entryOf(ix, "cmd:demo_cmd")!.summary, "Reads the demo state.");
});

test("the live line is found from the anchor, so edits above it don't break the index", () => {
  const f = entryOf(ix, "F-001")!;
  assert.equal(liveLine(root, f), 5);
  fs.writeFileSync(path.join(root, "docs/TEST_FEEDBACK.md"), "# Test feedback\n\nA new paragraph.\n\n" + fs.readFileSync(path.join(root, "docs/TEST_FEEDBACK.md"), "utf8").split("\n").slice(2).join("\n"));
  assert.equal(liveLine(root, f), 7);
  assert.match(describe(ix, root, queryIndex(ix, "F-001")), /docs\/TEST_FEEDBACK\.md:7/);
});

test("the cache is rebuilt when the work tree changes", () => {
  const a = loadIndex({ root });
  const b = loadIndex({ root });
  assert.equal(b.cached, true);
  fs.writeFileSync(path.join(root, "docs/NEW.md"), "# New doc\n\nFresh words: pomegranate.\n");
  const c = loadIndex({ root });
  assert.equal(c.cached, false);
  assert.ok(queryIndex(c.index, "pomegranate").results.length > 0);
  assert.ok(a.index.entries.length < c.index.entries.length);
});

test("words split camelCase and snake_case and fold plurals", () => {
  assert.deepEqual(words("liveLockVerdict ai_modeller Batches"), ["live", "lock", "verdict", "ai", "modeller", "batche"]);
});
