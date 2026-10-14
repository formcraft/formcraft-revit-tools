// Writes build/build-info.json: the git commit and build time of this server build, read by fmc_selftest to compare
// with the add-in's stamp. "+local" marks a build from uncommitted changes.
import { execSync } from "node:child_process";
import fs from "node:fs";

const git = (cmd) => { try { return execSync(`git ${cmd}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } };
const commit = git("rev-parse --short HEAD") || "unknown";
const dirty = git("status --porcelain --untracked-files=no") !== "";
fs.mkdirSync("build", { recursive: true });
fs.writeFileSync("build/build-info.json", JSON.stringify({ commit: commit + (dirty ? "+local" : ""), built: new Date().toISOString().replace(/\.\d+Z$/, "Z") }, null, 2));
