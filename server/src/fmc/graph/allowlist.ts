/**
 * fmc_graph_guard.allowlist (DT-56): the Python allowlist (imports, assemblies, packages by name, version and hash).
 * Owned by a person (D2, the BIM Manager). The AI reads it and may propose entries; nothing here writes it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256Text } from "./hash.js";
import type { GraphDecisions } from "./decisions.js";

export interface Allowlist {
  file: string;
  present: boolean;
  version: string;
  owner: string;
  imports: string[];
  assemblies: string[];
  packages: Array<{ name: string; version?: string; sha256?: string }>;
  problems: string[];
}

export function allowlistFile(env: NodeJS.ProcessEnv = process.env, decisions?: Pick<GraphDecisions, "allowlist_file">): string {
  const named = decisions?.allowlist_file?.trim() || env.FMC_GRAPH_ALLOWLIST?.trim();
  if (named) return named.replace(/%([^%]+)%/g, (_, key: string) => env[key] ?? `%${key}%`);
  const base = env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "Formcraft", "graph_allowlist.json");
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : []);

export function readAllowlist(env: NodeJS.ProcessEnv = process.env, decisions?: Pick<GraphDecisions, "allowlist_file" | "allowlist_owner">): Allowlist {
  const file = allowlistFile(env, decisions);
  const owner = decisions?.allowlist_owner ?? "BIM Manager";
  const empty: Allowlist = { file, present: false, version: "none", owner, imports: [], assemblies: [], packages: [], problems: [] };
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return empty; }
  try {
    const o = JSON.parse(raw.replace(/^\uFEFF/, "")) as Record<string, unknown>;
    const packages = (Array.isArray(o.packages) ? o.packages : []).flatMap((p) => {
      if (typeof p === "string") return [{ name: p }];
      if (p && typeof p === "object" && typeof (p as { name?: unknown }).name === "string") {
        const r = p as { name: string; version?: unknown; sha256?: unknown };
        return [{ name: r.name, ...(typeof r.version === "string" ? { version: r.version } : {}), ...(typeof r.sha256 === "string" ? { sha256: r.sha256 } : {}) }];
      }
      return [];
    });
    const version = typeof o.version === "string" && o.version.trim() ? `${o.version.trim()}+${sha256Text(raw).slice(0, 12)}` : sha256Text(raw).slice(0, 12);
    return { file, present: true, version, owner, imports: strings(o.imports), assemblies: strings(o.assemblies), packages, problems: [] };
  } catch (error) {
    return { ...empty, present: true, version: `invalid+${sha256Text(raw).slice(0, 12)}`, problems: [`Not JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
