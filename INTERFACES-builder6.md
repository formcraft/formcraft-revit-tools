# INTERFACES-builder6.md: Dynamo graph tools contract (Builder 6)

Contract version: **1** (28 Nov 2026, EAT). Branch `builder6/dynamo-graph-tools` from `cf71214`.
Builder 7 (form, study, schedule, graph packs, pane) codes against this. If anything here changes, the version
number goes up and the change is listed in "Change log" at the end. Server modules are TypeScript ESM under
`server/src/fmc/graph/`; tools are under `server/src/tools/`.

Spec: Tool Research, `DYNAMO_TOOLS_PROPOSAL-2026-11-28.md` (rows DT-xx). Only Builder 6 rows are built here.

## 0. Hard rules (code, not config)

- `PYTHON_ALWAYS_NEEDS_PERSON = true` (`fmc/graph/decisions.ts`). A graph with a Python node, a Python-from-string
  node, or a package that ships a DLL needs a person's approval bound to its `plan_hash` for **every** run mode
  (preview, apply, offline). No config key, `access:"full"`, `allow_code` or `auto_approve` turns this off.
- Every `apply` of any graph needs a person's approval bound to its `plan_hash` (DT-65). `dry_run:false` alone is no longer a yes.
- Every `offline` (DynamoCLI) run and every library `python` runner run needs a person's approval (R-3 / DT-60).
- Approvals are person-only, single-use, expire (default 30 min). The AI can only *request*; only the pane CLI
  (`graph_approve` / `graph_refuse`, never MCP) decides. An approval whose `decided_by` starts with `auto` is refused.
- Kit is read-only. Drafts, versions and lock proposals go under `<project>\00_Formcraft\Graphs\` (D4), where
  `<project>` is the folder above `01_WIP` of the **target document**. Callers never pass roots.

## 1. Module map

| Module | Exports (stable) |
|---|---|
| `fmc/graph/decisions.ts` | `PYTHON_ALWAYS_NEEDS_PERSON`, `GRAPH_DECISIONS_DEFAULT`, `graphDecisions(cfg): GraphDecisions`, `type GraphDecisions` |
| `fmc/graph/hash.ts` | `sha256Text(s)`, `sha256File(file)`, `sha256Folder(dir)`, `stableJson(v)`, `inputsHash(inputs)` |
| `fmc/graph/jail.ts` | `projectRootOf(docPath)`, `graphsDir(projectRoot)`, `jailCheck(file, root): {ok:true, real}\|{ok:false, code, message}`, `pathInputsOutsideJail(inputs, root): string[]` |
| `fmc/graph/approvals.ts` | `approvalsDir(env)`, `requestGraphApproval(req, env?, now?)`, `readGraphApproval(id, env?)`, `listGraphApprovals(filter?, env?)`, `decideGraphApproval(id, "approved"\|"refused", by, env?, now?)` (pane only), `claimGraphApproval(id, planHash, env?, now?)`, `type GraphApproval` |
| `fmc/graph/plan.ts` | `buildPlan(args): {ok:true, plan: GraphPlan}\|{ok:false, code, message}`, `planHash(parts)`, `bindInputsByName(inspect, inputs)`, `runNeedsApproval(plan): {needed, why[]}`, `type GraphPlan` |
| `fmc/graph/rungate.ts` | `graphRunGate(plan, approvalId, env?, now?): {ok:true, approval?}\|{ok:false, code, message, needs_approval?}` (used by `executeDynamo` and the python runner) |
| `fmc/graph/scan.ts` | `scanGraph(file, opts?): GraphScan` (DT-55), `scanPythonCode(code): Finding[]` |
| `fmc/graph/packages.ts` | `packageFolders(env)`, `installedPackages(folders)`, `checkPackages(inspect, installed): PackageCheck` (DT-26) |
| `fmc/graph/allowlist.ts` | `allowlistFile(env)`, `readAllowlist(env): Allowlist` (DT-56, read-only to the AI) |
| `fmc/graph/lib.ts` | `listGraphs({kit, projectRoot})` (DT-42), `versionDraft({projectRoot, draft, id, reason, author})` (DT-45), `proposeLock({kit, projectRoot})` (DT-47), `readLock(kit)`, `lockCheck(kit, file, sha)` |
| `fmc/graph/author.ts` | `TEMPLATES`, `scaffoldGraph(template, opts)` (DT-01), `generateGraph(spec)` (DT-02), `validateGraph(file\|json)` (DT-03), `type GraphSpec` |

## 2. plan_hash

`fmc_dynamo action:"plan"` (DT-64) returns a `GraphPlan`; `plan_hash` is computed in `plan.ts`:

```ts
interface GraphPlan {
  v: 1;
  graph: string;            // absolute path of the .dyn
  graph_sha256: string;     // sha256 of the file bytes
  deps_sha256: string;      // sha256 of stableJson(sorted [{name, version, folder_sha256}]) for packages found installed; "" if none
  inputs_by_id: Record<string, unknown>; // named inputs bound to node GUIDs (R-1 / DT-62)
  inputs_hash: string;      // sha256(stableJson(inputs_by_id))
  document: { title: string; path: string; state: string }; // state = "<size>:<mtimeMs>" of the model file on disk, "" if unreadable
  mode: "preview" | "apply" | "offline";
  scan_hash: string;        // GraphScan.scan_hash
  allowlist_version: string;// Allowlist.version ("none" when the file is missing)
  lock: "match" | "absent" | "mismatch" | "unlisted";
  python: boolean;          // python node, python-from-string node, or DLL package
  needs_approval: boolean; approval_why: string[];
  plan_hash: string;
}
plan_hash = sha256(stableJson({ v, graph_sha256, deps_sha256, inputs_hash,
  document: { path: lower(path), title, state }, mode, scan_hash, allowlist_version }))
