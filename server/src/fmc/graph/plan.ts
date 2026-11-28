/**
 * fmc_dynamo.plan (DT-64) and the named-input binding (R-1, DT-62). A plan is a dry run on paper: it reads the graph,
 * binds inputs by name to node ids, scans it, checks packages, the kit lock and the jail, and returns plan_hash.
 * Nothing runs. An approval is bound to plan_hash; any change gives a new hash.
 */
import fs from "node:fs";
import type { GuardConfig } from "../policy.js";
import { readDyn, type DynInspect } from "../dynamo.js";
import { isInside } from "../policy.js";
import { graphDecisions, PYTHON_ALWAYS_NEEDS_PERSON, APPLY_ALWAYS_NEEDS_PERSON, type GraphDecisions } from "./decisions.js";
import { inputsHash, sha256File, sha256Text, stableJson } from "./hash.js";
import { pathInputsOutsideJail, projectRootOf } from "./jail.js";
import { lockCheck, lockKey, type LockState } from "./lib.js";
import { checkPackages, installedPackages, packageFolders, type PackageCheck } from "./packages.js";
import { readAllowlist } from "./allowlist.js";
import { scanGraph, type GraphScan } from "./scan.js";

export type RunMode = "preview" | "apply" | "offline";

export interface GraphPlan {
  v: 1;
  graph: string;
  /** v1.3: the kit lock key (path under the kit, lower case, "\\" separators), or the file name without .dyn outside the kit. */
  graph_id: string;
  graph_sha256: string;
  deps_sha256: string;
  inputs_by_id: Record<string, unknown>;
  input_binding: Array<{ given: string; id: string; name: string }>;
  inputs_hash: string;
  document: { title: string; path: string; state: string };
  mode: RunMode;
  scan_hash: string;
  allowlist_version: string;
  lock: LockState;
  python: boolean;
  needs_approval: boolean;
  approval_why: string[];
  approval_kind: "graph_run" | "graph_python" | "graph_offline";
  project_root: string;
  findings: number;
  packages: PackageCheck;
  plan_hash: string;
}

export type PlanResult = { ok: true; plan: GraphPlan; scan: GraphScan; inspect: DynInspect } | { ok: false; code: string; message: string; reasons?: string[] };

export interface BindResult { ok: boolean; by_id: Record<string, unknown>; binding: Array<{ given: string; id: string; name: string }>; unknown: string[]; ambiguous: string[] }

/**
 * Map each input to its node id. A key that is a node id of a marked input stays; otherwise the key must match exactly
 * one marked input's name (case and outer spaces ignored). Unknown and ambiguous names refuse the run; nothing is dropped.
 */
export function bindInputsByName(inspect: Pick<DynInspect, "inputs">, inputs: Record<string, unknown>): BindResult {
  const byId: Record<string, unknown> = {};
  const binding: BindResult["binding"] = [];
  const unknown: string[] = [];
  const ambiguous: string[] = [];
  const ids = new Map(inspect.inputs.map((p) => [p.id.toLowerCase(), p]));
  for (const [key, value] of Object.entries(inputs ?? {})) {
    const k = key.trim();
    const direct = ids.get(k.toLowerCase());
    if (direct) { byId[direct.id] = value; binding.push({ given: key, id: direct.id, name: direct.name }); continue; }
    const hits = inspect.inputs.filter((p) => p.name.trim().toLowerCase() === k.toLowerCase());
    if (hits.length === 1) { byId[hits[0].id] = value; binding.push({ given: key, id: hits[0].id, name: hits[0].name }); }
    else if (hits.length === 0) unknown.push(key);
    else ambiguous.push(key);
  }
  return { ok: unknown.length === 0 && ambiguous.length === 0, by_id: byId, binding, unknown, ambiguous };
}

/** The kit lock key when the graph is in the kit, otherwise the file name without .dyn. */
export function graphIdOf(file: string, kit: string): string {
  if (kit && isInside(file, kit)) return lockKey(kit, file);
  return (file.split(/[\\/]/).pop() ?? file).replace(/\.dyn$/i, "");
}

export function planHash(parts: Pick<GraphPlan, "v" | "graph_sha256" | "deps_sha256" | "inputs_hash" | "document" | "mode" | "scan_hash" | "allowlist_version">): string {
  return sha256Text(stableJson({
    v: parts.v, graph_sha256: parts.graph_sha256, deps_sha256: parts.deps_sha256, inputs_hash: parts.inputs_hash,
    document: { path: parts.document.path.toLowerCase(), title: parts.document.title, state: parts.document.state },
    mode: parts.mode, scan_hash: parts.scan_hash, allowlist_version: parts.allowlist_version,
  }));
}

export function documentState(docPath: string): string {
  if (!docPath.trim()) return "";
  try { const s = fs.statSync(docPath); return `${s.size}:${Math.trunc(s.mtimeMs)}`; } catch { return ""; }
}

