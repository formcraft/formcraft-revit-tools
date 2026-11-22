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
  /** The value saved on the node. Null when the graph does not set one. */
  default_value: unknown;
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
  /** A Revit node or a Revit package. Python that imports Revit does not set this. */
  revit_nodes: boolean;
  revit_packages: string[];
  /** Python that references the Revit API, even when the graph has no Revit nodes. */
  needs_revit: boolean;
  /** The Revit imports found in embedded Python, such as RevitServices or clr.AddReference('RevitAPI'). */
  python_revit_refs: string[];
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

function nodeId(node: Record<string, unknown>, fallback: string): string {
  return text(node.Id) || text(node.ID) || fallback;
}

function pickDefault(sources: Array<Record<string, unknown> | undefined>): unknown {
  for (const source of sources) {
    if (!source) continue;
    for (const key of ["DefaultValue", "InputValue", "Value"]) {
      if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
    }
  }
  return null;
}

function portType(sources: Array<Record<string, unknown> | undefined>, fallback: string): string {
  for (const source of sources) {
    if (!source) continue;
    const named = text(source.Type) || text(source.TypeName);
    if (named) return named;
  }
  for (const source of sources) {
    if (!source) continue;
    const described = text(asArray(source.Outputs)[0]?.Description);
    if (described) return described;
    if (text(source.ConcreteType) || text(source.NodeType)) {
      const short = shortType(source);
      if (short && short !== "Node") return short;
    }
  }
  return fallback;
}

function realName(value: string): boolean {
  return value.length > 0 && !/^input \d+$/.test(value) && !/^output \d+$/.test(value);
}

/** Later sources fill a blank name, type or default. A real name on the node view wins over a blank node name. */
function mergePort(current: DynPort | undefined, next: DynPort): DynPort {
  if (!current) return next;
  return {
    id: current.id || next.id,
    name: realName(next.name) ? next.name : current.name,
    type: next.type && next.type !== "Node" ? next.type : current.type,
    default_value: next.default_value !== null && next.default_value !== undefined ? next.default_value : current.default_value,
  };
}

function viewNodes(graph: Record<string, unknown>): Record<string, unknown>[] {
  const view = graph.View;
  if (!view || typeof view !== "object" || Array.isArray(view)) return [];
  return asArray((view as Record<string, unknown>).NodeViews);
}

