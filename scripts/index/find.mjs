#!/usr/bin/env node
// Short way to look something up in the repo index (docs/INDEX.md): node scripts/index/find.mjs <key or words>
// Needs the server built once (cd server && npm run build); the index itself rebuilds itself when git changes.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("../../server/build/fmc/repoindex_cli.js", import.meta.url));
if (!existsSync(cli)) { console.error("Build the server first: cd server && npm run build"); process.exit(2); }
const r = spawnSync(process.execPath, [cli, "find", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
