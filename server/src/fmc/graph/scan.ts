/**
 * fmc_graph_guard.scan (DT-55): a static scan of everything in a graph that can do more than a Dynamo node should:
 * Python nodes, Python-from-string nodes, custom nodes, file-writing nodes and (with the package check) package DLLs.
 * Reads the .dyn only; runs nothing. The scan_hash binds an approval to exactly these findings.
 */
import fs from "node:fs";
import { sha256Text, stableJson } from "./hash.js";

export const SCAN_RULES_VERSION = "1";

export type Severity = "high" | "medium" | "info";

export interface Finding {
  node_id: string;
  node_name: string;
  kind: "python" | "python_from_string" | "custom_node" | "file_io" | "package_dll" | "code_block";
  rule: string;
  severity: Severity;
  line?: number;
  text?: string;
}

export interface GraphScan {
  ok: boolean;
  file: string;
  graph_sha256: string;
  python: boolean;
  python_nodes: Array<{ id: string; name: string; engine: string; lines: number }>;
  python_from_string: string[];
  custom_nodes: Array<{ id: string; name: string; function_id: string }>;
  findings: Finding[];
  counts: Record<Severity, number>;
  rules_version: string;
  scan_hash: string;
  message?: string;
}

const PY_RULES: Array<{ rule: string; re: RegExp; severity: Severity }> = [
  { rule: "import os", re: /^\s*(import\s+os\b|from\s+os(\.|\s+import)\b)/, severity: "high" },
  { rule: "import subprocess", re: /\bsubprocess\b/, severity: "high" },
  { rule: "import socket", re: /^\s*(import|from)\s+socket\b/, severity: "high" },
  { rule: "import shutil", re: /^\s*(import|from)\s+shutil\b/, severity: "high" },
  { rule: "import ctypes", re: /^\s*(import|from)\s+ctypes\b/, severity: "high" },
  { rule: "import urllib/http/requests", re: /^\s*(import|from)\s+(urllib\d?|http|requests|ftplib|smtplib|httplib)\b/, severity: "high" },
  { rule: "import importlib", re: /\bimportlib\b|\b__import__\s*\(/, severity: "high" },
  { rule: "import pickle/marshal", re: /^\s*(import|from)\s+(c?pickle|marshal|shelve)\b/, severity: "high" },
  { rule: "import winreg", re: /^\s*(import|from)\s+_?winreg\b/, severity: "high" },
  { rule: "eval/exec/compile", re: /(^|[^.\w])(eval|exec|compile|execfile)\s*\(/, severity: "high" },
  { rule: "open() for writing", re: /\bopen\s*\([^)]*,\s*['"][^'"]*[wax+][^'"]*['"]/, severity: "high" },
  { rule: "System.IO", re: /\bSystem\.IO\b|\bfrom\s+System\s+import\s+.*\b(IO|File|Directory)\b/, severity: "high" },
  { rule: "System.Diagnostics.Process", re: /\bSystem\.Diagnostics\b|\bProcess\s*\.\s*Start\b/, severity: "high" },
  { rule: "System.Net", re: /\bSystem\.Net\b|\bWebClient\b|\bHttpClient\b/, severity: "high" },
  { rule: "System.Reflection", re: /\bSystem\.Reflection\b|\bAssembly\s*\.\s*Load/, severity: "high" },
  { rule: "clr.AddReference", re: /\bclr\s*\.\s*AddReference(ToFile(AndPath)?)?\s*\(/, severity: "medium" },
  { rule: "Revit Transaction", re: /\bTransaction(Group)?\s*\(|\bEnsureInTransaction\b|\bTransactionManager\b/, severity: "medium" },
  { rule: "Revit Delete", re: /\.\s*Delete\s*\(/, severity: "high" },
  { rule: "Revit Save/Sync", re: /\.\s*(Save|SaveAs|SynchronizeWithCentral|Close)\s*\(/, severity: "high" },
];

const FILE_IO_TYPE = /(File\.?(Write|Delete|Copy|Move)|FileSystem\.(Write|Delete|Copy|Move|CombinePath)|Data\.Export|ExportExcel|ExportCSV|ExportToExcel|WriteText|WriteImage|Directory\.(Delete|Create))/i;

function arr(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)) : [];
}
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Findings for one block of Python. Line numbers are 1-based. Comments are skipped. */
export function scanPythonCode(code: string, node: { id: string; name: string } = { id: "", name: "" }): Finding[] {
  const out: Finding[] = [];
  code.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/(^|\s)#.*$/, "");
    if (!line.trim()) return;
    for (const r of PY_RULES) {
      if (r.re.test(line)) out.push({ node_id: node.id, node_name: node.name, kind: "python", rule: r.rule, severity: r.severity, line: index + 1, text: raw.trim().slice(0, 200) });
    }
  });
  return out;
}

function emptyScan(file: string, message: string): GraphScan {
  const counts = { high: 0, medium: 0, info: 0 };
  return {
    ok: false, file, graph_sha256: "", python: false, python_nodes: [], python_from_string: [], custom_nodes: [], findings: [], counts,
    rules_version: SCAN_RULES_VERSION, scan_hash: "", message,
  };
}

/** Scan a .dyn from its text. `extraFindings` carries package-DLL findings from the package check. */
export function scanGraphText(file: string, raw: string, extraFindings: Finding[] = [], fileSha = ""): GraphScan {
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw.replace(/^\uFEFF/, "")); }
  catch (error) { return emptyScan(file, `[FMC-DYNAMO-PARSE] ${file} is not Dynamo JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return emptyScan(file, `[FMC-DYNAMO-PARSE] ${file} is not a Dynamo graph object.`);
  const views = new Map(arr((body.View as Record<string, unknown> | undefined)?.NodeViews).map((v) => [str(v.Id), v]));
  const findings: Finding[] = [];
  const pythonNodes: GraphScan["python_nodes"] = [];
  const fromString: string[] = [];
  const custom: GraphScan["custom_nodes"] = [];
  for (const node of arr(body.Nodes)) {
    const id = str(node.Id) || str(node.ID);
    const type = `${str(node.ConcreteType)} ${str(node.NodeType)}`;
    const name = str(views.get(id)?.Name) || str(node.Name) || type.split(",")[0].split(".").pop() || "node";
    const signature = str(node.FunctionSignature);
    if (/PythonStringNode|PythonString/i.test(type)) {
      fromString.push(id);
      findings.push({ node_id: id, node_name: name, kind: "python_from_string", rule: "Python code from a wire (cannot be read before the run)", severity: "high" });
    } else if (/Python/i.test(type)) {
      const code = [node.Code, node.Script, node.CodeBody].map(str).filter(Boolean).join("\n");
      pythonNodes.push({ id, name, engine: str(node.Engine) || str(node.EngineName), lines: code ? code.split(/\r?\n/).length : 0 });
      findings.push(...scanPythonCode(code, { id, name }));
      if (!code.trim()) findings.push({ node_id: id, node_name: name, kind: "python", rule: "Python node with no readable code", severity: "high" });
    } else if (/CustomNodes\.Function\b/i.test(type) || (/^[0-9a-f-]{36}$/i.test(signature) && !/DSFunction|DSVarArgFunction/i.test(type))) {
      custom.push({ id, name, function_id: signature });
      findings.push({ node_id: id, node_name: name, kind: "custom_node", rule: "Custom node (.dyf): its insides are not in this file; seal hashes its package", severity: "medium" });
    } else if (FILE_IO_TYPE.test(`${type} ${signature}`)) {
      findings.push({ node_id: id, node_name: name, kind: "file_io", rule: "Node writes or moves files", severity: "medium", text: signature.slice(0, 200) || undefined });
    } else if (/CodeBlockNodeModel/i.test(type)) {
      const code = str(node.Code);
      if (FILE_IO_TYPE.test(code) || /Python|Process|System\./.test(code)) {
        findings.push({ node_id: id, node_name: name, kind: "code_block", rule: "Code block calls file, process or system functions", severity: "medium", text: code.slice(0, 200) });
      }
    }
  }
  findings.push(...extraFindings);
  const counts = { high: 0, medium: 0, info: 0 } as Record<Severity, number>;
  for (const f of findings) counts[f.severity] += 1;
  const graphSha = fileSha || sha256Text(raw);
  const python = pythonNodes.length > 0 || fromString.length > 0 || extraFindings.some((f) => f.kind === "package_dll");
  const scanHash = sha256Text(stableJson({
    v: 1, rules: SCAN_RULES_VERSION, graph_sha256: graphSha,
    findings: findings.map((f) => [f.node_id, f.kind, f.rule, f.severity, f.line ?? 0]).sort((a, b) => String(a).localeCompare(String(b))),
  }));
  return { ok: true, file, graph_sha256: graphSha, python, python_nodes: pythonNodes, python_from_string: fromString, custom_nodes: custom, findings, counts, rules_version: SCAN_RULES_VERSION, scan_hash: scanHash };
}

export function scanGraph(file: string, extraFindings: Finding[] = []): GraphScan {
  let bytes: Buffer;
  try { bytes = fs.readFileSync(file); }
  catch (error) { return emptyScan(file, `[FMC-DYNAMO-PARSE] Can't read ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  return scanGraphText(file, bytes.toString("utf8"), extraFindings, sha256Text(bytes));
}
