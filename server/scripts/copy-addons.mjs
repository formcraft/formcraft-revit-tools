// Copies the saved add-ons (resources/addons: the C# bodies and their sample parameters) into build/addons, so they ship
// with the server: scripts/fmc-stage.ps1 stages server\build as it is (docs/ADDONS.md).
import fs from "node:fs";

const from = "../resources/addons";
const to = "build/addons";
fs.rmSync(to, { recursive: true, force: true });
if (fs.existsSync(from)) {
  fs.cpSync(from, to, { recursive: true });
  console.log(`Add-ons: ${fs.readdirSync(to).filter((n) => n.endsWith(".cs")).length} copied to ${to}`);
} else {
  console.warn(`No ${from}: no add-ons in this build`);
}
