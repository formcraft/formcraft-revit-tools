/**
 * fmc_graph_form.spec (DT-29, Builder 7). Turns a Dynamo .dyn into a Player-style form schema: the inputs a person
 * fills, the outputs they will see, the graph's SHA-256, whether it has Python (then a person must approve every run)
 * and the packages it names. Reads the file only. It never starts Revit, Dynamo or DynamoCLI and never writes.
 *
 * A graph is read only from the kit (05_Scripts/library, 05_Scripts/Dynamo) or from the target document's drafts
 * folder <project>\00_Formcraft\Graphs (D4). The project is derived from the target document, never from the caller.
 *
 * Feeds the pane form (D6, Builder 7, later step): see GRAPH_FORM.md next to this file.
 */
import fs from "node:fs";
import { parseDyn, pathOf, scriptRoots, type DynInspect } from "../dynamo.js";
import {
  PYTHON_ALWAYS_NEEDS_PERSON, graphsDir, jailCheck, lockStatusPending, packageCheckPending, projectRootOf, sha256File, sha256Text, stableJson,
} from "./todo_builder6.js";

export const FORM_SPEC_VERSION = 1 as const;

export type FieldKind = "number" | "integer" | "boolean" | "string" | "date" | "file" | "folder" | "dropdown" | "element" | "unknown";
export type FieldWidget = "slider" | "number" | "checkbox" | "text" | "date" | "file_picker" | "folder_picker" | "dropdown" | "element_picker" | "text_unknown";

export interface FormOption { label: string; value: unknown }

export interface FormField {
  /** The node GUID. Run calls bind values to this id (Builder 6 GraphPlan.inputs_by_id). */
  id: string;
  /** The label a person sees: the node's name in the graph. Values may also be given by this name. */
  name: string;
  node_type: string;
  kind: FieldKind;
  widget: FieldWidget;
  default: unknown;
  min?: number;
  max?: number;
  step?: number;
  /** Dropdown options saved in the graph. Null when Revit fills the list at run time (options_source "revit"). */
  options?: FormOption[] | null;
  options_source?: "graph" | "revit";
  /** File picker filter or hint saved on the node, when any. */
  hint_path?: string;
  /** Needs the open Revit to fill (element selection, Revit dropdowns). The spec itself never asks Revit. */
  needs_revit: boolean;
  /** A path-like value. At run time it must stay inside the project jail (rule in section 4 of the spec). */
  path_like: boolean;
  description: string;
}

export interface FormOutput { id: string; name: string; node_type: string; kind: "watch" | "output"; type: string }

export interface FormPackage { name: string; version: string; reference_type: string; nodes: string[] }

export interface GraphFormSpec {
  action: "spec";
  v: typeof FORM_SPEC_VERSION;
  graph: { file: string; real: string; name: string; uuid: string; description: string; tier: "K" | "P"; sha256: string };
  fields: FormField[];
  outputs: FormOutput[];
  has_python: boolean;
  python_nodes: Array<{ id: string; name: string; engine: string; from_string: boolean }>;
  custom_nodes: string[];
  packages: FormPackage[];
  package_check: ReturnType<typeof packageCheckPending>;
  lock: ReturnType<typeof lockStatusPending>;
  needs_revit: boolean;
  /** What a run of this graph will need. The spec asks nothing; plan and approval are fmc_dynamo / fmc_graph_guard. */
  approval: { person_required_for: Array<"preview" | "apply" | "offline">; why: string[]; python_always_needs_person: true };
  /** sha256(stableJson({graph_sha256, fields, outputs})): the pane can cache a form by it. */
  spec_hash: string;
  warnings: string[];
}

export type SpecResult = { ok: true; spec: GraphFormSpec } | { ok: false; code: string; message: string };

type Obj = Record<string, unknown>;

function asArray(value: unknown): Obj[] {
  return Array.isArray(value) ? value.filter((item): item is Obj => !!item && typeof item === "object" && !Array.isArray(item)) : [];
}
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}
function concrete(node: Obj): string { return (text(node.ConcreteType).split(",")[0] ?? "").trim(); }
function shortOf(full: string): string { const parts = full.split("."); return parts[parts.length - 1] || full; }
function idOf(node: Obj): string { return text(node.Id) || text(node.ID); }