```
`stableJson` sorts object keys recursively, no whitespace. Any change to graph bytes, inputs, mode, model file on disk,
scan result or allowlist version gives a new `plan_hash` and the approval no longer matches. Revit/Dynamo versions are
not in v1 (they need a Revit round trip); planned for v2.

## 3. Approval call signature and flow (FC-1 pattern)

1. AI: `fmc_dynamo {action:"plan", path, inputs, mode}` -> `GraphPlan`.
2. AI: `fmc_graph_guard {action:"request_approval", path, inputs, mode, reason}` -> server rebuilds the plan, writes
   a pending record, returns `{approval_id, status:"pending", plan_hash, expires_at, kind}`.
   TS: `requestGraphApproval({ kind, plan, reason, requested_by }) -> GraphApproval`.
3. Person (pane, Builder 7 hook): `node build/fmc/cli.js graph_approve` with stdin `{"id":"<approval_id>"}`
   (or `graph_refuse`). `by` = Windows `USERNAME`. CLI only; no MCP tool can decide. `graph_approvals` CLI lists
   pending records for the pane (`{"status":"pending"}` optional filter).
4. AI: `fmc_dynamo {action:"run"|"submit", path, inputs, mode, approval_id}` -> server rebuilds the plan, then
   `graphRunGate`: record must exist, `status:"approved"`, `decided_by` not `auto*`, not expired, `plan_hash` equal.
   It is claimed (`status:"used"`) **before** Revit or DynamoCLI runs. Wait: `fmc_graph_guard {action:"approval_status", approval_id}`.
5. Log: one JSON line per gated run in `%LOCALAPPDATA%\Formcraft\graph_runs.jsonl` (graph sha, plan_hash, approval id, approver, caller, mode).

```ts
interface GraphApproval {
  id: string;                     // 16 hex
  kind: "graph_run" | "graph_python" | "graph_offline" | "script_python";
  status: "pending" | "approved" | "refused" | "used" | "expired";
  plan_hash: string; graph: string; graph_sha256: string; inputs_hash: string; scan_hash: string;
  allowlist_version: string; mode: string; document: { title: string; path: string; state: string };
  python: boolean; findings: number; reason: string; requested_by: string;
  created_at: string; expires_at: string; decided_by?: string; decided_at?: string; used_at?: string;
}
```
Store: `%LOCALAPPDATA%\Formcraft\graph_approvals\<id>.json` (env override `FMC_GRAPH_APPROVALS` for tests).
Refusal codes: `FMC-GRAPH-APPROVAL-NEEDED`, `-NOT-FOUND`, `-PENDING`, `-REFUSED`, `-USED`, `-EXPIRED`, `-MISMATCH`, `-AUTO`.

## 4. Package-check result (DT-26)

```ts
interface PackageCheck {
  ok: boolean;                     // nothing missing or older
  folders: string[];               // searched: %APPDATA%\Dynamo\Dynamo Revit\<v>\packages, %ProgramData%\Autodesk\RVT <yr>\Dynamo\<v>\packages, built-in
  packages: Array<{ name: string; wanted: string; installed: string | null; folder: string | null;
                    status: "ok" | "missing" | "older" | "newer"; folder_sha256: string | null; has_dll: boolean;
                    allowed: boolean }>;   // allowed = in D3 list or the allowlist
  missing: string[]; older: string[];
}
```

## 5. Library shapes (DT-42/45/47)

```ts
interface GraphEntry { id: string; version: number | null; file: string; sha256: string; tier: "K" | "P";
  status: "kit" | "draft" | "version" | "retired"; runner: "dynamo"; packages: string[]; python: boolean; writes_model: boolean; lock: "match"|"absent"|"mismatch"|"unlisted" }
