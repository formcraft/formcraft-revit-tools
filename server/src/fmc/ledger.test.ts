import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendLedger, callLine, cleanPurpose, codeHash, ledgerDir, monthFile, monthsBetween, projectOf, readLedger, recorded,
  startedByFrom, withLedger } from "./ledger.js";

const tmp = () => ({ FMC_LEDGER_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "fmc-ledger-")) }) as NodeJS.ProcessEnv;
const at = new Date("2026-10-19T08:00:00Z");

test("the ledger folder is FMC_LEDGER_DIR, else %APPDATA%\\Formcraft\\ledger; one file per month", () => {
  assert.equal(ledgerDir({ FMC_LEDGER_DIR: "C:\\t\\l" }), "C:\\t\\l");
  assert.match(ledgerDir({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" }), /Roaming[\\/]Formcraft[\\/]ledger$/);
  assert.match(monthFile("D", "calls", at), /calls-2026-10\.jsonl$/);
  assert.match(monthFile("D", "external", at), /external-2026-10\.jsonl$/);
  assert.deepEqual(monthsBetween("2026-11-20", "2027-02-01"), ["2026-11", "2026-12", "2027-01", "2027-02"]);
});

test("who started it: FMC_STARTED_BY when it names one, else the fallback", () => {
  assert.equal(startedByFrom({ FMC_STARTED_BY: "pane" }, "cli"), "pane");
  assert.equal(startedByFrom({ FMC_STARTED_BY: " Schedule " }, "cli"), "schedule");
  assert.equal(startedByFrom({ FMC_STARTED_BY: "someone" }, "ai"), "ai");
  assert.equal(startedByFrom({}, "ai"), "ai");
});

test("the project comes from the call's own arguments, never a person", () => {
  assert.equal(projectOf({ project_code: "kisic" }), "KISIC");
  assert.equal(projectOf({ project: "kisic" }), "KISIC");
  assert.equal(projectOf({ project: "a long free text" }), "");
  assert.equal(projectOf({ project_folder: "Z:\\Projects\\F26001_Clinic\\" }), "F26001");
  assert.equal(projectOf({}, "KISIC-FMC-ZZ-01-M3-E-0001.rvt"), "KISIC");
  assert.equal(projectOf({}), "");
});

test("a line holds the tool, action, result, time, project and starter only; send_code adds purpose and a code hash", () => {
  const plain = callLine("fmc_qa", { action: "run", project_folder: "Z:\\P\\F26001_X", note: "Jane Doe asked" }, true, 12.6, "ai", at);
  assert.deepEqual(plain, { at: at.toISOString(), tool: "fmc_qa", action: "run", ok: true, ms: 13, project: "F26001", started_by: "ai" });
  assert.doesNotMatch(JSON.stringify(plain), /Jane/);

  const code = "var x = 1;\n  return x;";
  const sc = callLine("send_code_to_revit", { code, purpose: "  export\nsheet PNGs  " }, false, 900, "ai", at);
  assert.equal(sc.purpose, "export sheet PNGs");
  assert.equal(sc.code_hash, codeHash("var x = 1; return x;"));
  assert.equal(sc.code_hash!.length, 12);
  assert.doesNotMatch(JSON.stringify(sc), /var x/);
  assert.equal(callLine("send_code_to_revit", { code }, true, 1, "ai", at).purpose, undefined);
  assert.equal(cleanPurpose("x".repeat(200)).length, 120);
  assert.equal(callLine("fmc_scripts", { action: "addon_run", name: "qa_orphans" }, true, 1, "pane", at).addon, "qa_orphans");
});

test("recorded passes the answer or the error on untouched and writes one line either way", async () => {
  const env = tmp();
  const answer = await recorded("fmc_qa", { action: "run" }, "pane", async () => ({ content: [], isError: true }), undefined, env);
  assert.equal(answer.isError, true);
  await assert.rejects(recorded("fmc_doc", {}, "job", () => { throw new Error("boom"); }, undefined, env), /boom/);
  const lines = readLedger("calls", "", "", env);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => [l.tool, l.ok, l.started_by]), [["fmc_qa", false, "pane"], ["fmc_doc", false, "job"]]);
});

test("logging never fails a call: an unwritable ledger is ignored", async () => {
  const file = path.join(os.tmpdir(), `fmc-ledger-file-${process.pid}`);
  fs.writeFileSync(file, "a file, not a folder");
  const env = { FMC_LEDGER_DIR: path.join(file, "sub") } as NodeJS.ProcessEnv;
  assert.doesNotThrow(() => appendLedger("calls", { x: 1 }, env));
  assert.equal(await recorded("fmc_qa", {}, "ai", () => 42, undefined, env), 42);
});

test("readLedger keeps the period's months and skips torn lines", () => {
  const env = tmp();
  appendLedger("calls", { at: "2026-09-30T10:00:00Z", tool: "a" }, env, new Date("2026-09-30T10:00:00Z"));
  appendLedger("calls", { at: "2026-10-01T10:00:00Z", tool: "b" }, env, new Date("2026-10-01T10:00:00Z"));
  fs.appendFileSync(monthFile(env.FMC_LEDGER_DIR!, "calls", new Date("2026-10-01T00:00:00Z")), "{torn\n");
  assert.deepEqual(readLedger("calls", "2026-10-01", "2026-10-19", env).map((l) => l.tool), ["b"]);
  assert.deepEqual(readLedger("calls", "", "", env).map((l) => l.tool), ["a", "b"]);
  assert.deepEqual(readLedger("external", "", "", env), []);
});

test("withLedger wraps every server.tool handler in one place and keeps other registrations as they are", async () => {
  const env = tmp();
  const saved = process.env.FMC_LEDGER_DIR;
  process.env.FMC_LEDGER_DIR = env.FMC_LEDGER_DIR;
  try {
    const registered: Record<string, (args: any, extra: any) => any> = {};
    const server = { tool: (...a: any[]) => { registered[a[0]] = a[a.length - 1]; } };
    withLedger(server, "ai", () => "KISIC-FMC-ZZ-ZZ-M3-A-0001.rvt");
    server.tool("send_code_to_revit", "d", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));
    server.tool("say_hello", async () => "no shape");
    const r = await registered.send_code_to_revit({ code: "return 1;", purpose: "probe" }, {});
    assert.equal(r.content[0].text, "ok");
    const [line] = readLedger("calls", "", "", env);
    assert.equal(line.tool, "send_code_to_revit");
    assert.equal(line.started_by, "ai");
    assert.equal(line.project, "KISIC");
    assert.equal(line.purpose, "probe");
    assert.equal(await registered.say_hello({}, {}), "no shape");
    assert.equal(readLedger("calls", "", "", env).length, 1);
  } finally {
    if (saved === undefined) delete process.env.FMC_LEDGER_DIR; else process.env.FMC_LEDGER_DIR = saved;
  }
});
