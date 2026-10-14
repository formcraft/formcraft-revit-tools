# Ideas: making Formcraft easy to use, and spreading BIM across East Africa

Written 14 October 2026, after the first full review pass (PR #80). These are proposals, not decisions: each one needs
the owner's yes before it goes on the roadmap.

## Very easy to use

1. **One-click install, no setup.** Bundle Node.js inside the add-in and code-sign it, so Revit's "unsigned add-in"
   warning disappears. Add pilot and stable update channels. Installing should take two minutes, with no admin help.
2. **A "Today" home page.** Opening the pane shows one traffic light per open model, the three things that need
   attention, and one button for each. Today a person has to know which section to open.
3. **Plain language first.** Rule numbers, Manual references and parameter names move behind a "Why?" link. Every page
   starts with one big action, such as "Check this model", with the details below.
4. **A guided first project.** Kit, folders, template, levels from the brief, sheets and the first QA in one flow of
   about 10 minutes, ending with "your project is ready".
5. **Built-in lessons.** Short guided tours inside the pane, with a certificate at the end, so people learn on the job.

## Spreading BIM in East Africa and beyond

6. **Local permit packs.** One button that produces the drawing set and checklist a city authority asks for (KCCA,
   Nairobi County, Dar es Salaam, Kigali). Faster permits is the reason firms will adopt BIM.
7. **Local BOQ and rates.** The kit's codes are already local (blockwork, hoop iron). Add UGX, KES and TZS rates from
   the QS institutes, so Build gives a priced BOQ from the model.
8. **Swahili and French** in the pane and in Ask. French covers Rwanda, Burundi and the DRC. Ask could also answer in
   Luganda.
9. **Phone-first for everyone outside the office.** Progress pictures and the coloured model shared through WhatsApp.
   A site update sent as a phone photo comes back as a pending status change that a person approves. Most contractors
   and clients don't have Revit, but they have phones.
10. **Pricing that fits the market.** Mobile-money payment (MTN MoMo, M-Pesa), monthly seats, and free use for
    students and universities (Makerere, Nairobi, Ardhi). Students who learn on Formcraft carry it into firms.
11. **Works on modest hardware and patchy internet.** Offline first, light on memory, with Flow touch on cheap Windows
    tablets.
12. **An open kit format for the world.** Publish the CIS, rulebook and code schemas so other countries can make their
    own kits. Formcraft becomes the platform, and each country brings its own standards.

## Complete BIM: Navisworks, Robot, clashes, MEP and the Project Browser

Added 14 October 2026. The owner chose Navisworks Manage and Simulate, and Robot Structural Analysis.

13. **One hub, several apps.** Formcraft's MCP server stays the single hub. Navisworks and Robot become connectors
    behind the same rules: the live-model lock, writes only to WIP and staging, dry runs, the log, and the kit as the
    source of truth. The multi-Revit routing grows from "which Revit" to "which app". Data moves as kit-controlled files
    (NWC and IFC to Navisworks, the analytical model to Robot), and results come back into kit fields.
14. **AI that fixes clashes, with toggles.** The loop:
    1. Navisworks Manage detects the clashes.
    2. AI sorts them: real or tolerable, and who owns each one.
    3. AI proposes a fix in Revit as a dry run, with before and after views.
    4. The fix is applied in the owning discipline's WIP model.
    5. Navisworks re-runs that clash test, and the clash closes or goes to a person.

    The toggles, set per project by the BIM Manager and per clash type:

    | Level | What AI may do |
    |---|---|
    | Off | Nothing; people handle every clash |
    | Suggest | Proposes a fix; a person does the work |
    | Fix with approval | Prepares the fix as a dry run; one click approves the batch |
    | Auto in WIP | Fixes small, safe clashes in a WIP copy, then reports |

    Hard limits whatever the toggle says:
    - AI never moves structure, grids, levels or anything marked as fixed.
    - It never touches the shared or published model, and it never syncs.
    - Structural openings and sleeves need the engineer's yes.
    - What it may fix: MEP against MEP (small offsets and reroutes), small fixtures, and sleeve proposals.

    **Needs a decision first:** the live-model lock blocks every AI edit on project models today (Manual Part 18). Clash
    fixing needs a new, narrow permission, an "AI assistant modeller" role: a list of allowed operations, on the owner's
    own WIP copy, with a log line for every change. It goes in the Manual before it is built.
15. **The Formcraft pane inside Navisworks.** The same pane, with the same code and look, docked in Navisworks Manage
    and Simulate:
    - Federate the latest models from `02_Shared`
    - Clash tests from a kit clash matrix (which pairs of disciplines to test, and with what tolerances)
    - 4D with TimeLiner
    - Clashes into Manage › Review as review items with viewpoints
    - "Show in Revit"

    Navisworks never edits the Revit models.
16. **Robot made simple.** Robot's API can be driven from outside Robot, so the work is a guided Structural workflow in
    the Revit pane, in plain steps:
    1. Check the analytical model (already built).
    2. Send it to Robot.
    3. The engineer enters the loads and the design code, in a form in the pane.
    4. Run the analysis.
    5. Results come back into the kit's `FMC_FEA_` fields, with the differences listed.

    A small Formcraft window inside Robot covers the steps that must happen in Robot itself. The AI never chooses loads
    or sizes and never changes a section: the registered engineer decides and signs.
17. **Project Browser editing (Manage).** Tools for Revit's Project Browser:
    - arrange views and sheets by the kit's browser structure
    - rename views in bulk to the naming standard, with a dry run first
    - an Excel-like table to edit views, sheets and family parameters together
    - find views not on any sheet
    - clean out unused views (dry run, one Undo)
18. **MEP through the MCP connection.** The family builder (B1) already builds MEP families with connectors from the
    kit's specs. Next steps:
    - build families from a manufacturer's datasheet PDF, then flex-test them and save to staging
    - draft MEP layouts in WIP models: lights from the room's `FMC_Lux_Target`, sockets from the room programme, then
      circuiting
    - route pipes and ducts between connectors, then size them once the Electrical parameters are in the kit

    All of it in WIP, with a dry run first, and a person approves. This restarts the parked B2 work.
19. **Rendering and open BIM.**
    - No MCP was found for Enscape, Twinmotion, D5, V-Ray or Lumion. Blender (free) and Unreal Engine have community
      MCP servers, so Blender is the automated route: overnight renders of chosen views with the kit's materials.
      Enscape stays for interactive work in Revit.
    - IFC and IDS checking against the kit's `07_IFC_IDS`.
    - Speckle as the model viewer on phones and tablets.
20. **A Formcraft keyboard shortcut standard.**
    - Keep Revit's well-known defaults, and add mnemonic keys for frequent commands that have none.
    - Give keys to Formcraft's own buttons too.
    - Built from one export of Revit's Keyboard Shortcuts, so the command names are exact and nothing clashes.
    - It goes into the kit once approved.

Suggested order: Navisworks clashes into Review, then the Robot workflow, Project Browser editing, IFC/IDS checking,
Blender renders, and Speckle.

## Keeping it reliable

21. Run `tests/e2e` in CI, with a small sample kit stored in the repo.
22. Add a weekly smoke test in a Revit 2025 virtual machine, driven by a Revit journal file, to cover what the fake
    Revit can't (transactions, Undo, view filters, the ribbon).
23. Officially support Revit 2025 and 2026 only for now, and say so in the installer.

## Waiting on a decision

- FormCraft Electrical writes 16 FMC_ parameters the kit doesn't have: add them to the kit, or rename them.
- The CIS format: approve `fmc-cis/0.1` (docs/CIS.md), or put a format in the kit.
- The kit has no keyboard-shortcuts file: one export of Revit's Keyboard Shortcuts starts it (idea 20).
- An "AI assistant modeller" role in the Manual before clash fixing is built (idea 14).
- Where prints and reports go (01_WIP or 06_QA), and the revision and status code lists (MAN 4.4).
