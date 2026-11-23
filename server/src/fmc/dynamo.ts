/**
 * Dynamo graphs as data. Inspect reads a .dyn file on disk. It does not start Dynamo, DynamoSandbox, or Revit.
 * A graph runs only from the kit folders 05_Scripts/library and 05_Scripts/Dynamo.
 */
import fs from "node:fs";
import path from "node:path";
import { isInside } from "./policy.js";
import { kitPaths } from "./context.js";
import type { GuardConfig } from "./policy.js";

const win = path.win32;

/** Windows paths stay Windows. A POSIX temp directory in a test stays POSIX, so the file can be read. */
export function pathOf(base: string): path.PlatformPath {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(base) || (base.includes("\\") && !base.includes("/"));
  return windows ? path.win32 : path;
}

const REVIT_TYPE = /RevitNodes|DSRevit|Revit\.Elements|Revit\.Application|DynamoRevit|RevitServices/i;
const REVIT_PACKAGE = /(^|[^a-z0-9])revit([^a-z0-9]|$)/i;
const PYTHON_TYPE = /Python/i;
const WATCH_TYPE = /Watch/i;

export interface DynPort {
  id: string;
  name: string;
  type: string;
}

export interface DynPackage {
  name: string;
  version: string;
  reference: string;
}

export interface DynInspect {
  file: string;
  name: string;
  uuid: string;
  inputs: DynPort[];
  outputs: DynPort[];
  packages: DynPackage[];
  nodes: { count: number; types: Array<{ type: string; count: number }> };
  python_nodes: Array<{ id: string; name: string; engine: string }>;
  revit_nodes: boolean;
  revit_packages: string[];
}

export function kitRootFrom(cfg: GuardConfig, env: NodeJS.ProcessEnv = process.env, given = ""): string {
  const named = given.trim() || (env.FMC_KIT ?? "").trim();
  if (named) return named.replace(/[\\/]+$/, "");
  return kitPaths(cfg).root.replace(/[\\/]+$/, "");
}

/** The only folders a graph or a library script may be loaded from. */
export function scriptRoots(kit: string): string[] {
  const p = pathOf(kit);
  const root = kit.replace(/[\\/]+$/, "");
  return [p.join(root, "05_Scripts", "library"), p.join(root, "05_Scripts", "Dynamo")];
}

export function approvedScriptPath(file: string, kit: string): boolean {
  const target = file.trim();
  if (!target) return false;
  return scriptRoots(kit).some((root) => isInside(target, root) && target.replace(/[\\/]+$/, "").length > root.replace(/[\\/]+$/, "").length);
}