const PYTHON_REVIT_REFS: Array<{ label: string; re: RegExp }> = [
  { label: "clr.AddReference('RevitAPIUI')", re: /clr\s*\.\s*AddReference\s*\(\s*['"]RevitAPIUI['"]\s*\)/i },
  { label: "clr.AddReference('RevitAPI')", re: /clr\s*\.\s*AddReference\s*\(\s*['"]RevitAPI['"]\s*\)/i },
  { label: "clr.AddReference('RevitServices')", re: /clr\s*\.\s*AddReference\s*\(\s*['"]RevitServices['"]\s*\)/i },
  { label: "clr.AddReference('RevitNodes')", re: /clr\s*\.\s*AddReference\s*\(\s*['"]RevitNodes['"]\s*\)/i },
  { label: "from Autodesk.Revit", re: /\bfrom\s+Autodesk\.Revit\b/ },
  { label: "import Autodesk.Revit", re: /\bimport\s+Autodesk\.Revit\b/ },
  { label: "Autodesk.Revit", re: /\bAutodesk\.Revit\b/ },
  { label: "RevitAPIUI", re: /\bRevitAPIUI\b/ },
  { label: "RevitAPI", re: /\bRevitAPI(?!UI)\b/ },
  { label: "RevitServices", re: /\bRevitServices\b/ },
  { label: "RevitNodes", re: /\bRevitNodes\b/ },
  { label: "DocumentManager", re: /\bDocumentManager\b/ },
  { label: "TransactionManager", re: /\bTransactionManager\b/ },
];

/** Imports and references that mean this Python cannot run in DynamoCLI. */
export function pythonRevitRefs(code: string): string[] {
  const found: string[] = [];
  for (const rule of PYTHON_REVIT_REFS) if (rule.re.test(code) && !found.includes(rule.label)) found.push(rule.label);
  return found;
}

function pythonCode(node: Record<string, unknown>): string {
  return [node.Code, node.Script, node.CodeBody].filter((item) => typeof item === "string").join("\n");
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
  const views = viewNodes(graph);
  const viewById = new Map(views.map((item) => [nodeId(item, ""), item]));
  const nodeById = new Map(nodes.map((item, index) => [nodeId(item, `node ${index + 1}`), item]));
  const inputs = new Map<string, DynPort>();
  const outputs = new Map<string, DynPort>();
  const python: DynInspect["python_nodes"] = [];
  const pythonRefs: string[] = [];
  const types = new Map<string, number>();
  let revitNodes = false;
  const asPort = (id: string, sources: Array<Record<string, unknown> | undefined>, fallbackName: string): DynPort => ({
    id,
    name: sources.map((item) => text(item?.Name) || text(item?.NickName) || text(item?.Symbol)).find(realName) || fallbackName,
    type: portType(sources, "Node"),
    default_value: pickDefault(sources),
  });
  nodes.forEach((node, index) => {
    const id = nodeId(node, `node ${index + 1}`);
    const type = shortType(node);
    const view = viewById.get(id);
    types.set(type, (types.get(type) ?? 0) + 1);
    if (isRevitNode(node)) revitNodes = true;
    const input = node.IsSetAsInput === true || node.IsInput === true || view?.IsSetAsInput === true;
    const output = node.IsSetAsOutput === true || node.IsOutput === true || view?.IsSetAsOutput === true || isWatch(node);
    if (input) inputs.set(id, mergePort(inputs.get(id), asPort(id, [view, node], `input ${inputs.size + 1}`)));
    if (output) outputs.set(id, mergePort(outputs.get(id), asPort(id, [view, node], `output ${outputs.size + 1}`)));
    if (isPythonNode(node)) {
      python.push({ id, name: text(view?.Name) || text(node.Name) || type, engine: text(node.Engine) || text(node.EngineName) });
      for (const label of pythonRevitRefs(pythonCode(node))) if (!pythonRefs.includes(label)) pythonRefs.push(label);
    }
  });
  asArray(graph.Inputs).forEach((item, index) => {
    const key = nodeId(item, "") || `input ${index + 1}`;
    const node = nodeById.get(key);
    inputs.set(key, mergePort(inputs.get(key), asPort(key, [item, viewById.get(key), node], text(item.Name) || `input ${index + 1}`)));
  });
  asArray(graph.Outputs).forEach((item, index) => {
    const key = nodeId(item, "") || `output ${index + 1}`;
    const node = nodeById.get(key);
    outputs.set(key, mergePort(outputs.get(key), asPort(key, [item, viewById.get(key), node], text(item.Name) || `output ${index + 1}`)));
  });
  const packages: DynPackage[] = [];
  for (const item of [...asArray(graph.NodeLibraryDependencies), ...asArray(graph.Dependencies)]) {
    const name = text(item.Name) || text(item.PackageName) || text(item.Reference);
    if (!name) continue;
    packages.push({ name, version: text(item.Version), reference: text(item.ReferenceType) || text(item.Reference) });
  }
  const revitPackages = [...new Set(packages.map((item) => item.name).filter((name) => REVIT_PACKAGE.test(name) || REVIT_TYPE.test(name)))];
  const hasRevitNodes = revitNodes || revitPackages.length > 0;
  return {
    ok: true,
    inspect: {
      file,
      name: text(graph.Name) || win.basename(file, ".dyn"),
      uuid: text(graph.Uuid) || text(graph.UUID),
      inputs: [...inputs.values()],
      outputs: [...outputs.values()],
      packages,
      nodes: { count: nodes.length, types: [...types.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)) },
      python_nodes: python,
      revit_nodes: hasRevitNodes,
      revit_packages: revitPackages,
      needs_revit: hasRevitNodes || pythonRefs.length > 0,
      python_revit_refs: pythonRefs,
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
  if (!inspect.needs_revit && !inspect.revit_nodes && inspect.revit_packages.length === 0 && inspect.python_revit_refs.length === 0) return { ok: true };
  const names = [
    inspect.revit_packages.join(", "),
    inspect.revit_nodes && inspect.revit_packages.length === 0 ? "Revit nodes" : "",
    inspect.python_revit_refs.length ? `Python ${inspect.python_revit_refs.join(", ")}` : "",
  ].filter(Boolean).join("; ");
  return {
    ok: false,
    code: "FMC-DYNAMO-NEEDS-REVIT",
    message: `[FMC-DYNAMO-NEEDS-REVIT] This graph uses Revit (${names}). Offline DynamoCLI runs only graphs with no Revit nodes and no Python that references Revit. Revit was not launched.`,
  };
}
