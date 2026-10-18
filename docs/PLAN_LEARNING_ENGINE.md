# Plan: the learning engine (the system improves itself, with a person's yes)

**Status: Proposed, 18 October 2026.** The owner asked for "the most perfect version". No code until the owner says yes
to this plan and then to each step (CLAUDE.md, "Plan first").

## The idea in one paragraph
Every time an AI (or a person through the pane) does a task in any app, the system keeps an exact record of what was
done and whether it worked. A miner that needs no AI looks across those records for work that repeats and work that
fails. It turns repeated successful work into a **saved flow** (a script that runs with no AI and no credits), and
repeated failures into a **lesson** or a **check rule**. Nothing it finds is used until it has been **proven** against
the records it came from and a **person has said yes**. Next time, the AI looks in the library first and runs the
flow instead of working the task out again. Flows that prove themselves over many runs are **promoted into real tool
code** through a PR. So the system gets cheaper, faster and more consistent with every project, and it never changes
itself without a person knowing.

## Seven rules the engine never breaks
1. **It proposes; it never applies itself.** A person approves every new flow, lesson, rule or default. Code changes
   only through a PR, CI and the owner's merge.
2. **Evidence only.** It learns only from runs that passed their checks (Gate A, the host test, a clean dry run) and
   were not undone. A run a person undid, or edited straight after, counts against a pattern, never for it.
3. **Scripts first.** Everything it learns ends up as a file that runs without AI. The mining and the proving need no
   AI either; AI is used only to name and describe a candidate, on a monthly credit cap.
4. **The same guard.** A learned flow is held to every hard rule: dry run first, writes only to WIP and staging,
   live-model lock, never save or sync a workshared model, kit data only.
5. **It learns how, never what a professional decides** (rule 5). It may learn "how we place and tag castors"; it never
   learns a beam size, a fire rating or a demand factor. Those stay questions to the engineer.
6. **It measures flows, never people** (rule 9). Records say AI, pane, flow or schedule, and the role; scorecards are
   per flow, per tool, per rule. No count, chart or ranking is ever per person.
7. **Everything is a file, versioned and reversible.** Every library entry has a version, its evidence and its
   approver; an older version is one step back; nothing is deleted (archives only, rule 2). One switch turns the
   engine off.

## How it fits what exists
The engine adds the part that **finds and proves**. It feeds the places other plans already chose:

