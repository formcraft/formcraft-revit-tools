import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../fmc/policy.js";
import { approvedScriptPath, kitRootFrom, outsideRootMessage, readDyn } from "../fmc/dynamo.js";
import { callDocument, scriptPythonPlan } from "../fmc/scriptexec.js";
import { findScript, resolveEntry, withResolved } from "../fmc/scriptlib.js";
import { graphDecisions, PYTHON_ALWAYS_NEEDS_PERSON } from "../fmc/graph/decisions.js";
import { buildPlan } from "../fmc/graph/plan.js";
import { scanGraph } from "../fmc/graph/scan.js";
import { checkPackages, installedPackages, packageFolders } from "../fmc/graph/packages.js";
import { readAllowlist } from "../fmc/graph/allowlist.js";
import { readGraphApproval, requestGraphApproval } from "../fmc/graph/approvals.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_GRAPH_GUARD_DESCRIPTION =
  "Safety checks for Dynamo graphs (reads only; installs nothing, approves nothing). packages: the packages a kit graph needs against the installed " +
  "pkg.json (user, ProgramData, built-in folders): missing, older, newer, allowed, folder hash, ships a DLL. scan: every Python node, Python-from-string node, " +
  "custom node and file-writing node, with findings (os, subprocess, socket, shutil, ctypes, urllib, importlib, pickle, eval/exec, open() for writing, " +
  "clr.AddReference, System.IO/Process/Net/Reflection, Revit Transaction/Delete/Save/Sync) and scan_hash. allowlist: the person-owned allowlist (read-only; " +
  "propose entries in words). request_approval: make a pending, person-only, single-use approval (30 min) bound to the run's plan_hash (path, inputs, mode) " +
  "or to a library python script (script_id); a person decides in the pane. approval_status: poll it. seal: re-hash the graph and its packages now and " +
  "say whether they still match an approval. status: the Python policy in force. Python graphs ALWAYS need a person's approval, whatever the access level.";

export const FMC_GRAPH_GUARD_SHAPE = {
  action: z.enum(["packages", "scan", "allowlist", "request_approval", "approval_status", "seal", "status"]),
  path: z.string().optional().default("").describe("packages, scan, request_approval, seal: the kit .dyn"),
  inputs: z.record(z.unknown()).optional().describe("request_approval: the run's inputs by name"),
  mode: z.enum(["preview", "apply", "offline"]).optional().default("preview").describe("request_approval: the run's mode"),
  script_id: z.string().optional().default("").describe("request_approval: a library python script id instead of a graph"),
  reason: z.string().optional().default("").describe("request_approval: why, in a line the person reads"),
  approval_id: z.string().optional().default("").describe("approval_status, seal"),
  kit_folder: z.string().optional().default(""),
};

export type FmcGraphGuardArgs = z.infer<z.ZodObject<typeof FMC_GRAPH_GUARD_SHAPE>>;

