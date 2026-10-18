# Plan: the recipe tree (the whole building as one recipe of recipes)

**Status: Approved in principle, 19 October 2026 (owner's yes).** Steps T0–T6; each step's PR waits for its own yes.

## The idea
Families are already built from recipes: checked before Revit, rebuilt by a script, versioned. The owner's idea is to
build **everything** that way: the project, the building, each floor and department, each room, the assemblies in it
(ceilings, casework, bedhead walls), its systems (power, lighting, medical gas, drainage, air) and its families, down to
the components and their Rhino twins. One giant recipe made of small recipes. Change a room's size in the brief and its
ceiling, casework, bedhead, lights and gas drops follow; check the whole hospital before anything is modelled; rebuild
only what changed.

## A node
```
node:   ICU-Bay-03                       kind: room
inputs: width 4200, depth 5000, ceiling height 2900, beds 1
refs:   level L2, grids C/4–5, zone ICU
uses:   ceiling (tray + bulkhead), bedhead panel (1 bed), ICU bed, operating light, door (hygienic 1026),
        window (observation 1200), small power (ICU-SP rules), lighting (ICU-LT rules), med-gas drops
rules:  HBN 04-01 clearances, Uganda accessibility, the kit's naming and materials
checks: clearances, outlets per bed, lux target, door clear width
out:    the Revit elements it made (identity map), quantities, its Gate A line, its revision hash
```
Every node has inputs, references (what it hangs on), the recipes it uses, rules, checks and outputs. Children inherit
context (a ceiling knows its room). Each node has a revision hash; only nodes whose inputs changed rebuild. A dry run
shows the change as a diff, room by room.

## Today's tools become nodes
| Node kind | From | State |
|---|---|---|
| Project, building, levels | `fmc_project`, `fmc_brief` (the Concept Information Set) | exists; needs the common node format |
| Room, zone | the room recipe | to build |
| Ceiling | `fmc_ceiling` engine | exists (pure computation) |
| Casework run | `fmc_casework` engine | exists (pure computation) |
| Systems | room rule sets for power, lighting, gas, drainage; `fmc_diagram` for schematics | partly |
| Families, components, twins | recipes, `detailgen`, `fmc_rhino twins` | exists |
| Structure | `fmc_robot` round trip | exists |

## Edits made by hand (the hard part)
A rebuild must never silently undo a person's work. Two ways back into the tree:
1. **Mark & Review** (`PLAN_MARK_REVIEW.md`): a ticket on an element is traced through the identity map to the node
   that made it, and its fix changes **the node**, so it survives every rebuild.
2. **A direct edit in Revit** is found by the next dry run and offered as a choice: **adopt** it into the node, or keep
   it as a **recorded override** (shown, never overwritten).

## Rules
Professional decisions stay people's (rule 5): recipes encode layouts and the firm's standards; pipe and cable sizes,
loads and fire strategy are engineers' inputs, asked and never guessed. Kit data only (rule 7). Dry run first. Live
models stay read-only unless the guard allows. Rebuilds are incremental, so a whole hospital stays fast.

## Steps
| Step | What | Done when |
|---|---|---|
| T0 | One node format for every scale; the existing tools wrapped as nodes | A node's dry run lists what it would make |
| T1 | **The ICU bay:** the first room recipe (ceiling, bedhead, bed, light, door, window, clearances) | A changed room size regenerates everything in it |
| T2 | Room rule sets: small power, lighting, medical gas per room type, from the kit's rulebooks | An ICU bay gets its outlets and lights by rule |
| T3 | Edits back into the tree: adopt or override, with Mark & Review | A hand edit survives a rebuild, recorded |
| T4 | Floors and departments: many rooms, corridors, incremental rebuilds | A department rebuilds only its changed rooms |
| T5 | The building: brief → levels → departments → rooms, one tree; quantities and checks across it | The sample hospital builds from its brief |
| T6 | Every app from the tree: Navisworks clash sets, Robot, Rhino, Power BI quantities | One change shows in every app |
