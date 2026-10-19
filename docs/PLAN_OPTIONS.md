# Plan: options side by side

**Status: Proposed, 19 October 2026.** The owner picked this from `IDEAS_BACKLOG.md`; it waits for a yes before any
code. Steps O0–O4, one PR each.

## The idea
A design question ("4.2 m or 4.5 m ICU bays?", "one corridor or two?", "store here or there?") gets two or three
answers built from the same recipes and compared on one screen before anyone chooses. Options are **branches of the
recipe tree**: a node (a room, a department, a level, the building) holds variants, and everything about a variant
(its plan, quantities, checks) is computed from the recipes without Revit, in seconds. Only when the person wants to see
them in the model are the variants built into Revit's own **Design Options**, side by side. A person chooses; nothing
here chooses for them.

## What is compared
| Measure | From | Note |
|---|---|---|
| Area against the brief | T5 quantities (`FMC_Target_Area`) | per room, department, total; rooms off by more than 10% named |
| Quantities | the recipes' ops: wall m², ceiling m², doors, windows, each family type counted | joined to the kit's keynote codes and bill groups like `fmc_build` |
| Cost | **owner's decision** (below) | the plugin never returns rates today |
| Checks | each room's own checks (fits, clearances, HBN distances in the recipes), corridor and door widths | the skills packs join later (`PLAN_SKILLS.md`) |
| Daylight (a proxy) | glazing area over floor area, when the recipe gives the window's height | labelled a proxy, never a simulation |
| Plan picture | a 2D sketch drawn from the ops (SVG, no Revit) | the same view for every variant |

Shown as **trade-offs, never a ranking**. Options aren't sorted by cheapest ("value, not cheapest"). Each one shows
whether it meets the brief, what it costs in quantities, and what it gains.

## Steps
| Step | What | Done when |
|---|---|---|
| O0 | Variants in the tree: a node keeps `variants` (each its own inputs or recipe) and one `active`; plan and build use the active one; a dry run shows the difference | Two bay widths live in one tree; switching rebuilds only that node |
| O1 | The comparison: every measure above per variant, as a table, a CSV for Power BI, and a one-page sheet in `01_WIP\_Options` | `fmc_tree options compare` on the ICU bay shows both widths side by side |
| O2 | The pane: option cards side by side (numbers, the plan sketch, what fails), and "make active" | The owner compares two options without opening Revit |
| O3 | In Revit: each variant built into a Design Option set "FMC <node>", never the main model, so people walk through them | Both bay widths visible in Revit's Design Options |
| O4 | Choosing: the chosen variant becomes the node, the others are kept in the tree's history. Revit's "Accept primary" deletes the other options, so a person does that step | The chosen option is the tree's; the rejected ones can come back |

## Rules
- Dry run first, and live models stay locked.
- Kit data only (rule 7).
- A person chooses (rule 5).
- Revit's destructive steps (accepting a primary option, deleting option sets) are people's.

## Decisions for the owner
1. **Cost.** Either **quantities only**, joined to the kit's codes and bill groups (recommended: consistent with "rates are
   never returned" today), or a **rates file the QS owns** joined to them for a cost per option. Rates stay the QS's file
   and are never kept by the plugin.
2. **Daylight.** Either the glazing-to-floor proxy only (recommended now), or a later step that sends a variant to a real
   daylight tool. That is a paid option, worth it only if the clients ask for daylight figures.
