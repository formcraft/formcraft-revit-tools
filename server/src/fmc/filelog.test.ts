import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FILE_LOG_HEADER, fileLogPath, lastFileLogWarning, logSource, resetFileLogWarning, writeFileLog } from "./filelog.js";
import { runAsCaller } from "./caller.js";

function dir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fmc-filelog-"));
}

const at = new Date("2026-11-28T09:00:00.000Z");

test("a new log gets the seven-column header and the pane's rows say Pane", () => {
  const d = dir();
  const warning = writeFileLog({ reports_dir: d }, "save_as", true, "C:\\a.rvt", "dry run", "x, y", at, { FMC_CALLER: "pane" });
  assert.equal(warning, null);
  const text = fs.readFileSync(fileLogPath({ reports_dir: d }), "utf8");
  assert.equal(text, FILE_LOG_HEADER.join(",") + "\r\n" + "2026-11-28T09:00:00.000Z,save_as,true,C:\\a.rvt,dry run,\"x, y\",Pane\r\n");
});

test("an MCP call says the client's name, and no caller says Unknown", () => {
  assert.equal(logSource({}), "Unknown");
  const named = runAsCaller({ client: "claude-ai", session: "s1", transport: "http" }, () => logSource({}));
  assert.equal(named, "claude-ai");
  const pane = runAsCaller({ client: "claude-ai", session: "s1", transport: "http" }, () => logSource({ FMC_CALLER: "Pane" }));
  assert.equal(pane, "Pane");
  const unknown = runAsCaller({ client: "unknown", session: "stdio", transport: "stdio" }, () => logSource({}));
  assert.equal(unknown, "Unknown");
});

test("an old six-column log keeps its header and gets the source as a seventh field", () => {
  const d = dir();
  const file = fileLogPath({ reports_dir: d });
  fs.writeFileSync(file, "timestamp,action,dry_run,target,result,detail\r\n");
  writeFileLog({ reports_dir: d }, "close", false, "B.rvt", "closed", "", at, {});
  const lines = fs.readFileSync(file, "utf8").split("\r\n");
  assert.equal(lines[0], "timestamp,action,dry_run,target,result,detail");
  assert.equal(lines[1], "2026-11-28T09:00:00.000Z,close,false,B.rvt,closed,,Unknown");
});

test("a row that cannot be written is reported, never thrown", () => {
  resetFileLogWarning();
  const d = dir();
  const blocker = path.join(d, "not-a-folder");
  fs.writeFileSync(blocker, "x");
  let warning: string | null = "unset";
  assert.doesNotThrow(() => { warning = writeFileLog({ reports_dir: path.join(blocker, "reports") }, "archive", false, "C.rvt", "moved", "", at, {}); });
  assert.ok(warning && /file log row for archive was not written/.test(warning));
  assert.equal(lastFileLogWarning(), warning);
  writeFileLog({ reports_dir: d }, "archive", false, "C.rvt", "moved", "", at, {});
  assert.equal(lastFileLogWarning(), null);
});

test("no tool keeps its own copy of the file log writer", () => {
  const tools = path.resolve(process.cwd(), "src", "tools");
  const copies = fs.readdirSync(tools).filter((f) => f.endsWith(".ts"))
    .filter((f) => /join\(dir, "FMC_MCP_FileLog\.csv"\)/.test(fs.readFileSync(path.join(tools, f), "utf8")));
  assert.deepEqual(copies, []);
});
