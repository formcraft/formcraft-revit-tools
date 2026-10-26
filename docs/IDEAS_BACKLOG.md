# Ideas: what would make Formcraft the best plugin (19 October 2026)

**Status: ideas, not plans.** Each becomes a plan with the owner's yes before any code. The owner's direction: the best
plugin, built for value (worth it, not cheapest), scripts first, a person decides. The plans already approved come
first: the recipe tree (`PLAN_RECIPE_TREE.md`), Mark & Review (`PLAN_MARK_REVIEW.md`), the learning engine
(`PLAN_LEARNING_ENGINE.md`), the engineering hub (`PLAN_ENGINEERING_HUB.md`).

## The five that would set it apart most
| # | Idea | Why it matters |
|---|---|---|
| 1 | **Picture checks for every family** | Every build renders the family at Coarse, Medium and Fine and compares it with the last good picture; a part that moved, vanished or grew is flagged before anyone looks. F-067 (a bed 1.1 m off its envelope) was found only from a picture: this finds it every time, automatically |
| 2 | **Room data sheets, two-way** | Hospitals are run on room data sheets (HBN). The brief's room data sheet sets what each room must hold; the model is checked against it continuously ("ICU Bay 03: 1 of 2 O2 outlets"), and the sheet is printed from the model. Few tools do this inside Revit |
| 3 | **Live compliance while modelling** | The skills packs (`PLAN_SKILLS.md`) checked as you work: Uganda Building Control, accessibility, HBN clearances; a flag on the element, with the clause, never a block |
| 4 | **Options side by side** | Two or three versions of a room, floor or façade from the recipe tree, compared on area, cost (the BoQ from `fmc_build`), compliance and daylight, before choosing one |
| 5 | **A client review page** | A web page with the 3D model (glTF from Revit), viewpoints and room sheets; the client clicks and leaves voice or text notes, which arrive as Mark & Review tickets. No Revit or licence on their side |

## Modelling and design
- **Service zones reserved by design:** room and corridor recipes keep ceiling-void zones for each system, so MEP
  recipes route inside them and clashes are avoided before they exist.
- **Sheets and views from the tree:** every room recipe makes its elevations, RCP and room sheet; a changed room updates
  its sheets.
- **Datasheet to kit:** drop a manufacturer's PDF; the values are read offline, shown with their page, and become kit
  values only after a person verifies them (source status `verified`).
- **Concept in Rhino, building in Revit:** a massing in Rhino becomes the building node of the recipe tree.
- **Product photo to family:** the healthcare pack already models from photos; make it a tool: photos and a datasheet
  give a first recipe for review.

## Quality and trust
- **Flex fuzzing at night:** every family flexed through random sizes within its ranges; failures become findings.
- **A model time machine:** the recipe tree's history per day: what changed, by whom (or the AI), with one-click revert.
- **Model health on one screen:** file size, warnings, in-place families, purgeable items, unplaced rooms, open tickets,
  with the fix for each.
- **Signed issues:** every issued sheet set carries the checks it passed and the open exceptions, so an issue can be
  audited later.

## Collaboration
- **Mark & Review on a phone:** a site walk with viewpoint pictures; notes recorded on the phone land in the register.
- **A morning card:** what the AI and the night runs did, what waits for whom, which gates failed; made offline.
- **BCF everywhere:** consultants on other software exchange tickets without the plugin.

- **Master and worker windows (owner, 26 Oct):** several Revit windows (people or AI threads) each produce their change
  set as a recipe; the master window replays it in one transaction after review, so work merges without worksharing.
  AI work is already tool calls (recipes), so an AI worker never touches the master file. Hard part: turning a person's
  manual edits into a recipe. Builds on the recipe tree, the hub's identity map and the approval queue.

## The hub
- **Power BI:** live dashboards of quantities, cost, tickets and gates (H2).
- **4D from the tree:** the recipe tree's build order becomes a Navisworks timeline.
- **Robot round trip:** analysis results back into the families' parameters, with the engineer's sign-off.

## The business
- **Recipe packs:** a hospital ward pack, a clinic pack, an East African kit, sold or licensed as packages that
  regenerate to any site.
- **The kit as the moat:** every project grows the recipe library; the value is the firm's own standards, not just
  the software.
- **Onboarding in the pane:** guided first runs, a sample project, and touch-friendly review for site and client use.
