/**
 * fmc_graph core (DT-01 scaffold, DT-02 generate, DT-03 validate) and the fmc_dynamo author op.
 * Graphs are compiled from a JSON spec (nodes, wires, inputs, outputs, packages); there is no free-text graph.
 * Drafts are written only in the project's drafts folder (<project>\00_Formcraft\Graphs\drafts) and never overwrite.
 */
import fs from "node:fs";
import { pathOf, parseDyn } from "../dynamo.js";
import { sha256Text, stableJson } from "./hash.js";
import { graphsDir, jailCheck } from "./jail.js";
import { scanGraphText, type GraphScan } from "./scan.js";
import { checkPackages, installedPackages, type PackageCheck } from "./packages.js";

export type NodeKind = "number" | "string" | "boolean" | "watch" | "code_block" | "function" | "python";

export interface SpecNode {
  key: string;
  kind: NodeKind;
  name?: string;
  value?: unknown;
  code?: string;
  /** function: the Zero-Touch signature, e.g. "DSCore.Math.Sum@double[]" */
  function?: string;
  inputs?: string[];
  outputs?: string[];
  is_input?: boolean;
  is_output?: boolean;
  engine?: string;
}

export interface GraphSpec {
  name: string;
  description?: string;
  nodes: SpecNode[];
  /** "fromKey" or "fromKey:outIndex" to "toKey:inIndex" */
  wires: Array<{ from: string; to: string }>;
  packages?: Array<{ name: string; version?: string }>;
}

export interface Validation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  nodes: number;
  wires: number;
  inputs: string[];
  outputs: string[];
  needs_revit: boolean;
  python: boolean;
  scan: Pick<GraphScan, "scan_hash" | "counts" | "findings" | "python">;
  packages?: PackageCheck;
}

const MAX_NODES = 500;
const MAX_BYTES = 5 * 1024 * 1024;

const TYPES: Record<NodeKind, { concrete: string; nodeType: string; ins: number; outs: number }> = {
  number: { concrete: "CoreNodeModels.Input.DoubleInput, CoreNodeModels", nodeType: "NumberInputNode", ins: 0, outs: 1 },
  string: { concrete: "CoreNodeModels.Input.StringInput, CoreNodeModels", nodeType: "StringInputNode", ins: 0, outs: 1 },
  boolean: { concrete: "CoreNodeModels.Input.BoolSelector, CoreNodeModels", nodeType: "BooleanInputNode", ins: 0, outs: 1 },
  watch: { concrete: "CoreNodeModels.Watch, CoreNodeModels", nodeType: "ExtensionNode", ins: 1, outs: 1 },
  code_block: { concrete: "Dynamo.Graph.Nodes.CodeBlockNodeModel, DynamoCore", nodeType: "CodeBlockNode", ins: 0, outs: 1 },
  function: { concrete: "Dynamo.Graph.Nodes.ZeroTouch.DSFunction, DynamoCore", nodeType: "FunctionNode", ins: 0, outs: 1 },
  python: { concrete: "PythonNodeModels.PythonNode, PythonNodeModels", nodeType: "PythonScriptNode", ins: 1, outs: 1 },
};

const KNOWN_CONCRETE = new Set(Object.values(TYPES).map((t) => t.concrete.split(",")[0].trim()));

