# What an AI is told when it connects (fmc_context)

The owner, 15 October: "I want the MCP connection to route through the context in the app. Last time I used it, Claude
wanted to generate families; I had to tell him there was data in the plugin that would help."

The AI connection works for any app that speaks MCP (Claude, ChatGPT, Copilot, a local model; STATUS "Core ribbon").
So the context lives in the server, not in one AI's settings: every AI that connects learns, without being told, that
the kit and the plugin already hold the answers. Rule 7 stands: the kit is the source of truth, and this layer only
finds and routes its data. It never holds kit values itself.

## Four layers

| Layer | Where | What the AI gets |
|---|---|---|
| Server instructions | `server/src/fmc/mcp_context.ts` (`FMC_INSTRUCTIONS`), passed as `new McpServer(info, { instructions })` | In the initialize result, before any tool call: the kit comes first, call `fmc_context for_task` before making anything, never invent kit values, a missing value is a kit change request, then the hard rules, one line each (dry run first, live-model lock, write folders, never release, never save or sync workshared models, prefer fmc_ tools over send_code_to_revit, no ranking people). About 320 words |
| `fmc_context` tool | `server/src/tools/fmc_context.ts`, logic in `server/src/fmc/context.ts` | `overview`, `for_task`, `get` (below). Read-only, no Revit call, answers under 6 KB |
| Resources and prompts | `registerContextResources`, `registerContextPrompts` | `fmc://kit/overview`, `fmc://kit/family-specs/{name}`, `fmc://kit/materials/{name}`, `fmc://kit/rulebooks/{name}` (same code as the tool); prompts `build-family` and `assign-material` |
| A nudge where things get made | `installContextNudges` wraps `server.tool` before the tools register | The descriptions of fmc_doc, fmc_recipe, fmc_family, fmc_library, fmc_material, send_code_to_revit and the upstream create_* tools start with "First call fmc_context for_task to reuse the kit's spec/recipe." When send_code_to_revit makes or saves a family, or fmc_doc saves one, whose name has a kit spec or recipe, the result gets one more line pointing to it (a name lookup only) |

The tool files themselves are untouched: the wrapper adds the line and the note, so open PRs that change those tools
don't collide with this.

## fmc_context

**overview**: the kit (path, version, revision from `FMC_Kit.json`), counts per data set (family specs, register,
recipes and the profile recipes among them, profile set rows, elements and design movements, materials, keynotes,
shared parameters, rulebooks, templates, staged and released families), the open Revit documents (from
`%APPDATA%\Formcraft\instances`, no Revit call), the project manifest (`01_WIP\FMC_Project.json` above the active
model), the AI-use state (the AIUse and ClaudeUse rulebooks, the `ai_modeller` switch in `fmc_guard.json`), the engines
in this build, and which tool does what.

**for_task**: the task in plain words. The router:

1. Classifies the intent from its words: family, door, window, profile, material, keynote, parameter, sheet, schedule,
   casework, ceiling, line diagram, template, QA (more than one can apply; "aluminium door" is a door, not a material).
2. Scores the kit's family specs by name, category and words (rare words count more; tags and symbols only when asked
   for). Related words count too: bi-fold finds folding and, less strongly, sliding.
3. For the top specs: template, category, types, shared parameters with their GUIDs, the recipe (path, op count, value
   sources), and a staged or released file. With no recipe, the nearest recipes of the same role and category token
   are listed as the pattern to adapt.
4. Profiles: rows of `FMC_Profile_Sets.json` for the movements and elements named ("trim" means the J.TRM trims:
   architrave, skirting, dado rail, picture rail, panel mould), with `FMC_Design_Movement` and the profile recipes.
5. Materials from the library with keynote, keynote text and price status. A missing price reads "price needed".
6. Keynote codes, shared parameters, the sheet register, templates, rulebooks, as the intent asks.
7. Engines: casework (`fmc_casework`), line diagrams (`fmc_diagram`), ceilings (`fmc_ceiling`, PR #118) come from a
   registry (`CONTEXT_ENGINES`, `registerContextEngine`). An engine not in the build is reported as such, never
   improvised.
8. The exact next calls, e.g. `fmc_recipe {"action":"check","recipe_file":"…"}` then build with `dry_run: true`.

**get**: one item in full, capped at 12 KB: `spec:<family>`, `recipe:<family or file>` (a summary: template, op
counts by kind, types, value sources, never the whole op list), `material:<name>`, `rulebook:<name>[/<rule id>]`,
`profile:<family>`, `keynote:<code>`, `parameter:<name>`, `engine:<id>`.

## Where it reads

Everything is found from `fmc_guard.json`: the kit folder is two levels above `specs_path`; `materials_file`,
`keynote_file`, `shared_parameter_file`, `rulebooks_dir` and `family_staging_root` as set there; `FMC_Profile_Sets.json`,
`FMC_Family_Register.csv` and `Recipes\` beside the specs; templates in `06_Templates`; released families in
`04_Families\<Role>`. Recipes come from the kit's `Recipes` (all depths), from beside staged families, and from the
repo's `tests/recipes` when the server runs from a checkout. Files are read once and kept until their date or size
changes, so a call takes a few milliseconds after the first.

## Answers seen on the kit r4 (15 Oct)

- "make a bi-fold aluminium door": FMC_A_Door_AluSlidingFolding first (Metric Door.rft, 3000x2400_4Leaf and
  4500x2400_6Leaf), then AluSwing, Sliding_Glazed, AutomaticSliding, SurfaceSliding; no recipe yet, so the nearest door
  recipes (FlushSingleLeaf, SteelFanlight, TimberFanlight) and "get spec, then write the recipe and fmc_recipe check".
  About 4.3 KB.
- "trim profile georgian": movement 7 Georgian, the five J.TRM elements with heights and projections, each with its
  profile recipe, and `fmc_recipe check` on the first. About 3.4 KB.
- "terrazzo floor material": FMC_Finish_Terrazzo_InSitu, keynote I.FLR_01, "price needed", then
  `fmc_material assign` with a dry run. About 1.9 KB.

## Tests

`server/src/fmc/context.test.ts` on a slice of the real kit r4 (`server/src/fmc/fixtures/context_kit`): the
instructions and their rules, the initialize result carrying them (with the real MCP SDK), the three answers above
under 6 KB, overview counts, get, the engines registry and the nudge.