const PATHY = /^(?:[A-Za-z]:[\\/]|[\\/]{2}|\.{1,2}[\\/])|[\\/][^\\/]+\.[A-Za-z0-9]{1,8}$/;
const ELEMENT_SELECTION = /(ModelElementSelection|ModelElementsSelection|ElementSelection|FaceSelection|EdgeSelection|PointOnElementSelection|UvOnElementSelection|ReferenceSelection|SelectionBase)$/i;
const REVIT_UI = /^(DSRevitNodesUI|Dynamo\.Nodes\.DS|Revit)/;
const PYTHON_STRING = /PythonStringNode$/;
const PYTHON_NODE = /PythonNode$|PythonScriptNode|PythonNodeModels/i;
const WATCH = /(^|\.)Watch(3D|Image)?$/;

function playerType(entry: Obj | undefined): string { return text(entry?.Type).toLowerCase(); }

function fieldFor(node: Obj, view: Obj | undefined, entry: Obj | undefined): FormField {
  const full = concrete(node);
  const type = shortOf(full) || text(node.NodeType) || "Node";
  const id = idOf(node) || idOf(entry ?? {});
  const name = text(view?.Name) || text(entry?.Name) || text(node.Name) || type;
  const description = text(entry?.Description) || text(node.Description);
  const saved = node.InputValue !== undefined ? node.InputValue : entry?.Value;
  const base = { id, name, node_type: type, default: saved ?? null, needs_revit: false, path_like: false, description };
  const range = (src: Obj) => ({
    min: num(src.MinimumValue) ?? num(entry?.MinimumValue),
    max: num(src.MaximumValue) ?? num(entry?.MaximumValue),
    step: num(src.StepValue) ?? num(entry?.StepValue),
  });
  if (/IntegerSlider(64Bit)?$/.test(full)) return { ...base, kind: "integer", widget: "slider", default: num(saved) ?? null, ...range(node) };
  if (/DoubleSlider$/.test(full)) return { ...base, kind: "number", widget: "slider", default: num(saved) ?? null, ...range(node) };
  if (/DoubleInput$|IntegerInput$/.test(full)) return { ...base, kind: /Integer/.test(full) ? "integer" : "number", widget: "number", default: num(saved) ?? saved ?? null };
  if (/BoolSelector$/.test(full)) return { ...base, kind: "boolean", widget: "checkbox", default: typeof saved === "boolean" ? saved : saved === "true" ? true : saved === "false" ? false : null };
  if (/\.Filename$|FileObject$/.test(full) || (full === "" && playerType(entry) === "file")) {
    return { ...base, kind: "file", widget: "file_picker", path_like: true, ...(text(node.HintPath) ? { hint_path: text(node.HintPath) } : {}) };
  }
  if (/\.Directory$|DirectoryObject$/.test(full)) return { ...base, kind: "folder", widget: "folder_picker", path_like: true };
  if (/DateTime$/.test(full)) return { ...base, kind: "date", widget: "date" };
  if (/CustomSelection$/.test(full)) {
    const options = asArray(node.Items).map((item) => ({ label: text(item.Name) || String(item.Value ?? ""), value: item.Value ?? null }));
    const index = num(node.SelectedIndex);
    return { ...base, kind: "dropdown", widget: "dropdown", options, options_source: "graph", default: index !== undefined && options[index] ? options[index].value : null };
  }
  if (ELEMENT_SELECTION.test(full)) {
    const picked = Array.isArray(node.InstanceId) ? node.InstanceId : [];
    return { ...base, kind: "element", widget: "element_picker", needs_revit: true, default: picked.length ? picked : null };
  }
  if (REVIT_UI.test(full) && (node.SelectedIndex !== undefined || node.SelectedString !== undefined || /DropDown|Categories|Levels|FamilyTypes|ElementTypes|Views|Phases|WallTypes|FloorTypes/i.test(full))) {
    return { ...base, kind: "dropdown", widget: "dropdown", options: null, options_source: "revit", needs_revit: true, default: text(node.SelectedString) || null };
  }
  if (/StringInput$/.test(full) || playerType(entry) === "string") {
    const value = typeof saved === "string" ? saved : saved ?? null;
    return { ...base, kind: "string", widget: "text", default: value, path_like: typeof value === "string" && PATHY.test(value.trim()) };
  }
  const pt = playerType(entry);
  if (pt === "number") return { ...base, kind: text(entry?.NumberType) === "Integer" ? "integer" : "number", widget: entry?.MaximumValue !== undefined ? "slider" : "number", ...range({}) };
  if (pt === "boolean") return { ...base, kind: "boolean", widget: "checkbox" };
  if (pt === "selection" || pt === "hostselection") return { ...base, kind: "element", widget: "element_picker", needs_revit: true };
  if (pt === "dropdownselection" || pt === "dropselection") return { ...base, kind: "dropdown", widget: "dropdown", options: null, options_source: "revit", needs_revit: true };
  return { ...base, kind: "unknown", widget: "text_unknown" };
}