/** A stable GUID from text, so the same spec gives the same ids. */
function guid(seed: string): string {
  const h = sha256Text(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function hexId(seed: string): string {
  return sha256Text(seed).slice(0, 32);
}

export function specProblems(spec: GraphSpec): string[] {
  const out: string[] = [];
  if (!spec || typeof spec !== "object") return ["spec must be an object"];
  if (typeof spec.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,80}$/.test(spec.name) || spec.name.includes("..")) out.push("name: letters, digits, space, '_', '-', '.' (1-80)");
  if (!Array.isArray(spec.nodes) || spec.nodes.length === 0) out.push("nodes: at least one node");
  if (Array.isArray(spec.nodes) && spec.nodes.length > MAX_NODES) out.push(`nodes: at most ${MAX_NODES}`);
  const keys = new Set<string>();
  for (const n of spec.nodes ?? []) {
    if (!n || typeof n.key !== "string" || !/^[A-Za-z0-9_]{1,40}$/.test(n.key)) { out.push(`node key ${JSON.stringify(n?.key)}: letters, digits, '_'`); continue; }
    if (keys.has(n.key)) out.push(`node ${n.key}: duplicate key`);
    keys.add(n.key);
    if (!(n.kind in TYPES)) out.push(`node ${n.key}: unknown kind ${JSON.stringify(n.kind)} (number, string, boolean, watch, code_block, function, python)`);
    if (n.kind === "function" && (typeof n.function !== "string" || !n.function.trim())) out.push(`node ${n.key}: function needs its signature`);
    if ((n.kind === "code_block" || n.kind === "python") && typeof n.code !== "string") out.push(`node ${n.key}: ${n.kind} needs code`);
  }
  for (const w of spec.wires ?? []) {
    const [fk] = String(w?.from ?? "").split(":");
    const [tk] = String(w?.to ?? "").split(":");
    if (!keys.has(fk)) out.push(`wire from ${w?.from}: no such node`);
    if (!keys.has(tk)) out.push(`wire to ${w?.to}: no such node`);
  }
  return out;
}

/** Compile a spec to Dynamo 2.x/3.x JSON (.dyn). Pure. */
export function generateGraph(spec: GraphSpec): { ok: true; json: Record<string, unknown>; text: string } | { ok: false; problems: string[] } {
  const problems = specProblems(spec);
  if (problems.length) return { ok: false, problems };
  const seed = sha256Text(stableJson(spec));
  const ports = new Map<string, { ins: string[]; outs: string[] }>();
  const nodes: Record<string, unknown>[] = [];
  const views: Record<string, unknown>[] = [];
  const inputs: Record<string, unknown>[] = [];
  const outputs: Record<string, unknown>[] = [];
  spec.nodes.forEach((n, index) => {
    const t = TYPES[n.kind];
    const id = hexId(`${seed}:${n.key}`);
    const insNames = n.inputs ?? Array.from({ length: t.ins }, (_, i) => (n.kind === "python" ? `IN[${i}]` : n.kind === "watch" ? "" : `in${i}`));
    const outsNames = n.outputs ?? Array.from({ length: t.outs }, () => "");
    const ins = insNames.map((_, i) => hexId(`${seed}:${n.key}:in:${i}`));
    const outs = outsNames.map((_, i) => hexId(`${seed}:${n.key}:out:${i}`));
    ports.set(n.key, { ins, outs });
    const port = (pid: string, name: string) => ({ Id: pid, Name: name, Description: name, UsingDefaultValue: false, Level: 2, UseLevels: false, KeepListStructure: false });
    const node: Record<string, unknown> = {
      ConcreteType: t.concrete, NodeType: t.nodeType, Id: id,
      Inputs: ins.map((pid, i) => port(pid, insNames[i])), Outputs: outs.map((pid, i) => port(pid, outsNames[i])),
      Replication: "Disabled", Description: n.name ?? n.kind,
    };
    if (n.kind === "number") { node.NumberType = "Double"; node.InputValue = typeof n.value === "number" ? n.value : 0; }
    if (n.kind === "string") node.InputValue = typeof n.value === "string" ? n.value : String(n.value ?? "");
    if (n.kind === "boolean") node.InputValue = n.value === true;
    if (n.kind === "code_block") node.Code = n.code ?? "";
    if (n.kind === "function") { node.FunctionSignature = n.function; node.Replication = "Auto"; }
    if (n.kind === "python") { node.Code = n.code ?? ""; node.Engine = n.engine ?? "PythonNet3"; node.VariableInputPorts = true; }
    nodes.push(node);
    const isInput = n.is_input === true && ["number", "string", "boolean"].includes(n.kind);
    const isOutput = n.is_output === true || n.kind === "watch";
    views.push({ Id: id, Name: n.name ?? n.key, IsSetAsInput: isInput, IsSetAsOutput: isOutput, Excluded: false, ShowGeometry: true, X: 250 * (index % 6), Y: 150 * Math.floor(index / 6) });
    if (isInput) inputs.push({ Id: id, Name: n.name ?? n.key, Type: n.kind, Value: String(node.InputValue ?? ""), Description: n.name ?? n.key });
    if (isOutput) outputs.push({ Id: id, Name: n.name ?? n.key, Type: "unknown", InitialValue: "", Description: n.name ?? n.key });
  });
  const connectors = (spec.wires ?? []).map((w, i) => {
    const [fk, fi] = w.from.split(":");
    const [tk, ti] = w.to.split(":");
    const start = ports.get(fk)?.outs[Number(fi ?? 0)] ?? "";
    const end = ports.get(tk)?.ins[Number(ti ?? 0)] ?? "";
    return { Start: start, End: end, Id: hexId(`${seed}:wire:${i}`), IsHidden: "False" };
  });
  const bad = connectors.filter((c) => !c.Start || !c.End);
  if (bad.length) return { ok: false, problems: [`${bad.length} wire(s) name a port the node does not have`] };
  const deps = (spec.packages ?? []).map((p) => ({ Name: p.name, Version: p.version ?? "", ReferenceType: "Package", Nodes: [] as string[] }));
  const json: Record<string, unknown> = {
    Uuid: guid(`${seed}:graph`), IsCustomNode: false, Description: spec.description ?? "", Name: spec.name,
    ElementResolver: { ResolutionMap: {} }, Inputs: inputs, Outputs: outputs, Nodes: nodes, Connectors: connectors,
    Dependencies: [], NodeLibraryDependencies: deps, Thumbnail: "", GraphDocumentationURL: null, ExtensionWorkspaceData: [],
    Author: "Formcraft fmc_graph", Linting: { activeLinter: "None", activeLinterId: "", warningCount: 0, errorCount: 0 },
    Bindings: [],
    View: {
      Dynamo: { ScaleFactor: 1.0, HasRunWithoutCrash: false, IsVisibleInDynamoLibrary: true, Version: "3.3.0", RunType: "Manual", RunPeriod: "1000" },
      Camera: { Name: "_Background Preview", EyeX: -17, EyeY: 24, EyeZ: 50, LookX: 12, LookY: -13, LookZ: -58, UpX: 0, UpY: 1, UpZ: 0 },
      ConnectorPins: [], NodeViews: views, Annotations: [], X: 0, Y: 0, Zoom: 1,
    },
    FormcraftSpec: { v: 1, spec_sha256: seed },
  };
  return { ok: true, json, text: JSON.stringify(json, null, 2) };
}

/** Named templates (DT-01): inputs and outputs already marked. */
export const TEMPLATES: Record<string, (name: string) => GraphSpec> = {
  read_only_report: (name) => ({
    name, description: "Read-only report: inputs marked, one output. Reads, never writes.",
    nodes: [
      { key: "category", kind: "string", name: "Category", value: "OST_Rooms", is_input: true },
      { key: "label", kind: "code_block", name: "Label", code: "x + \" report\";", inputs: ["x"] },
      { key: "out", kind: "watch", name: "Report" },
    ],
    wires: [{ from: "category", to: "label:0" }, { from: "label", to: "out:0" }],
  }),
  family_edit: (name) => ({
    name, description: "Family edit: parameter name and value marked as inputs; result as output.",
    nodes: [
      { key: "param", kind: "string", name: "Parameter name", value: "", is_input: true },
      { key: "value", kind: "string", name: "Value", value: "", is_input: true },
      { key: "pair", kind: "code_block", name: "Pair", code: "[p, v];", inputs: ["p", "v"] },
      { key: "out", kind: "watch", name: "Result" },
    ],
    wires: [{ from: "param", to: "pair:0" }, { from: "value", to: "pair:1" }, { from: "pair", to: "out:0" }],
  }),
  mep_check: (name) => ({
    name, description: "MEP check: tolerance and system marked as inputs; findings as output. Read-only.",
    nodes: [
      { key: "system", kind: "string", name: "System", value: "Sanitary", is_input: true },
      { key: "min_slope", kind: "number", name: "Min slope %", value: 1, is_input: true },
      { key: "check", kind: "code_block", name: "Check", code: "[s, m];", inputs: ["s", "m"] },
      { key: "out", kind: "watch", name: "Findings" },
    ],
    wires: [{ from: "system", to: "check:0" }, { from: "min_slope", to: "check:1" }, { from: "check", to: "out:0" }],
  }),
  sweep_ready: (name) => ({
    name, description: "Sweep-ready: numeric inputs marked with defaults; one numeric output to rank.",
    nodes: [
      { key: "a", kind: "number", name: "A", value: 1, is_input: true },
      { key: "b", kind: "number", name: "B", value: 1, is_input: true },
      { key: "score", kind: "code_block", name: "Score", code: "a * b;", inputs: ["a", "b"] },
      { key: "out", kind: "watch", name: "Score" },
    ],
    wires: [{ from: "a", to: "score:0" }, { from: "b", to: "score:1" }, { from: "score", to: "out:0" }],
  }),
};

export function scaffoldGraph(template: string, name: string): ReturnType<typeof generateGraph> {
  const make = TEMPLATES[template];
  if (!make) return { ok: false, problems: [`unknown template ${JSON.stringify(template)} (${Object.keys(TEMPLATES).join(", ")})`] };
  return generateGraph(make(name));
}

/** Check a draft (DT-03): schema, wires, marked inputs and outputs, known nodes, packages, Revit needed or not, size, scan. */
export function validateGraphText(file: string, text: string, packageDirs?: string[]): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const emptyScan = { scan_hash: "", counts: { high: 0, medium: 0, info: 0 }, findings: [], python: false };
  if (Buffer.byteLength(text) > MAX_BYTES) errors.push(`file is larger than ${MAX_BYTES} bytes`);
  const parsed = parseDyn(file, text);
  if (!parsed.ok) return { ok: false, errors: [parsed.message, ...errors], warnings, nodes: 0, wires: 0, inputs: [], outputs: [], needs_revit: false, python: false, scan: emptyScan };
  const body = JSON.parse(text.replace(/^\uFEFF/, "")) as Record<string, unknown>;
  for (const key of ["Uuid", "Nodes", "Connectors", "View"]) if (!(key in body)) errors.push(`missing ${key}`);
  const nodes = Array.isArray(body.Nodes) ? (body.Nodes as Record<string, unknown>[]) : [];
  const conns = Array.isArray(body.Connectors) ? (body.Connectors as Record<string, unknown>[]) : [];
  if (nodes.length > MAX_NODES) errors.push(`${nodes.length} nodes; the limit is ${MAX_NODES}`);
  const inPorts = new Map<string, string>();
  const outPorts = new Map<string, string>();
  for (const n of nodes) {
    const id = String(n.Id ?? "");
    for (const p of (Array.isArray(n.Inputs) ? n.Inputs : []) as Record<string, unknown>[]) inPorts.set(String(p.Id), id);
    for (const p of (Array.isArray(n.Outputs) ? n.Outputs : []) as Record<string, unknown>[]) outPorts.set(String(p.Id), id);
    const concrete = String(n.ConcreteType ?? "").split(",")[0].trim();
    if (!KNOWN_CONCRETE.has(concrete) && !/^(CoreNodeModels|DSRevitNodesUI|Dynamo\.Graph\.Nodes|PythonNodeModels|DSCoreNodesUI|Dynamo\.Nodes)\b/.test(concrete)) {
      warnings.push(`node ${id}: unknown node type ${concrete || "(none)"}`);
    }
  }
  const wiredIn = new Set<string>();
  for (const c of conns) {
    const s = String(c.Start ?? "");
    const e = String(c.End ?? "");
    if (!outPorts.has(s)) errors.push(`wire ${c.Id}: start port ${s} is not an output of any node`);
    if (!inPorts.has(e)) errors.push(`wire ${c.Id}: end port ${e} is not an input of any node`);
    wiredIn.add(e);
  }
  for (const n of nodes) {
    const ins = (Array.isArray(n.Inputs) ? n.Inputs : []) as Record<string, unknown>[];
    const loose = ins.filter((p) => !wiredIn.has(String(p.Id)) && p.UsingDefaultValue !== true);
    if (loose.length && ins.length) warnings.push(`node ${n.Id}: ${loose.length} input port(s) not wired`);
  }
  const i = parsed.inspect;
  const inputTypes = nodes.filter((n) => /Input\.|BoolSelector|NumberInputNode|StringInputNode/.test(String(n.ConcreteType ?? "") + String(n.NodeType ?? "")));
  const marked = new Set(i.inputs.map((p) => p.id));
  for (const n of inputTypes) if (!marked.has(String(n.Id))) warnings.push(`node ${n.Id}: an input node not marked as input (callers cannot set it)`);
  if (i.inputs.length === 0) warnings.push("no marked inputs");
  if (i.outputs.length === 0) warnings.push("no marked outputs or Watch nodes: the run returns nothing");
  const scan = scanGraphText(file, text);
  let packages: PackageCheck | undefined;
  if (packageDirs) {
    packages = checkPackages(i, installedPackages(packageDirs), packageDirs, undefined, [], false);
    for (const m of packages.missing) warnings.push(`package ${m} is not installed`);
    for (const m of packages.older) warnings.push(`package ${m} is older than the graph needs`);
  }
  if (scan.python) warnings.push("graph has Python: every run needs a person's approval");
  return {
    ok: errors.length === 0, errors, warnings, nodes: nodes.length, wires: conns.length,
    inputs: i.inputs.map((p) => p.name), outputs: i.outputs.map((p) => p.name),
    needs_revit: i.needs_revit || i.revit_nodes, python: scan.python,
    scan: { scan_hash: scan.scan_hash, counts: scan.counts, findings: scan.findings, python: scan.python }, packages,
  };
}

