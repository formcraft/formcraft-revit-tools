# fmc_release_package

The release step, prepare only. It takes a generated family from staging to a **release-ready package** with
validation and a manifest. It does not release: release stays a person's act in the pane (Families › Quality and
release, the Family Librarian with a reviewer and a note, Part 9.12), which moves the staged family into
`04_Families\<Role>\` and logs it in `FMC_Release_Log.csv`.

## What it never does

- publish, release, install or load a family;
- move, rename or delete the staged family;
- write into `04_Families\<Role>\` (where the pane releases to), a `library_roots` folder, a CDE gate folder
  (`blocked_segments`), anything under an `Autodesk` or `Addins` folder, or a project folder (HEBERT HOSTELS, A-0001);
- overwrite a package (the same file always gives the same folder; an existing one is reported, never replaced).

## Where the package goes

`<family_staging_root>\_ReleasePackages\<Role>\<family>__<first 12 of the .rfa's sha256>\` with:

| file | what |
| --- | --- |
| `<family>.rfa` | a copy of the staged family |
| `<family>.recipe.json`, `<family>.gate.json`, `<family>.build.json` | copies of what sits beside it, when present |
| `<family>.png` | the type image from `_Images`, when present |
| `manifest.json` | schema `fmc-release-package/1`: `state: prepared`, `published: false`, `installed: false`, `next_step`, the staged file's path and sha256, `release_to`, every file with bytes and sha256, the gate, recipe and build summaries, the checks, the note, `prepared_at`, `plan_id` |

## Checks

| id | check | fails when |
| --- | --- | --- |
| RP-01 | name `FMC_<Role>_<Token>_<Description>` | another pattern, or a project name |
| RP-02 | staged family file | missing, a `.0001` backup, or not at `<staging>\<Role>\<family>.rfa` |
| RP-03 | Gate A passed on this file | no `gate.json`, verdict not Pass, another family's result, or older than the file (stale) |
| RP-03b | gate checks a person still does | Warn only: the gate's "Not checked" lines |
| RP-04 | recipe beside the family checks clean | the recipe doesn't parse, is for another family, or `opsProblems` errors (no recipe or no kit file: Warn) |
| RP-04b | no value pending a source | Warn only |
| RP-05 | build record matches the recipe | Warn only: the `build.json` ops hash differs (built stepwise, or the recipe changed) |
| RP-06 | release target is free | Warn only: a released version exists, so the Librarian archives it first |
| RP-07 | package folder is a place this step may write | see "What it never does" |
| RP-08 | not packaged already | Warn when this exact file has a package; Fail when a folder without a manifest or a `.partial` is left |
| RP-09 | family file size | over 2.7 MB |

## Calls

- `{ family }` or `{ file }`: dry run (the default). Writes nothing (one row in `FMC_MCP_FileLog.csv`); returns
  `ready`, `blockers`, `warnings`, `checks`, `files`, `package_dir`, `release_to`, `manifest_preview`, `plan_id`.
- `{ family, dry_run: false, confirm: true, plan_id }`: writes the package, only when the plan_id is the dry run's for
  the same files and checks (`FMC-RP-DRY-RUN-FIRST` otherwise) and nothing fails (`FMC-RP-BLOCKED`). It copies into
  `<dir>.partial` (never over a file), checks each copy's sha256, writes `manifest.json`, then renames the folder. On
  any error the `.partial` stays for a person to look at and the staged family is untouched.
- `{ action: "verify", family | package_dir }`: read-only; re-hashes the package's files and the staged family against
  the manifest.

## Not yet

The pane's release doesn't read the package yet: the Librarian releases the staged family as before, and the package
is the evidence of what was checked.