/** Builds the form from parsed JSON. Exported for tests; graphFormSpec is the entry point. */
export function formFromGraph(graph: Obj): { fields: FormField[]; outputs: FormOutput[]; python: GraphFormSpec["python_nodes"]; custom_nodes: string[]; packages: FormPackage[]; warnings: string[] } {
  const nodes = asArray(graph.Nodes);
  const view = graph.View && typeof graph.View === "object" ? graph.View as Obj : {};
  const views = new Map(asArray(view.NodeViews).map((item) => [idOf(item), item]));
  const inputsTop = new Map(asArray(graph.Inputs).map((item) => [idOf(item), item]));
  const outputsTop = new Map(asArray(graph.Outputs).map((item) => [idOf(item), item]));
  const fields: FormField[] = [];
  const outputs: FormOutput[] = [];
  const python: GraphFormSpec["python_nodes"] = [];
  const custom = new Set<string>();
  const warnings: string[] = [];
  for (const node of nodes) {
    const id = idOf(node);
    const v = views.get(id);
    const full = concrete(node);
    const isInput = node.IsSetAsInput === true || v?.IsSetAsInput === true || inputsTop.has(id);
    const isOutput = node.IsSetAsOutput === true || v?.IsSetAsOutput === true || outputsTop.has(id);
    if (isInput) fields.push(fieldFor(node, v, inputsTop.get(id)));
    if (isOutput || WATCH.test(full)) {
      const top = outputsTop.get(id);
      outputs.push({ id, name: text(v?.Name) || text(top?.Name) || text(node.Name) || shortOf(full), node_type: shortOf(full) || text(node.NodeType), kind: WATCH.test(full) ? "watch" : "output", type: text(top?.Type) });
    }
    if (PYTHON_NODE.test(full) || PYTHON_NODE.test(text(node.NodeType))) {
      python.push({ id, name: text(v?.Name) || shortOf(full), engine: text(node.Engine) || text(node.EngineName), from_string: PYTHON_STRING.test(full) });
    }
    if (text(node.NodeType) === "FunctionNode" && /^[0-9a-f-]{32,36}$/i.test(text(node.FunctionSignature))) custom.add(text(node.FunctionSignature));
  }
  // A Player input listed at the top with no node behind it is still shown, so nothing is dropped silently.
  for (const [id, entry] of inputsTop) {
    if (fields.some((field) => field.id === id)) continue;
    fields.push(fieldFor({}, undefined, entry));
    warnings.push(`Input ${text(entry.Name) || id} is listed in Inputs but has no node in the graph.`);
  }
  const names = new Map<string, number>();
  for (const field of fields) names.set(field.name.toLowerCase(), (names.get(field.name.toLowerCase()) ?? 0) + 1);
  for (const [name, count] of names) if (count > 1) warnings.push(`${count} inputs share the name "${name}"; give values by id for them.`);
  const packages = asArray(graph.NodeLibraryDependencies).map((item) => ({
    name: text(item.Name), version: text(item.Version), reference_type: text(item.ReferenceType),
    nodes: Array.isArray(item.Nodes) ? item.Nodes.map(String) : [],
  })).filter((item) => item.name);
  for (const pkg of packages) if (/^DYF/i.test(pkg.reference_type)) custom.add(pkg.name);
  return { fields, outputs, python, custom_nodes: [...custom], packages, warnings };
}

export interface SpecArgs {
  /** The .dyn to read. */
  file: string;
  /** Kit root (kitRootFrom). */
  kit: string;
  /** Full path of the target document, from the server's document resolution. "" when none: drafts are refused. */
  documentPath: string;
}

const MAX_GRAPH_BYTES = 20 * 1024 * 1024;