export function outsideRootMessage(file: string, kit: string): string {
  const roots = scriptRoots(kit).join(" or ");
  return `[FMC-SCRIPT-ROOT] ${file || "(no path)"} is outside the kit script folders (${roots}).`;
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function shortType(node: Record<string, unknown>): string {
  const raw = text(node.ConcreteType) || text(node.NodeType) || "Node";
  const head = raw.split(",")[0] ?? raw;
  const parts = head.split(".");
  return parts[parts.length - 1] || head;
}

function portOf(node: Record<string, unknown>, fallback: string): DynPort {
  return {
    id: text(node.Id) || text(node.ID) || fallback,
    name: text(node.Name) || text(node.NickName) || text(node.Symbol) || text(node.Description) || fallback,
    type: text(node.Type) || text(node.TypeName) || shortType(node),
  };
}

function isRevitNode(node: Record<string, unknown>): boolean {
  const blob = [node.ConcreteType, node.NodeType, node.Description, node.FunctionSignature].map(text).join(" ");
  return REVIT_TYPE.test(blob);
}

function isPythonNode(node: Record<string, unknown>): boolean {
  return PYTHON_TYPE.test(text(node.ConcreteType) + " " + text(node.NodeType));
}

function isWatch(node: Record<string, unknown>): boolean {
  return WATCH_TYPE.test(text(node.NodeType) + " " + text(node.ConcreteType) + " " + text(node.Name));
}

/** Parse a Dynamo .dyn JSON file. A .dyn that is not JSON is refused. */
export function parseDyn(file: string, raw: string): { ok: true; inspect: DynInspect } | { ok: false; message: string } {
  let body: unknown;
  try { body = JSON.parse(raw.replace(/^\uFEFF/, "")); }
  catch (error) {
    return { ok: false, message: `[FMC-DYNAMO-PARSE] ${file} is not Dynamo JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: `[FMC-DYNAMO-PARSE] ${file} is not a Dynamo graph object.` };
  }
  const graph = body as Record<string, unknown>;
  const nodes = asArray(graph.Nodes);
  const inputs: DynPort[] = [];
  const outputs: DynPort[] = [];
  const python: DynInspect["python_nodes"] = [];
  const types = new Map<string, number>();
  let revitNodes = false;
  nodes.forEach((node, index) => {
    const type = shortType(node);
    types.set(type, (types.get(type) ?? 0) + 1);
    if (isRevitNode(node)) revitNodes = true;
    if (node.IsSetAsInput === true || node.IsInput === true) inputs.push(portOf(node, `input ${index + 1}`));
    if (node.IsSetAsOutput === true || node.IsOutput === true || isWatch(node)) outputs.push(portOf(node, `output ${index + 1}`));
    if (isPythonNode(node)) python.push({ id: text(node.Id), name: text(node.Name) || type, engine: text(node.Engine) || text(node.EngineName) });
  });
  asArray(graph.Inputs).forEach((item, index) => inputs.push(portOf(item, `input ${index + 1}`)));
  asArray(graph.Outputs).forEach((item, index) => outputs.push(portOf(item, `output ${index + 1}`)));
  const packages: DynPackage[] = [];
  for (const item of [...asArray(graph.NodeLibraryDependencies), ...asArray(graph.Dependencies)]) {
    const name = text(item.Name) || text(item.PackageName) || text(item.Reference);
    if (!name) continue;
    packages.push({ name, version: text(item.Version), reference: text(item.ReferenceType) || text(item.Reference) });
  }
  const revitPackages = [...new Set(packages.map((item) => item.name).filter((name) => REVIT_PACKAGE.test(name) || REVIT_TYPE.test(name)))];
  const seenIn = new Set<string>();
  const seenOut = new Set<string>();
  return {
    ok: true,
    inspect: {
      file,
      name: text(graph.Name) || win.basename(file, ".dyn"),
      uuid: text(graph.Uuid) || text(graph.UUID),
      inputs: inputs.filter((item) => (seenIn.has(item.id + item.name) ? false : (seenIn.add(item.id + item.name), true))),
      outputs: outputs.filter((item) => (seenOut.has(item.id + item.name) ? false : (seenOut.add(item.id + item.name), true))),
      packages,
      nodes: { count: nodes.length, types: [...types.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)) },
      python_nodes: python,
      revit_nodes: revitNodes || revitPackages.length > 0,
      revit_packages: revitPackages,
    },
  };
}

export function readDyn(file: string): { ok: true; inspect: DynInspect } | { ok: false; message: string } {
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) {
    return { ok: false, message: `[FMC-DYNAMO-PARSE] Can't read ${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
  return parseDyn(file, raw);
}

/**
 * DynamoCLI can run a graph that has no Revit nodes. A Revit node package is FMC-DYNAMO-NEEDS-REVIT.
 * This never launches Revit and never replays a journal.
 */
export function offlineDecision(inspect: DynInspect): { ok: true } | { ok: false; code: "FMC-DYNAMO-NEEDS-REVIT"; message: string } {
  if (!inspect.revit_nodes && inspect.revit_packages.length === 0) return { ok: true };
  const names = inspect.revit_packages.length ? inspect.revit_packages.join(", ") : "Revit nodes";
  return {
    ok: false,
    code: "FMC-DYNAMO-NEEDS-REVIT",
    message: `[FMC-DYNAMO-NEEDS-REVIT] This graph uses Revit (${names}). Offline DynamoCLI runs only graphs with no Revit nodes. Revit was not launched.`,
  };
}
