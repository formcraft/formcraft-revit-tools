# fmc_fabrication

MEP fabrication support, read only. The add-in side only reads: nothing is opened, loaded or changed, there is no transaction and no rollback. The tool never writes a Revit file.

Actions:

- `config`: is a `FabricationConfiguration` loaded in the model? Its name, description, version, product version, path, GUID, unit system and whether it is cloud or locked. The `FabricationService` list, split into loaded and not loaded, and the services the parts use.
- `audit`: the `FabricationPart`s counted by service, category, level, specification and material, and the parts with a problem, each with sample ids (`sample_limit`):
  - no service name; a service id that isn't in the configuration; a service that is in it but not loaded;
  - no specification name; no material (or a validation status of `NoMaterial`);
  - no insulation specification, counted only when `require_insulation` is true (a part with no insulation is otherwise only counted as information);
  - a connector that isn't connected (hangers are left out);
  - a validation status that isn't `Valid`;
  - `NeedToUpdateIsoDrawing`. This is the only "out of date" the API exposes: it does not compare a part with its catalogue item, and the reply says so.
- `ancillaries`: per part, the ancillaries it uses (`GetPartAncillaryUsage`: hangers, stiffeners, seams, connectors and so on) with quantities and lengths, and the totals by usage type, ancillary type and name.
- `export`: the audit, the ancillary summary and one row per part, as CSV, JSON or both (`format`).

`levels` limits every action to those level names. Pass `document` (a title or a full path) when more than one document is open; a name that isn't open is refused, the active document is not a guess.

## No configuration

If the model has no fabrication configuration (or an invalid one) every action answers:

```json
{ "ok": true, "configured": false, "message": "No fabrication configuration is loaded in this model. ...", "exported": false }
```

It is not an error. `fabrication_parts_in_model` says how many `FabricationPart`s the model holds anyway. Nothing is written.

## Where the export goes

- Default: the tool's own folder, `FMC_FABRICATION_DIR` if set, else `%LOCALAPPDATA%\Formcraft\fabrication`. Files are `FMC_Fabrication_<run_id>.csv` and `.json`.
- `output_path`: a project **folder**. It must be inside the write roots of `fmc_guard.json` (`checkWritePath`), and a path to a file (and above all a `.rvt`, `.rfa`, `.rte` or `.rft`) is refused. It is a dry run by default (`would_write` lists the two files); `dry_run=false` needs `confirm=true`, after the person has seen the dry run. If the guard config can't be read, a real write is refused.

Every reply has a `run_id` (`FB-<date>T<time>-<6 hex>`); each export (dry run, refusal, write) is a row in `FMC_MCP_FileLog.csv` with `run <run_id>:` in the detail.

## Examples

```json
{ "action": "config", "document": "F26901-FMC-ZZ-ZZ-M3-M-0002_USER" }
{ "action": "audit", "document": "F26901-FMC-ZZ-ZZ-M3-M-0002_USER", "levels": ["Level 1"], "require_insulation": true }
{ "action": "export", "document": "F26901-FMC-ZZ-ZZ-M3-M-0002_USER", "output_path": "D:\\Projects\\F26901\\01_WIP\\Mechanical\\_Fabrication" }
```

## Status

Not run against a live Revit with a fabrication configuration. The Revit API calls (`FabricationConfiguration.GetFabricationConfiguration`, `GetAllServices`, `GetAllLoadedServices`, `GetAllUsedServices`, `FabricationPart` properties, `GetPartAncillaryUsage`) are written from the API reference and are checked only by the build and by the server tests with a stand-in add-in. Each property is read on its own, so one the API refuses on a part gives an empty field, not a lost row. Rods and hosted info of hangers aren't read yet. The part list is capped at 20,000 rows; the reply says when it was cut.