/** Which jail root a path claims: a kit script folder, or the project drafts folder. */
function claimedRoot(file: string, kit: string, documentPath: string): { root: string; tier: "K" | "P" } | null {
  const p = pathOf(file);
  const lower = (s: string) => (p.sep === "\\" ? s.toLowerCase() : s);
  const norm = lower(p.normalize(file));
  const under = (root: string) => { const r = lower(p.normalize(root)).replace(/[\\/]+$/, ""); return norm.startsWith(r + p.sep); };
  if (kit.trim()) for (const root of scriptRoots(kit)) if (under(root)) return { root, tier: "K" };
  const project = projectRootOf(documentPath);
  if (project && under(graphsDir(project))) return { root: graphsDir(project), tier: "P" };
  return null;
}

export function graphFormSpec(args: SpecArgs): SpecResult {
  const file = (args.file ?? "").trim();
  if (!file) return { ok: false, code: "FMC-GRAPH-FORM-ARGS", message: "[FMC-GRAPH-FORM-ARGS] spec needs path, the .dyn file." };
  if (!/\.dyn$/i.test(file)) return { ok: false, code: "FMC-GRAPH-NOT-GRAPH", message: `[FMC-GRAPH-NOT-GRAPH] ${file} is not a Dynamo graph (.dyn). Custom nodes (.dyf) and scripts are not forms.` };
  const claimed = claimedRoot(file, args.kit ?? "", args.documentPath ?? "");
  const project = projectRootOf(args.documentPath ?? "");
  const jailWhere = [
    ...(args.kit?.trim() ? scriptRoots(args.kit) : []),
    project ? graphsDir(project) : "<project>\\00_Formcraft\\Graphs (name the target document by full path)",
  ].join(" or ");
  // A ".." or UNC path is refused by jailCheck even when its text seems to sit under a root.
  const check = jailCheck(file, claimed?.root ?? "");
  if (!check.ok) {
    // Path-shape refusals (UNC, "..", relative) speak for themselves; anything else outside every root names the roots.
    const shape = /UNC|"\.\."|absolute local path/.test(check.message);
    if (claimed || shape) return { ok: false, code: check.code, message: check.message };
    return { ok: false, code: check.code, message: `[FMC-GRAPH-JAIL] ${file} is outside the graph folders (${jailWhere}).` };
  }
  let raw: Buffer;
  try {
    const stat = fs.statSync(check.real);
    if (!stat.isFile()) return { ok: false, code: "FMC-GRAPH-NOT-GRAPH", message: `[FMC-GRAPH-NOT-GRAPH] ${file} is not a file.` };
    if (stat.size > MAX_GRAPH_BYTES) return { ok: false, code: "FMC-GRAPH-NOT-GRAPH", message: `[FMC-GRAPH-NOT-GRAPH] ${file} is ${stat.size} bytes; the limit is ${MAX_GRAPH_BYTES}.` };
    raw = fs.readFileSync(check.real);
  } catch (error) {
    return { ok: false, code: "FMC-GRAPH-READ", message: `[FMC-GRAPH-READ] Can't read ${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const body = raw.toString("utf8");
  let graph: Obj;
  try {
    const parsed = JSON.parse(body.replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.Nodes)) throw new Error("no Nodes list");
    graph = parsed as Obj;
  } catch (error) {
    return { ok: false, code: "FMC-GRAPH-NOT-GRAPH", message: `[FMC-GRAPH-NOT-GRAPH] ${file} is not Dynamo JSON (${error instanceof Error ? error.message : String(error)}). Dynamo 1.x XML graphs are not read.` };
  }
  if (graph.IsCustomNode === true) return { ok: false, code: "FMC-GRAPH-NOT-GRAPH", message: `[FMC-GRAPH-NOT-GRAPH] ${file} is a custom node, not a graph.` };
  const inspected = parseDyn(file, body);
  const inspect: DynInspect | null = inspected.ok ? inspected.inspect : null;
  const form = formFromGraph(graph);
  const sha256 = sha256File(check.real);
  const hasPython = form.python.length > 0;
  const why: string[] = [];
  if (hasPython) why.push(`Python: ${form.python.length} node(s)${form.python.some((item) => item.from_string) ? ", including Python-from-string" : ""}. A person approves every run, every mode (hard rule).`);
  why.push("Every apply needs a person's approval bound to plan_hash (D12).", "Every offline (DynamoCLI) run needs a person's approval.");
  if (form.custom_nodes.length) form.warnings.push(`Custom nodes (${form.custom_nodes.length}) are not opened here; Python inside them is found by fmc_graph_guard.scan.`);
  if (form.packages.length) form.warnings.push("Packages may ship DLLs; that counts as Python for approval. Checked by fmc_graph_guard.packages (Builder 6).");
  const needsRevit = form.fields.some((field) => field.needs_revit) || inspect?.needs_revit === true;
  const fields = form.fields;
  const outputs = form.outputs;
  const spec: GraphFormSpec = {
    action: "spec",
    v: FORM_SPEC_VERSION,
    graph: {
      file, real: check.real, name: text(graph.Name) || pathOf(file).basename(file, ".dyn"), uuid: text(graph.Uuid),
      description: text(graph.Description), tier: claimed?.tier ?? "K", sha256,
    },
    fields, outputs,
    has_python: hasPython,
    python_nodes: form.python,
    custom_nodes: form.custom_nodes,
    packages: form.packages,
    package_check: packageCheckPending(),
    lock: lockStatusPending(),
    needs_revit: needsRevit,
    approval: {
      person_required_for: hasPython ? ["preview", "apply", "offline"] : ["apply", "offline"],
      why,
      python_always_needs_person: PYTHON_ALWAYS_NEEDS_PERSON,
    },
    spec_hash: sha256Text(stableJson({ graph_sha256: sha256, fields, outputs })),
    warnings: form.warnings,
  };
  return { ok: true, spec };
}

export type BindResult =
  | { ok: true; inputs_by_id: Record<string, unknown> }
  | { ok: false; code: "FMC-GRAPH-FORM-INPUT"; message: string; unknown: string[]; ambiguous: string[]; invalid: string[] };

/**
 * Binds form values given by field name (case-insensitive) or by node id to node ids, and checks them against the
 * field (type, slider range, dropdown options). Unknown or ambiguous names are refused, never dropped (R-1).
 * The result is the inputs_by_id shape of Builder 6's GraphPlan.
 */
export function bindFormValues(spec: Pick<GraphFormSpec, "fields">, values: Record<string, unknown>): BindResult {
  const out: Record<string, unknown> = {};
  const unknown: string[] = [];
  const ambiguous: string[] = [];
  const invalid: string[] = [];
  for (const [key, value] of Object.entries(values ?? {})) {
    const byId = spec.fields.filter((field) => field.id === key);
    const byName = spec.fields.filter((field) => field.name.toLowerCase() === key.trim().toLowerCase());
    const hits = byId.length ? byId : byName;
    if (hits.length === 0) { unknown.push(key); continue; }
    if (hits.length > 1) { ambiguous.push(key); continue; }
    const field = hits[0];
    const problem = valueProblem(field, value);
    if (problem) { invalid.push(`${key}: ${problem}`); continue; }
    out[field.id] = value;
  }
  if (unknown.length || ambiguous.length || invalid.length) {
    const parts = [
      unknown.length ? `unknown input(s) ${unknown.join(", ")}` : "",
      ambiguous.length ? `name(s) shared by more than one input ${ambiguous.join(", ")} (give the id)` : "",
      invalid.length ? `invalid value(s): ${invalid.join("; ")}` : "",
    ].filter(Boolean).join("; ");
    return { ok: false, code: "FMC-GRAPH-FORM-INPUT", message: `[FMC-GRAPH-FORM-INPUT] ${parts}. Inputs: ${spec.fields.map((f) => f.name).join(", ")}.`, unknown, ambiguous, invalid };
  }
  return { ok: true, inputs_by_id: out };
}

function valueProblem(field: FormField, value: unknown): string {
  switch (field.kind) {
    case "number":
    case "integer": {
      const n = num(value);
      if (n === undefined) return "not a number";
      if (field.kind === "integer" && !Number.isInteger(n)) return "not a whole number";
      if (field.min !== undefined && n < field.min) return `below ${field.min}`;
      if (field.max !== undefined && n > field.max) return `above ${field.max}`;
      return "";
    }
    case "boolean": return typeof value === "boolean" ? "" : "not true or false";
    case "string": case "file": case "folder": case "date": return typeof value === "string" ? "" : "not text";
    case "dropdown":
      if (field.options && !field.options.some((option) => option.value === value || option.label === value)) return "not one of the options";
      return "";
    default: return "";
  }
}