export async function runFmcGraphGuard(args: FmcGraphGuardArgs) {
  const { config } = loadConfig();
  const decisions = graphDecisions(config);
  const kit = kitRootFrom(config, process.env, args.kit_folder);
  try {
    if (args.action === "status") {
      return reply({
        action: "status", python_policy: decisions.python_policy, python_always_needs_person: PYTHON_ALWAYS_NEEDS_PERSON,
        apply_needs_person: true, offline_needs_person: true, approval_ttl_minutes: decisions.approval_ttl_minutes,
        allowlist_owner: decisions.allowlist_owner, why: "Decisions D1-D14 decided 2026-11-28; Python approval is a hard rule in code. Read-only to the AI.",
      });
    }
    if (args.action === "allowlist") {
      const a = readAllowlist(process.env, decisions);
      return reply({ action: "allowlist", ...a, allowed_packages: decisions.allowed_packages, third_party_packages: decisions.third_party_packages,
        note: `Owned by ${a.owner}. The AI may propose entries in words; only a person edits ${a.file}.` });
    }
    if (args.action === "approval_status") {
      const item = readGraphApproval(args.approval_id);
      if (!item) return reply({ refused: true, code: "FMC-GRAPH-APPROVAL-NOT-FOUND", message: `[FMC-GRAPH-APPROVAL-NOT-FOUND] No graph approval ${args.approval_id}.` }, true);
      return reply({ action: "approval_status", ...item });
    }
    const doc = callDocument("fmc_graph_guard");
    if (!doc.ok) return reply(withResolved({ refused: true, code: doc.code, message: doc.message }, null), true);
    if (args.action === "request_approval" && args.script_id.trim()) {
      const entry = findScript(kit, args.script_id.trim());
      if (!entry?.manifest) return reply({ refused: true, code: "FMC-SCRIPT-NOT-FOUND", message: `No library script ${args.script_id}.` }, true);
      const file = resolveEntry(kit, entry.manifest_path, entry.manifest.entry);
      if (!file.ok) return reply({ refused: true, code: "FMC-SCRIPT-ROOT", message: file.message }, true);
      const plan = scriptPythonPlan(file.file, args.inputs ?? {}, doc.document);
      const item = requestGraphApproval({ kind: "script_python", plan, reason: args.reason, requested_by: "ai", ttl_minutes: decisions.approval_ttl_minutes });
      return reply(withResolved({ action: "request_approval", approval_id: item.id, status: item.status, kind: item.kind, plan_hash: item.plan_hash, expires_at: item.expires_at,
        next: "A person approves or refuses it in the pane. Poll approval_status, then run fmc_script_run with approval_id." }, doc.document));
    }
    const file = args.path.trim();
    if (!file) return reply({ refused: true, message: `${args.action} needs path, the .dyn file.` }, true);
    if (!approvedScriptPath(file, kit)) return reply(withResolved({ refused: true, code: "FMC-SCRIPT-ROOT", message: outsideRootMessage(file, kit) }, doc.document), true);
    const parsed = readDyn(file);
    if (!parsed.ok) return reply({ refused: true, code: "FMC-DYNAMO-PARSE", message: parsed.message }, true);
    const folders = packageFolders();
    const pkgs = checkPackages(parsed.inspect, installedPackages(folders), folders, decisions, readAllowlist(process.env, decisions).packages, args.action !== "scan");
    if (args.action === "packages") return reply(withResolved({ action: "packages", file, ...pkgs, dll_findings: undefined }, doc.document), !pkgs.ok);
    if (args.action === "scan") {
      const scan = scanGraph(file, pkgs.dll_findings);
      return reply(withResolved({ action: "scan", ...scan, needs_person: scan.python }, doc.document), !scan.ok);
    }
    const document = doc.document ? { title: doc.document.title ?? "", path: doc.document.path ?? "" } : null;
    if (args.action === "seal") {
      const item = readGraphApproval(args.approval_id);
      if (!item) return reply({ refused: true, code: "FMC-GRAPH-APPROVAL-NOT-FOUND", message: `[FMC-GRAPH-APPROVAL-NOT-FOUND] No graph approval ${args.approval_id}.` }, true);
      // Re-plan with the approval's own mode; inputs are not stored, so only the hashes that do not need them are compared.
      const planned = buildPlan({ file, inputs: {}, mode: item.mode as "preview" | "apply" | "offline", document, kit, cfg: config, decisions });
      if (!planned.ok) return reply({ refused: true, code: planned.code, message: planned.message }, true);
      const p = planned.plan;
      const diffs = [
        p.graph_sha256 !== item.graph_sha256 ? "graph file" : "",
        p.scan_hash !== item.scan_hash ? "scan (Python, custom nodes or package DLLs)" : "",
        p.allowlist_version !== item.allowlist_version ? "allowlist" : "",
        p.document.state !== item.document.state ? "model file on disk" : "",
      ].filter(Boolean);
      return reply(withResolved({ action: "seal", approval_id: item.id, sealed: diffs.length === 0, changed: diffs, status: item.status }, doc.document), diffs.length > 0);
    }
    const planned = buildPlan({ file, inputs: (args.inputs ?? {}) as Record<string, unknown>, mode: args.mode, document, kit, cfg: config, decisions });
    if (!planned.ok) return reply(withResolved({ refused: true, code: planned.code, message: planned.message }, doc.document), true);
    const p = planned.plan;
    if (!p.needs_approval) {
      return reply(withResolved({ action: "request_approval", needed: false, plan_hash: p.plan_hash, message: "This run needs no approval (a preview of a graph with no Python)." }, doc.document));
    }
    const item = requestGraphApproval({ kind: p.approval_kind, plan: p, findings: p.findings, reason: args.reason, requested_by: "ai", ttl_minutes: decisions.approval_ttl_minutes });
    return reply(withResolved({
      action: "request_approval", approval_id: item.id, status: item.status, kind: item.kind, plan_hash: item.plan_hash, expires_at: item.expires_at,
      why: p.approval_why, findings: p.findings,
      next: "A person approves or refuses it in the pane (never the AI). Poll fmc_graph_guard approval_status, then run fmc_dynamo with the same path, inputs and mode plus approval_id.",
    }, doc.document));
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error) }, true);
  }
}

export function registerFmcGraphGuardTool(server: McpServer) {
  server.tool("fmc_graph_guard", FMC_GRAPH_GUARD_DESCRIPTION, FMC_GRAPH_GUARD_SHAPE, (args) => runFmcGraphGuard(args));
}
