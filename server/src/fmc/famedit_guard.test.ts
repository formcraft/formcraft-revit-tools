import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WRITE_COMMANDS } from "./policy.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), "utf8");
const TOOLS = ["nested", "hosting", "connector"];

test("family editor commands: the apply ones are write commands, the read ones are not, and all six are in the manifest", () => {
  const names = (JSON.parse(read("command.json").replace(/^\uFEFF/, "")) as { commands: Array<{ commandName: string }> }).commands.map((c) => c.commandName);
  for (const t of TOOLS) {
    assert.ok(WRITE_COMMANDS.has(`fmc_fam_${t}_apply`), `${t} apply is a write command`);
    assert.ok(!WRITE_COMMANDS.has(`fmc_fam_${t}_read`), `${t} read is not`);
    assert.ok(names.includes(`fmc_fam_${t}_apply`) && names.includes(`fmc_fam_${t}_read`), `${t} is in command.json`);
    const cs = read("commandset", "Commands", "Fmc", "FmcFamEditCommands.cs");
    assert.match(cs, new RegExp(`CommandName => "fmc_fam_${t}_apply"`));
    assert.match(cs, new RegExp(`CommandName => "fmc_fam_${t}_read"`));
  }
});

test("the add-in refuses projects, runs a change in one transaction and rolls the dry run (and a failed step) back", () => {
  const svc = read("commandset", "Services", "Fmc", "FmcFamEdit.cs");
  assert.match(svc, /if \(!doc\.IsFamilyDocument\)/);
  assert.match(svc, /if \(dry \|\| failed\) t\.RollBack\(\);/);
  assert.equal((svc.match(/new Transaction\(/g) ?? []).length, 1);
  for (const f of ["FmcFamNested", "FmcFamHosting", "FmcFamConnector"]) assert.doesNotMatch(read("commandset", "Services", "Fmc", `${f}.cs`), /new Transaction\(|\.Save\(|SaveAs/, `${f} opens no transaction of its own and never saves`);
});

test("every tool source reaches Revit only through the shared send, and no new file passes the 300-line rule", () => {
  for (const f of ["fmc_fam_nested.ts", "fmc_fam_hosting.ts", "fmc_fam_connector.ts"]) assert.doesNotMatch(read("server", "src", "tools", f), /sendCommand|sendRaw|withRevitConnection/);
  const files = ["server/src/fmc/famedit_common.ts", "server/src/fmc/famconn_rules.ts", "server/src/fmc/famhost_plan.ts", "server/src/fmc/famnested_plan.ts",
    "server/src/tools/fmc_fam_nested.ts", "server/src/tools/fmc_fam_hosting.ts", "server/src/tools/fmc_fam_connector.ts",
    "commandset/Services/Fmc/FmcFamEdit.cs", "commandset/Services/Fmc/FmcFamNested.cs", "commandset/Services/Fmc/FmcFamHosting.cs", "commandset/Services/Fmc/FmcFamConnector.cs",
    "commandset/Commands/Fmc/FmcFamEditCommands.cs"];
  for (const f of files) assert.ok(read(...f.split("/")).split(/\r?\n/).length <= 300, `${f} is over 300 lines`);
});