/** Write a draft into <project>\00_Formcraft\Graphs\drafts\<name>.dyn; an existing name gets -2, -3 … (never overwrites). */
export function writeDraft(projectRoot: string, name: string, text: string, draftsFolder?: string): { ok: true; file: string } | { ok: false; code: string; message: string } {
  if (!projectRoot) return { ok: false, code: "FMC-GRAPH-JAIL", message: "[FMC-GRAPH-JAIL] The target model is not in a project's 01_WIP, so there is no drafts folder. Name a project model with document." };
  const dir = pathOf(projectRoot).join(graphsDir(projectRoot, draftsFolder), "drafts");
  const safe = name.replace(/[^A-Za-z0-9 _.-]/g, "_").replace(/\.+/g, ".").replace(/^\.|\.$/g, "") || "graph";
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; n < 1000; n++) {
    const file = pathOf(dir).join(dir, n === 1 ? `${safe}.dyn` : `${safe}-${n}.dyn`);
    const jail = jailCheck(file, projectRoot);
    if (!jail.ok) return jail;
    try { fs.writeFileSync(file, text, { flag: "wx" }); return { ok: true, file }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  return { ok: false, code: "FMC-GRAPH-NAME", message: `[FMC-GRAPH-NAME] Too many drafts named ${safe}.` };
}