// versionDraft -> writes <project>\00_Formcraft\Graphs\versions\<id>@<n>.dyn and <id>@<n>.json (never overwrites):
interface GraphVersion { id: string; version: number; file: string; sha256: string; parent_sha256: string | null;
  author: "person" | "ai"; author_name: string; reason: string; created_at: string }
// proposeLock -> writes <project>\00_Formcraft\Graphs\graphs.lock.proposed.json; a person/release copies it to <kit>\05_Scripts\graphs.lock.json
interface GraphsLock { v: 1; created_at: string; kit: string;
  graphs: Record<string /* path relative to kit, '\\' separators, lower-case */, { sha256: string }>;
  custom_nodes: Record<string, { sha256: string }>; packages: Record<string, { version: string; folder_sha256: string }> }
```
Run rule: when `<kit>\05_Scripts\graphs.lock.json` exists, a kit graph whose sha differs (`mismatch`) or is not listed
(`unlisted`) is refused (`FMC-GRAPH-LOCK`). When it is absent, runs report `lock:"absent"` and continue.

## 6. Pane hook (D6, owned by Builder 7)

Builder 7's pane calls the server CLI (`ServerCli.RunAsync`) with: `graph_approvals` (list), `graph_approve {id}`,
`graph_refuse {id}`, and the normal tools `fmc_graph_lib {action:"list"}`, `fmc_dynamo {action:"plan"}`,
`fmc_graph_guard {action:"scan"}`. The record JSON in section 3 is what the pane shows (code + findings via `scan`).
Approve never runs the graph; the requester runs it with `approval_id`.

## 7. Decisions D1-D14 (decided 2026-11-28; config with these defaults)

Config: `fmc_guard.json` -> `graph_tools.decisions.<key>` overrides; `graphDecisions(cfg)` merges onto defaults.

| # | Key | Default (decided 2026-11-28) |
|---|---|---|
| D1 | `python_policy` | `"person_approves_each_hash"` (`off` refuses Python graphs; `signed_kit_only` refuses Python graphs not in the kit lock). Person approval is hard-coded in all cases. |
| D2 | `allowlist_owner`, `allowlist_file` | `"BIM Manager"`, `%LOCALAPPDATA%\Formcraft\graph_allowlist.json` (read-only to the AI) |
| D3 | `allowed_packages`, `python_engine`, `third_party_packages` | Autodesk built-ins + `GenerativeDesign 8.2.1.0`; `"PythonNet3"`; `[]` |
| D4 | `drafts_folder`, `tier_p_runs` | `"00_Formcraft\\Graphs"`; `"preview_scratch_only"` (v1: drafts are not runnable; see deferred) |
| D5 | `dynamo_player_kit_graphs` | `false` |
| D6 | `pane_form_owner` | `"builder-7"` (hook in section 6) |
| D7 | `generative_engine` | `"builtin_first"` |
| D8 | `study_limits` | `{ max_runs: 200, max_minutes: 60, scratch_only: true, fixed_seed: true }` |
| D9 | `scheduled_apply`, `schedule_registration` | `false`; `"person"` |
| D10 | `formcraft_nodes_signed` | `true` |
| D11 | `graph_release` | `"person"` |
| D12 | `apply_needs_person` | `true` (approval on apply; config cannot set it false: hard rule) |
| D13 | `pin_min_dynamo` | `true` |
| D14 | `diagnostics_outside_jail` | `"read_only"` (paths, names, versions only) |
| - | `approval_ttl_minutes` | `30` |

## 8. BUILD.lock convention (found under C:\Users\USER\agent-tools\revit-tests\builds\)

- Path: `C:\Users\USER\agent-tools\BUILD.lock`. Also respect `C:\Users\USER\agent-tools\LIVE_TEST.hold` (do not build while it exists).
- Format: one line, `<owner> yyyy-MM-dd HH:mm:ss (<purpose>)`, e.g. `Builder 6 2026-11-28 14:10:00 (b6 tsc/test/dotnet R25)`.
- Acquire: only when neither file exists, create atomically with `[IO.File]::Open($lock,'CreateNew','Write','None')`; retry every 15 s.
- Hold: long holders refresh the timestamp every ~4 min while their line is still theirs.
- Release: delete the file only if its content starts with your owner tag.

## Change log
- v1 (28 Nov 2026): first version.
