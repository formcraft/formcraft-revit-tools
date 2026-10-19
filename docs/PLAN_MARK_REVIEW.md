# Plan: Mark & Review (Formcraft Flow › Review)

**Status: Approved, 19 October 2026 (owner's yes).** Steps R1–R6, one PR each. It folds in the owner's clash-list request
(Navisworks clashes into a pane list; a click selects, zooms and opens a section box around the clash).

## The idea
Anyone (the owner, a team member, a consultant, the AI) points at the model and says what is wrong: a click on an
element, several elements or a bare point, a drawn arrow, a measured dimension, a typed note or **a voice note**. The
mark becomes a **ticket** in the project's review register, addressed to the **AI modeller**, **a person or a
discipline**, or **anyone**. The AI fixes its tickets through a dry run and a person's yes; people fix theirs; the
person who raised a ticket closes it. Navisworks clashes arrive as the same tickets, so there is one list of everything
the model needs.

## Rules
1. **Marking never changes the model.** Pins are drawn on screen (Revit's DirectContext3D), never as elements; the
   register is a file in `01_WIP\_Reviews`. So people mark up live and shared models safely, while others work.
2. **Best value, not cheapest (owner):** offline or a script where it is as good; a paid service or the AI where it
   clearly gives a better result. Voice is transcribed on the PC with a model good enough to trust; common requests
   are parsed and fixed by script; what needs thinking goes to the AI, with everything attached.
3. **A person decides.** Every fix is a dry run first; the AI never closes its own ticket; Critical tickets block a
   family's release and warn an issue set.
4. **Rule 9:** tickets show who raised and who owns them (the work needs that); no scores, no per-person counts.
5. **Interoperable:** tickets go out and come in as **BCF** (2.1 and 3.0), the industry markup format (Navisworks,
   Solibri, BIMcollab, Autodesk Construction Cloud).

## A ticket
| Field | Holds |
|---|---|
| `id`, `title`, `status` | `T-0042`; Open → In progress → Fixed: check → Closed (or Reopened) |
| `to` | `ai`, a person, a discipline, or `anyone`; `raised_by`, `owner`, `lead_discipline`, `priority`, `due` |
| `where` | element UniqueIds (and linked-model ids), a point (mm), the view, the camera, the section box |
| `what` | the text; the audio file; its offline transcript; drawn strokes (picture and model-space hint); measured dimensions |
| `intent` | what the offline parser understood: `set_param`, `move`, `resize`, `swap_type`, `delete`, `add_clearance`, `material`, or `unclear` |
| `pictures` | the view with the pin when raised; before and after when fixed |
| `thread` | replies (text or voice), each with its time and author |
| `links` | the recipe node that made the element (recipe tree), the clash (Navisworks), the family (Gate A) |

## Voice, offline
`whisper.cpp` (MIT licence) ships with the plugin and runs on the PC's processor. The default is the **small** model
(about 470 MB, downloaded once): clearly more accurate than the base model on site English and accents, and still free
to run; the **medium** model is an option for PCs with the memory. English and Swahili transcribe well; Luganda is weak,
so **the audio is always kept**, and a cloud transcription is an option per note when the local one isn't good enough.
Notes are recorded in the pane (Opus, small files) and transcribed in the background.

## The offline parser (no AI for common requests)
A small grammar for what people actually say: "make it 1200 wide", "move it 300 left", "raise to 2700", "change to
1026 single", "wrong material, use stainless", "delete this", "needs clearance", "same as the other one". Units and
directions are read relative to the view. A parsed ticket becomes a structured fix that runs as a script (dry run, yes,
apply). What it can't parse is `unclear` and goes to the AI with everything attached.

## Making it the best of its kind
- One click on a ticket restores its view, camera and section box, and selects and isolates its elements.
- Draw on the view (an arrow: "move it here"); click two points to attach a real measurement.
- Threads by voice or text; before-and-after pictures at fix time.
- Clashes and marks in one queue; filter by status, discipline, level, room, model.
- Gate A and the issue check read open tickets.
- Later: a web page of viewpoint pictures for site walks and client reviews; a note recorded on a phone lands in the
  same register.
- Every closed ticket is evidence for the learning engine (`PLAN_LEARNING_ENGINE.md`): repeated corrections become
  rules or recipe fixes.
- With the recipe tree (`PLAN_RECIPE_TREE.md`) a ticket's fix changes **the recipe node** that made the element, so it
  survives every rebuild.

## Steps
| Step | What | Needs Revit to test |
|---|---|---|
| R1 | The ticket format; `fmc_review` actions for the fix queue, threads and statuses; BCF export and import | No |
| R2 | The pane's Review board; voice recording; offline Whisper transcription | No (pane mock tests) |
| R3 | The offline note parser; structured fixes as scripts (dry run first) | Partly |
| R4 | The Revit Mark tool: click capture (elements, point, box), pins, view restore, pictures | Yes |
| R5 | Navisworks "Send to Revit": clashes into the same queue; select, zoom and the section-box view | Yes |
| R6 | The AI's fix queue: dry run, a person's yes, "Fixed: check it" | Yes |