/** When a run needs a person's approval. Python and apply and offline are hard rules; nothing in config changes them. */
export function runNeedsApproval(plan: Pick<GraphPlan, "python" | "mode">): { needed: boolean; why: string[]; kind: GraphPlan["approval_kind"] } {
  const why: string[] = [];
  if (PYTHON_ALWAYS_NEEDS_PERSON && plan.python) why.push("The graph has Python (a Python node, Python from a wire, or a package DLL): a person approves every run.");
  if (APPLY_ALWAYS_NEEDS_PERSON && plan.mode === "apply") why.push("apply keeps changes: a person approves this exact plan.");
  if (plan.mode === "offline") why.push("offline runs DynamoCLI outside Revit's gate: a person approves this exact plan.");
  const kind = plan.python ? "graph_python" : plan.mode === "offline" ? "graph_offline" : "graph_run";
  return { needed: why.length > 0, why, kind };
}

export interface PlanArgs {
  file: string;
  inputs?: Record<string, unknown>;
  mode: RunMode;
  document: { title: string; path: string } | null;
  kit: string;
  cfg: GuardConfig;
  env?: NodeJS.ProcessEnv;
  decisions?: GraphDecisions;
  /** Tests: the package folders to search. */
  packageDirs?: string[];
}

export function buildPlan(args: PlanArgs): PlanResult {
  const env = args.env ?? process.env;
  const decisions = args.decisions ?? graphDecisions(args.cfg);
  const parsed = readDyn(args.file);
  if (!parsed.ok) return { ok: false, code: "FMC-DYNAMO-PARSE", message: parsed.message };
  const inspect = parsed.inspect;
  const bound = bindInputsByName(inspect, args.inputs ?? {});
  if (!bound.ok) {
    const names = inspect.inputs.map((p) => p.name).join(", ") || "(none)";
    const parts = [
      bound.unknown.length ? `unknown ${bound.unknown.join(", ")}` : "",
      bound.ambiguous.length ? `more than one input is named ${bound.ambiguous.join(", ")} (use the node id from inspect)` : "",
    ].filter(Boolean).join("; ");
    return { ok: false, code: "FMC-DYNAMO-INPUT", message: `[FMC-DYNAMO-INPUT] Graph inputs not set: ${parts}. Marked inputs: ${names}. Nothing ran.` };
  }
  const projectRoot = projectRootOf(args.document?.path ?? "");
  if (projectRoot) {
    // Every path-like input sits in the project jail; the kit is also allowed because it is read-only.
    const outside = pathInputsOutsideJail(bound.by_id, projectRoot).filter((msg) => {
      const m = /\[FMC-GRAPH-JAIL\] (.+?) (uses|is|has|leaves)/.exec(msg);
      return !(m && args.kit && isInside(m[1], args.kit));
    });
    if (outside.length) return { ok: false, code: "FMC-GRAPH-JAIL", message: outside[0], reasons: outside };
  }
  const folders = args.packageDirs ?? packageFolders(env);
  const allow = readAllowlist(env, decisions);
  const pkgs = checkPackages(inspect, installedPackages(folders), folders, decisions, allow.packages);
  const scan = scanGraph(args.file, pkgs.dll_findings);
  if (!scan.ok) return { ok: false, code: "FMC-DYNAMO-PARSE", message: scan.message ?? "scan failed" };
  const graphSha = sha256File(args.file);
  const python = scan.python || inspect.python_nodes.length > 0;
  const lock = args.kit ? lockCheck(args.kit, args.file, graphSha) : "absent";
  if (python && decisions.python_policy === "off") {
    return { ok: false, code: "FMC-GRAPH-PYTHON-OFF", message: "[FMC-GRAPH-PYTHON-OFF] Python graphs are off (decision D1, python_policy off). Nothing ran." };
  }
  if (python && decisions.python_policy === "signed_kit_only" && lock !== "match") {
    return { ok: false, code: "FMC-GRAPH-PYTHON-UNSIGNED", message: `[FMC-GRAPH-PYTHON-UNSIGNED] Python graphs run only when the kit lock lists their hash (lock ${lock}). Nothing ran.` };
  }
  const deps = pkgs.packages.filter((p) => p.installed).map((p) => ({ name: p.name, version: p.installed, folder_sha256: p.folder_sha256 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const document = { title: args.document?.title ?? "", path: args.document?.path ?? "", state: documentState(args.document?.path ?? "") };
  const base = {
    v: 1 as const, graph_sha256: graphSha, deps_sha256: deps.length ? sha256Text(stableJson(deps)) : "",
    inputs_hash: inputsHash(bound.by_id), document, mode: args.mode, scan_hash: scan.scan_hash, allowlist_version: allow.version,
  };
  const need = runNeedsApproval({ python, mode: args.mode });
  const plan: GraphPlan = {
    ...base,
    graph: args.file,
    graph_id: graphIdOf(args.file, args.kit),
    inputs_by_id: bound.by_id,
    input_binding: bound.binding,
    lock,
    python,
    needs_approval: need.needed,
    approval_why: need.why,
    approval_kind: need.kind,
    project_root: projectRoot,
    findings: scan.findings.length,
    packages: pkgs,
    plan_hash: planHash(base),
  };
  return { ok: true, plan, scan, inspect };
}
