# Plan: skills and skill rules for the AI modeller

**Status: Designed, 15 October 2026 (owner's yes).** No code until the owner approves step 1.

## What it is

A **skill** is a pack of rules and data that the AI modeller reads before it works in a discipline. Packs cover
discipline modelling, Uganda law, and budget. They extend the kit's rulebooks (`docs/RULEBOOKS.md`) and use the same rule
schema (id, clause, severity Must/Should/Advice, test, fix hint, check kind).

## Where packs live (kit, not code: rule 7)

```
03_Master_Data\FMC_Skills\
  Laws_UG\          SKILL.md, rules.json, tables\*.csv
  A_Architecture\
  S_Structure\  M_Mechanical\  E_Electrical\  P_Plumbing\  FP_FireProtection\
  Budget_BoQ\
  _index.json       pack id, roles, task kinds, version
```

- `SKILL.md`: when the pack applies, the order of checks, and the questions to ask a person.
- `rules.json`: rulebook schema v1. Every rule cites its clause, or is `Proposed` until the BIM Manager approves it.
- `tables\`: code limits, product sizes and rates, each row with its source tag (VERIFIED-UG, ASSUMED-BS, PRACTICE).
- A change to a pack is a kit change request, never a code change.

## Packs (owner's choice: all four, in this order)

| # | Pack | Examples | Engineer questions (rule 5) |
|---|---|---|---|
| 1 | **Laws (Uganda)** | Building Control Regulations 2020; Accessibility Code 2019: clear door ≥ 900 mm, threshold ≤ 5 mm, nib 450 mm, accessible WC ≥ 1900 × 2300 mm; fire refs marked ASSUMED-BS | Fire strategy values |
| 2 | **Architecture** | Fanlight or vent zone on doors, 1000 mm leaf for accessible doors, room data, finish keys | — |
| 3 | **Structure and MEP** | Grids, levels and slab zones; Maxpan floors flagged for slab design; MEP clearances, falls, connectors | Sections, demand factors, tank overflow, solar backup, 415 V AC: always asked, never set |
| 4 | **Budget / BoQ** | Unpriced elements, keynote-to-rate link, running cost against the project's budget cap | — |

## How the AI modeller uses them

1. **Load:** before any tool runs, the server loads the packs that match the model's role and the task kind (from
   `_index.json`). Laws load for every role.
2. **Check:** the dry run lists every rule checked and its clause, and **flags** each break.
3. **Never block** (owner's choice): a break is a flag, not a stop. The existing hard rules (live-model lock, write
   folders, dry run first) still stop a tool, as they do today.
4. **Never decide** (rule 5): a value that belongs to an engineer becomes a question, never a guess.

## Flags (owner's direction)

- **Flag log.** Every flag is saved to the project's `06_QA\Skills\FMC_Skill_Flags.csv`: time, project, model, role,
  pack, rule id, tool, element ids, result (`flagged`, `fixed`, `accepted`, `engineer asked`) and how it closed.
- **Next lap first.** At the start of the next build cycle, open flags go to the top of the build schedule, ahead of
  new work. The Rules pane shows them as "Carried from last lap".
- **Training data.** The log counts how often the AI tests each rule's boundary. Rules that are broken often are
  sharpened, their `SKILL.md` gets clearer, and repeat patterns become kit change requests or lessons
  (`PLAN_MEMORY.md`).
- **Rule 9.** The log records the AI, tool, pack and rule, never a person. Counts are per rule, pack and model,
  never per person (Manual 14.5).

## Pane

Check › Rules (board `PaneRules`) gets three things:

- a **Skills** list: the packs, their version and their roles;
- a **Flags** list: open first, then carried from the last lap;
- a **Most-tested rules** chart, counted by rule only.

## Build steps (each: server check → dry run → handler → log → pane)

| Step | What | Done when |
|---|---|---|
| SK1 | Pack reader + `_index.json` + flag log writer; Laws pack (kit change request with the rules) | Dry runs list Laws rules and flags; flags land in the CSV |
| SK2 | Architecture pack | Door/window/room checks flag on a test model |
| SK3 | Structure and MEP packs | Engineer values show as questions, never set |
| SK4 | Budget / BoQ pack | Unpriced and over-budget flags |
| SK5 | Rules pane: Skills, Flags, Most-tested; "next lap first" in the build schedule | Pane shows carried flags first |

## Open items for the owner

- The Laws and Budget packs need kit content (rules with clauses, rate tables). This is a kit change request, raised
  with SK1.
- Related finding: F-041 (#133). The kit has no `FMC_Rulebook_AIUse.json`. The Skills reader should land with that
  book or with this plan's SK1.
