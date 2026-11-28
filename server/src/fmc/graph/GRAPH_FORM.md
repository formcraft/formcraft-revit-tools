# fmc_graph_form: spec, and how it feeds the pane form (D6, Builder 7)

Status: `spec` built (DT-29). Pane form (DT-30) is the next Builder 7 step; nothing in the pane is built yet.

## spec

`fmc_graph_form {action:"spec", path, values?, document?}` reads the `.dyn` and returns `GraphFormSpec` (`form.ts`):

- `graph`: file, real path, name, uuid, description, tier `K` (kit) or `P` (project draft), `sha256` of the file bytes.
- `fields[]`: one per input node, in graph order. `id` (node GUID), `name` (label), `kind`, `widget`, `default`,
  `min`/`max`/`step` (sliders), `options` + `options_source` (`graph`, or `revit` = list filled by Revit at run time,
  `options: null`), `hint_path`, `needs_revit`, `path_like`, `description`.
- `outputs[]`: Watch nodes and nodes set as output.
- `has_python`, `python_nodes[]` (`from_string` for Python-from-string), `custom_nodes[]`, `packages[]` (from
  `NodeLibraryDependencies`), `package_check` (Builder 6 `checkPackages`, no folder hashes; `check_packages:false`
  skips it), `lock` (Builder 6 `lockCheck` for kit graphs; `draft` for project drafts), `scan` (Builder 6
  `scanGraphText`: findings, high, `scan_hash`), `python_policy` (D1).
- `approval.person_required_for` / `kind_by_mode`: from Builder 6 `runNeedsApproval` per mode. Python or a package
  DLL: all three modes (`graph_python`); otherwise `apply` and `offline`. `PYTHON_ALWAYS_NEEDS_PERSON` is hard-coded.
- `spec_hash`: sha256 of `stableJson({graph_sha256, fields, outputs})`, for caching a rendered form.
- `values` (optional): checked by `bindFormValues` and returned as `binding.inputs_by_id` (node GUID -> value), the
  `GraphPlan.inputs_by_id` shape of Builder 6. Unknown or shared names and bad values are refused, never dropped.

Jail: kit `05_Scripts/library`, `05_Scripts/Dynamo`, or `<project>\<D4 drafts_folder>` (default `00_Formcraft\Graphs`)
where `<project>` is Builder 6 `projectRootOf` of the resolved target document. Every path-shape refusal is Builder 6
`jailCheck` v1.2 (INTERFACES sec 11): device, UNC, `..`, relative without base, missing (mustExist), outside, and links
or junctions leading out. Form keeps no pre-checks of its own; an unclaimed path is still put to `jailCheck` so a bad shape
says why. Graph path inputs must exist too: for a new output file the pane asks for its existing folder.

Modules used (INTERFACES-builder6.md v1.2): `decisions`, `hash`, `jail`, `lib` (lockCheck), `packages`, `allowlist`,
`plan` (runNeedsApproval), `scan`. No stub remains.

## How the pane form (Check > Graphs) uses it

The pane logic is `paneform.ts`, reached as `fmc_graph_form` actions through `fmc/cli.ts` (one appended case):
`form` (controls), `bind` (pane text -> typed values -> `bindFormValues` -> the `fmc_dynamo` plan request), `approval`
(the `fmc_graph_guard request_approval` call when a person is needed), `run_check` (person-decided, unused, unexpired,
same `plan_hash`; it never claims: `graphRunGate` claims at run time). Never runs a graph or decides an approval.

1. List graphs: `fmc_graph_lib {action:"list"}` (Builder 6).
2. Pick one -> `fmc_graph_form spec` -> render `fields` by `widget`: `slider` (min/max/step), `number`, `checkbox`,
   `text`, `date`, `file_picker` (`hint_path` as filter/start), `folder_picker`, `dropdown` (`options`; when
   `options_source:"revit"` the pane fills the list from the open model), `element_picker` (Revit selection; disabled
   when no model is open). `path_like` fields get a jail hint. Show `outputs` as the result panel, `warnings` and,
   when `has_python`, a Python banner.
3. On Preview: `fmc_graph_form spec` with `values` -> `binding.inputs_by_id`; then `fmc_dynamo {action:"plan"}`
   (Builder 6) with those inputs -> `plan_hash` and diff.
4. Ask approval: `fmc_graph_guard {action:"request_approval"}`; a person approves in the pane through the server CLI
   (`graph_approve {id}` / `graph_refuse {id}`, never MCP). Run with `approval_id`. Staff runs are person runs.
5. Cache by `spec_hash`; re-fetch when `graph.sha256` changes.

Done: `case "fmc_graph_form"` is appended in `fmc/cli.ts` (approved by Builder 6) and in `testrun.ts` CLI_TOOLS.