| Already there or designed | What the engine adds |
|---|---|
| Saved flows, run records, exchange packages, identity map (X0, `fmc_flow`) | Flows are proposed from real runs instead of written by hand |
| Lessons learned (`PLAN_MEMORY.md`, ME3: drafts in staging, promotion by kit change request) | Lessons are drafted from failure patterns, with the runs as evidence |
| Skill rules and the flag log (`PLAN_SKILLS.md`, `06_QA\Skills\FMC_Skill_Flags.csv`) | Rules are proposed from failures and back-tested, as the F-064 rules were (0 false alarms over 224 built families) |
| Recipes, batch builds, `batch_log.jsonl` (#177) | Recipe fragments and Rhino part sets (castors, grips) become a reusable parts library |
| Test findings (F-NNN in `TEST_FEEDBACK.md`) | A finding that recurs is surfaced with its runs; its fix can carry a learned rule |
| Kit change requests | Values people always choose become proposed kit defaults, never overrides (rule 7) |

## The loop
```
  do the task ──► 1 Journal ──► 2 Episodes ──► 3 Mine ──► 4 Prove ──► 5 Approve ──► 6 Library
       ▲             (every call)  (one task,    (no AI)    (replay in   (a person,   (versioned
       │                            its outcome)             dry run)     in the pane)  files)
       │                                                                                   │
       └──────── 7 Recall: the AI and the pane look in the library first ◄─────────────────┘
                 8 Scorecard: every use measured; weak entries suspended, unused ones archived
                 9 Promote: proven flows become real tool code through a PR
```

### 1 · Journal: one record of every call, in every app
Every tool call through the hub, in Revit, Rhino, Robot, Navisworks or Power BI, gets one line in a journal:

| Field | Holds |
|---|---|
| `run`, `episode`, `step` | Ids that tie calls into one task |
| `app`, `tool`, `action` | e.g. `revit`, `fmc_doc`, `ops` |
| `args` | The arguments, with paths made relative to their root and file contents replaced by a hash |
| `context` | Project type, model role, family category, Revit and kit versions (no client names in firm-wide entries) |
| `by` | `ai`, `pane`, `flow:<name>@<version>` or `schedule`, plus the role; **never a person's name** in the journal used for learning |
| `result` | ok or error, the error text, a summary of the answer, what was written (with SHA-256) |
| `checks` | Which checks ran and passed (dry run, Gate A, host test, skill flags) |
| `cost` | Duration, and tokens when an AI made the call |

Where it goes: inside a project, `01_WIP\_Exchange\Journal\YYYY-MM.jsonl` (beside X0's run records); outside one,
`%LOCALAPPDATA%\Formcraft\Journal\`. The journal is append-only, written by the server (never by the AI), and a write
that fails never stops the work. Most of this already exists in pieces: the file log, the batch log and the flow run
records. Step L0 makes it one format.

### 2 · Episodes: one task and how it really ended
An episode is the calls between a request ("build the bed's castors") and its end. Its outcome is read from evidence,
not from the AI's own claim:

| Outcome | Evidence |
|---|---|
| **Good** | Every write passed its checks, and nothing was undone or reworked within the next 30 minutes of work on that element |
| **Reworked** | A person changed the result soon after: the changes are kept as a hint of what was wrong |
| **Undone** | A person undid it, or released the old version back: it counts against the pattern |
| **Failed** | An error, or a check that failed |

### 3 · Mine: find what repeats and what fails, with no AI
A script (weekly, and on demand) reads the journals:
- **Repeated work:** the same sequence of tools, in good episodes, at least **3 times in at least 2 sessions**. Values
  that change between occurrences become variables (`${family}`, `${role}`, `${width}`); values that never change stay
  fixed. Example: the castor part set built in four beds becomes `castor_set` with variables for wheel size and
  material.
- **Repeated failure:** the same error signature (tool, action, error text with numbers removed) at least 3 times.
  Each comes with the runs before it, so the cause is visible.
- **Repeated choice:** a value people pick in a form at least 80% of the time across projects becomes a proposed
  default (as a kit change request, never a silent override).
- **Near duplicates:** a candidate that matches an existing library entry with small differences becomes a proposed
  new version of that entry, not a new one.

An optional AI pass (monthly, on a credit cap the owner sets) names each candidate, writes its one-line description
and its "use when" line. Without it, candidates get plain generated names.

### 4 · Prove: a candidate must earn its place before a person sees it
- **Replay:** the flow runs as a dry run against the episodes it came from, and must produce the same writes (same
  ops, same file hashes) as the real runs did.
- **Held out:** it also replays on one good episode it was not mined from. If it works only on its own examples, it
  is not general.
- **Guard:** every step is a Formcraft tool with a dry run, writes only where the guard allows, and touches no live
  model.
- **Rules are back-tested:** a proposed check rule runs against all past good runs (it must raise **0 false alarms**)
  and the failures it came from (it must catch them). Exactly how the F-064 rules were measured.
- **Lessons are tied to a fix:** a lesson names the runs that show the problem and, when there is one, the run that
  shows the fix working.

What fails the proof is kept with its reason, so the miner doesn't offer it again.

### 5 · Approve: a person decides, in the pane
A **Suggestions** page in the pane (Setup › Learning) lists each candidate with:
- what it is, in one line, and what kind (flow, lesson, rule, part set, default);
- the evidence: how many runs, from which projects, the replay result;
- the gain: estimated minutes and credits saved per use;
- its risk class and who may approve it;
- **Accept**, **Edit** (change variables, name, scope), or **Reject** with a reason (a rejected pattern is never
  offered again unless it changes).

| Risk class | What | Approved by (proposed; owner decides) |
|---|---|---|
| A · Read | Reports, checks, queries, renders | BIM coordinator |
| B · Write to WIP or staging | Flows that build, place, tag, export | BIM Manager |
| C · Rules and defaults | Check rules, kit defaults, firm-wide lessons | BIM Manager, by kit change request |
| D · Code | Promotion to a tool operation | The owner, by merging the PR |

### 6 · Library: versioned, scoped, readable
```
<kit>\00_Standards\_Staging\Learning\      drafts and accepted entries before release
<kit>\03_Master_Data\FMC_Learning\          the firm library, released by the BIM Manager
  flows\<name>\v3.flow.json                 the flow, with its variables and "use when"
  flows\<name>\evidence.json                the runs it came from, replay results, approver, date
  parts\<name>\                             Rhino part sets and recipe fragments
  _index.json                               every entry: kind, scope, version, status, tags
  _Archive\                                 older versions and retired entries
<project>\01_WIP\_Exchange\Flows\           project-only flows (X0 already reads these)
```
- **Scope:** project (only this project), office, or firm. A flow mined in one project starts as project scope; a
  person widens it.
- Lessons and rules go where `PLAN_MEMORY.md` and `PLAN_SKILLS.md` put them; the engine only drafts them.
- The release from staging into `03_Master_Data` is a person's act, like a family release (needs the owner's rule,
  below).

### 7 · Recall: the library first, AI second
- Before the AI plans a task, the server gives it the library entries that match the task's app, tool, family
  category and words (a tag and keyword match: no AI, no cost). The AI must say which entry it uses ("using
  `castor_set` v3") or why none fits; that line is in the journal.
- In the pane, each entry is a button, with a dry run first, and can be scheduled. This is the cheapest path of all:
  no AI at any point.
- Lessons that match load with Ask Claude's **Remembered** card (`PLAN_MEMORY.md`), so a person sees exactly what the
  AI was told.

### 8 · Scorecard: every entry earns its keep
Each entry keeps: uses, success rate, median time, credits saved (against the episodes it replaced), last use, and
failures since this version. Automatic, and always shown:
- **Suspended for review** when its success rate falls under 90% over its last 20 uses, or it fails twice in a row
  after an app or kit update.
- **Archived** after 6 months unused.
- **Re-proven** when a tool it uses changes: CI checks every library flow still fits the tools' argument shapes on
  every PR (the library "compiles"), and replays run again on the pilot PC after a Revit or kit update.

### 9 · Promote: proven flows become real code
Once a month the engine lists flows used more than 20 times in the month at 98% success or better. For each one, Claude
Code proposes a real tool operation in a PR (with tests and a stand-in for CI), and the flow is rewritten to call it.
The owner merges or doesn't. This is how the toolset grows from the firm's own work instead of from guesses.

## Across the apps
Because the hub has one identity map (X0), an episode can cross apps: Revit asks Rhino for castor parts, Rhino builds
them, Revit imports them. The miner sees that as one task and can learn it as one cross-app flow. This is where the
apps start to feel like one application: the hand-overs themselves become repeatable.

## What the engine measures about itself
Shown on the Learning page and, once Power BI is connected (H2), as a dashboard. Targets are for the owner to set:

| Measure | Why |
|---|---|
| Share of repeat tasks served by the library instead of worked out by AI | The heart of it: credits saved |
| Credits and minutes per task, per kind of task, month by month | The cost curve |
| First-time-right rate (good episodes over all episodes) | Quality |
| Undo and rework rate | Whether the AI's work can be trusted |
| Candidates proposed, accepted, rejected; entries suspended | Whether the engine itself is useful or noisy |

## What could go wrong, and the guard for each
| Risk | Guard |
|---|---|
| A wrong habit is learned | Only good episodes count; undone and reworked ones count against; replay and a held-out test before anyone sees it |
| Silent self-change | Rule 1: nothing is used without a yes; code only through PRs |
| A learned flow damages a model | It runs through the same guard as any tool; dry run first; risk class B and above need the BIM Manager |
| Clutter | Near-duplicates become versions; rejections are remembered; unused entries are archived |
| One project's quirk becomes firm law | Project scope first; a person widens it |
| Client data leaks into the firm library | Firm entries hold no client names, paths are made relative, file contents are hashes |
| It drifts into professional judgement | Values that belong to an engineer are never learned or defaulted (rule 5) |
| It is used to judge people | No personal names in learning data; no per-person counts (rule 9) |
| It costs more than it saves | Mining and proving need no AI; the naming pass has a monthly cap; the scorecard shows credits saved against spent |

## Steps (one PR each, the owner's yes before each)
| Step | What | Done when |
|---|---|---|
| **L0** | **Journal and episodes:** one format for every call in every app; outcomes from evidence (checks, undo, rework) | A week of real work gives complete episodes with true outcomes |
| **L1** | **Lessons from failures:** repeated error signatures drafted as lessons into ME3's staging; recalled in Ask Claude | The F-065 sweep failure would have been drafted as a lesson from its runs |
| **L2** | **Miner and proof for flows** (no AI): repeated sequences become candidate flows with variables; replay and held-out tests | The four detailed families' builds yield a proven candidate (e.g. the castor part set) |
| **L3** | **Suggestions page and the library:** accept, edit, reject; versions, scopes, archive; release by the BIM Manager | A person accepts a flow and it runs from a button with no AI |
| **L4** | **Recall:** the AI gets matching entries before it plans and says which it uses | The journal shows library use on repeat tasks |
| **L5** | **Rules and defaults:** back-tested rule candidates into the skill packs; repeated choices into kit change requests | A rule with 0 false alarms is proposed with its evidence |
| **L6** | **Scorecard, suspension, re-proof, the library compiles in CI** | A broken entry is suspended by itself after a tool change |
| **L7** | **Parts library:** Rhino part sets and recipe fragments reused across families | A new bed family takes its castors from the library |
| **L8** | **Promotion:** the monthly harvest; Claude Code's PRs for proven flows | One flow becomes a tool operation |
| **L9** | **Dashboard** in Power BI (after H2) | The cost curve is visible month by month |

L0 and L1 are cheap and pay back first. L2 and L3 are the core. The rest follow as the library grows.

## For the owner to decide
1. **Yes or no to this plan**, and to step L0.
2. **Who approves each risk class** (the table in section 5 is a proposal).
3. **The release rule:** like the family release (rule 2's exception), a person's Release moves a library entry from
   `00_Standards\_Staging\Learning\` into `03_Master_Data\FMC_Learning\`. This needs your wording.
4. **The thresholds:** 3 repeats in 2 sessions to propose; 90% over 20 uses to stay active; 6 months unused to archive;
   20 uses a month at 98% to promote.
5. **The credit cap** for the monthly naming pass (or none: plain generated names).
6. **Where the journals of non-project work live:** per PC (proposed) or shared.
