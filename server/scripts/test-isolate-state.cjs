"use strict";

// Loaded by `npm test` via `node --test --require ./scripts/test-isolate-state.cjs`.
// Redirects Formcraft state (APPDATA, LOCALAPPDATA, FMC_LEDGER_DIR) to a temp
// directory so tests cannot write the live %APPDATA%\Formcraft tree, the live
// MCP token, or the live Revit instances directory. Does not set REVIT_PORT
// and does not copy the live token. CLI children that spread process.env inherit
// the isolated directories.

const fs = require("fs");
const os = require("os");
const path = require("path");

function resolveFormcraft(appdata) {
  if (!appdata) return null;
  return path.resolve(path.join(appdata, "Formcraft"));
}

function sameDir(a, b) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(p).replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

const realAppdata = process.env.APPDATA || "";
const realLocal = process.env.LOCALAPPDATA || "";
const liveHome = resolveFormcraft(realAppdata);
if (!realAppdata || !liveHome) {
  throw new Error("Refusing to run tests: APPDATA is not set, so the live Formcraft state directory cannot be distinguished from a temp dir.");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-test-state-"));
const roaming = path.join(root, "Roaming");
const local = path.join(root, "Local");
const home = path.join(roaming, "Formcraft");
const localHome = path.join(local, "Formcraft");
fs.mkdirSync(path.join(home, "ledger"), { recursive: true });
fs.mkdirSync(path.join(home, "instances"), { recursive: true });
fs.mkdirSync(path.join(home, "jobs"), { recursive: true });
fs.mkdirSync(localHome, { recursive: true });

process.env.APPDATA = roaming;
process.env.LOCALAPPDATA = local;
process.env.FMC_LEDGER_DIR = path.join(home, "ledger");
// Intentionally not set: REVIT_PORT, and no copy of the live mcp-http.token.

const isolatedHome = resolveFormcraft(process.env.APPDATA);
if (!isolatedHome || sameDir(isolatedHome, liveHome)) {
  throw new Error(
    "Refusing to run tests: Formcraft state dir resolved to the live %APPDATA%\\Formcraft (" +
      liveHome +
      "). Tests must use an isolated temp directory."
  );
}

module.exports = { root, home, liveHome };

