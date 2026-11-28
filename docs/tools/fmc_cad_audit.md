# fmc_cad_audit (GAP-14)

Read-only audit of CAD and raster images in one open document, with a clean-up plan. There is no dry run and no transaction. Nothing is deleted or changed. Every removal in the plan goes through `fmc_wipe` (Builder 10, Data & Exports) with the person's approval.

What it reads:

- every `ImportInstance`: imported or linked, view-specific (2D in one view) or model space (3D, in every view), owner view, pinned; for a link, the path and `GetLinkedFileStatus()` from the `CADLinkType`;
- import line-style categories (`CategoryType.Import`) and whether any CAD in the model still uses them;
- with `scan_families` (default true, up to `max_families`, default 300): each editable loadable family is opened with `EditFamily`, its imports and links counted, and closed with `Close(false)`;
- raster images: each `ImageType` with its source (import or link), path, whether the file exists, and how many `ImageInstance`s are placed and in which views.

The plan is sorted by priority:

| Priority | Finding |
| --- | --- |
| high | imported CAD in model space; CAD inside families; linked CAD not loaded |
| medium | imported CAD in single views; linked images whose file is missing |
| low | linked CAD in every view; unpinned model-space links; imported images; unused image types; unused import line styles |

`status` is `CLEAN` when the plan is empty, else `ACTION`.

```json
{ "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", "scan_families": true, "max_families": 300 }
```

Needs a live Revit check: that import line-style categories are listed by `doc.Settings.Categories`, and the time `EditFamily` takes on a large model.
