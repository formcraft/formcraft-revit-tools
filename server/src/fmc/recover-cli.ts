/**
 * CLI for scripts/fmc-recover-revit.ps1. The MCP HTTP server does not have to be running.
 * Usage: node build/fmc/recover-cli.js plan
 *        node build/fmc/recover-cli.js apply <confirm> [--force-unsaved]
 */
import { pathToFileURL } from "node:url";
import { instancesFolder } from "./connect.js";
import { applyRecovery, buildRecoveryPlan } from "./recover.js";
import { liveActions, liveInput } from "./recover-live.js";

async function main() {
  const action = process.argv[2] === "apply" ? "apply" : "plan";
  const confirm = process.argv[3];
  const force = process.argv.includes("--force-unsaved");
  const input = await liveInput(instancesFolder());
  const plan = buildRecoveryPlan(input);
  if (action === "plan") {
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    return;
  }
  const result = await applyRecovery(plan, { confirm, force_unsaved: force }, liveActions);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.ok) process.exitCode = 2;
}

function isMain(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try { return import.meta.url === pathToFileURL(arg).href; } catch { return false; }
}
if (isMain()) void main();
