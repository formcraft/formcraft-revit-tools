# Ideas: a Formcraft that anyone can use, and that spreads BIM across East Africa and the world

These are proposals, not decisions. Each one needs the owner's yes before it goes on the roadmap. The first version was
written on 14 October 2026 after the first full review pass (PR #80). This version adds depth to every idea and covers
the areas the first one left out.

**How to read it.** Each idea says:
- what it is
- why it matters
- **Builds on**: what Formcraft already has that makes it possible
- **Size**: **S** (days), **M** (one to three weeks) or **L** (a month or more)
- **First step**: the smallest useful thing to do first

The vision in one sentence: a modeller in Kampala, a QS in Nairobi or a site engineer in Kigali opens Formcraft, sees
what needs doing today, and gets it done properly, with AI doing the repetitive work and a person deciding.

---

## A. The first five minutes

People decide in the first five minutes whether a tool is for them. Today Formcraft asks too much of them up front.

1. **One-click install, no setup.** Bundle Node.js and the server inside the add-in, so nothing else needs installing.
   Code-sign the add-in, so Revit's "unsigned add-in" warning disappears. Add pilot and stable update channels, with
   the updater you already have, and roll back in one click if a build misbehaves.
   **Builds on:** the updater (`fmc-update.ps1`), the build stamp, the self-test.
   **Size:** M.
   **First step:** a signing certificate, and a bundled Node runtime in the build output.
2. **A "Today" home page.** Opening the pane shows each open model with a traffic light, the three things that need
   attention ("2 sheets not ready to issue", "4 clashes assigned to you", "sync overdue"), and one button for each.
   Today a person has to know which section to open.
   **Builds on:** the self-test, QA history, the review register, the sync log, the multi-Revit registry.
   **Size:** M.
   **First step:** a read-only Today page built from the files the plugin already saves.
3. **Plain language first, details on request.** Every page starts with one big action ("Check this model", "Get
   sheets ready to issue"), then the result in a sentence. Rule numbers, Manual references and parameter names move
   behind a "Why?" link.
   **Builds on:** the SectionPage pattern, so it is one change to the templates and then each page's text.
   **Size:** M.
   **First step:** rewrite three pages (QA, Issue, Build) and test them with someone who has never seen Formcraft.
4. **A guided first project.** One flow of about 10 minutes, ending with "your project is ready":
   - pick the kit, and name the project
   - make the folders, and start the models from the templates
   - set up the levels and rooms from the brief
   - make the sheets, and run the first QA

   **Builds on:** Setup › Project, Templates, Start from brief, Sheets, QA. Every step exists; this joins them.
   **Size:** M.
   **First step:** a wizard that calls the existing tools in order, with a dry run at each step.
5. **Role-based panes.** A QS, a modeller, a site engineer and a BIM Manager need different things. The pane opens
   with the sections each role uses, and the rest are one click away. The roles already exist in Admin.
   **Builds on:** Admin roles and permissions, the parts switches.
   **Size:** S.
   **First step:** a default parts set per role.
6. **Errors that say what to do.** Every refusal names the problem and the next step, and has a button for it where
   possible ("Revit isn't connected: **Turn on the AI connection**"). Most already say the reason; few offer the fix.
   **Builds on:** the refusal messages, the self-test.
   **Size:** S.
   **First step:** list the ten most common refusals from the log, and add a fix button to each.
7. **Built-in lessons and tours.** Short guided tours inside the pane, one per section, with a check at the end and a
   certificate for the Manual's training programmes (18.3). People learn on the job, in the tool they use.
   **Builds on:** the first-run tour setting, the Manual's training programmes and competency levels.
   **Size:** M.
   **First step:** a tour for the modeller induction (Part 18.3, week 1).
8. **Help in context.** A "?" on every group opens the matching Manual section, at the right paragraph, in the pane.
   **Builds on:** the Manual PDF, the help button.
   **Size:** S.
   **First step:** a map from each section and group to its Manual page.

## B. Daily work in Revit

9. **Project Browser editing (Manage).** Tools for Revit's Project Browser:
   - arrange views and sheets by the kit's browser structure
   - rename views in bulk to the naming standard
   - an Excel-like table to edit the names and parameters of views, sheets and families together, with filters, copy
     and paste, and fill down
   - find views not on any sheet, and unused views, schedules and legends, and clean them out

   Every change is a dry run first and one Undo.
   **Builds on:** the sheets and naming rules, the dry-run pattern.
   **Size:** M.
   **First step:** a read-only table of every view and sheet, with naming problems marked.
10. **A Formcraft keyboard shortcut standard.** Keep Revit's well-known defaults, and add mnemonic keys for frequent
    commands that have none and for Formcraft's own buttons. Built from one export of Revit's Keyboard Shortcuts, so
    the command names are exact and nothing clashes. The Settings › Flow button then backs up each person's own keys,
    merges their extras and opens Revit's import. It goes into the kit once approved.
    **Builds on:** Settings › Flow › Keyboard Shortcuts.
    **Size:** S.
    **First step:** the owner exports Revit's shortcuts file.
11. **Ready before sync.** One button runs the "Before sync" automation and writes the sync comment:
    - the self-test, the QA gate and the workshare check
    - the sync message in the fixed format

    A person then syncs.
    **Builds on:** automations, the workshare sync message, the sync log.
    **Size:** S.
    **First step:** a "Before sync" button on the Today page.
12. **Ask anywhere.** Ask can already read the model. Phase 2: Ask proposes a change, and the pane turns it into the
    normal dry run, approve, run, verify, log. "Tag all the doors on this sheet" becomes a dry run you approve. Ask
    also explains: "why is this sheet not ready to issue?"
    **Builds on:** Ask (U27), every section's dry run.
    **Size:** M.
    **First step:** let Ask call the read-only checks (QA, Issue, Systems) and explain their results.
13. **Gentle reminders.** A quiet note in the pane for the things the Manual asks for on a rhythm:
    - sync after two hours
    - the weekly report on Friday
    - a review item overdue
    - a model not checked since its last change

    Each one is set by the person, and never a pop-up over Revit.
    **Builds on:** Settings (the reminder settings exist), the review register, QA history.
    **Size:** S.
    **First step:** the sync reminder.
14. **Touch on site tablets.** Flow touch already works in Revit 2025. Add a "site mode": large buttons, the Today
    page, issues with photos, and model walk-throughs. It works on a cheap Windows tablet in a site office.
    **Builds on:** Flow touch, the Review section.
    **Size:** M.
    **First step:** a site-mode layout of the pane at tablet size.

## C. AI that does the work, with a person deciding

The rule throughout: AI does the repetitive work; a person decides and answers for it; nothing reaches a shared model
without a person. The AI-assisted modeller (see [AI_ASSISTED_MODELLER.md](AI_ASSISTED_MODELLER.md)) is the permission
that makes this possible on live projects.

15. **The AI-assisted modeller.** A narrow, supervised permission. It makes listed, small, reversible changes in a
    person's own WIP copy of a model, at an autonomy level the project chooses:
    - **Off**
    - **Suggest**
    - **Fix with approval**
    - **Auto in WIP**, for the safest operations only

    The limits: never structure, grids, levels or coordinates; never a shared model; never a sync. Every batch is
    logged with before and after values.
    **Builds on:** the live-model lock, guard parity, dry runs, the log.
    **Size:** M, after the Manual change is approved.
    **First step:** approve the change request.
16. **The clash loop.**
    1. Navisworks Manage detects the clashes.
    2. AI sorts them: real or tolerable, and who owns each one.
    3. AI prepares a fix in the owner's WIP model, as a dry run with before and after views.
    4. The author approves, or it runs automatically at "Auto in WIP".
    5. Navisworks re-runs that clash test.
    6. The clash closes, or goes to a person with the reason.

    Clashes that need a design decision (structure, openings) are never fixed, only explained.
    **Builds on:** the AI-assisted modeller, the Review register, multi-app routing (idea 26).
    **Size:** L.
    **First step:** clashes into Review as items with viewpoints, with no fixing yet.
17. **Data filling.** Most QA failures are missing data: codes, keynotes, statuses, Project Information. AI fills them
    from the master data, flags every guess as a guess, and leaves blanks blank where it can't be sure. This is the
    safest AI work there is, and probably the most hours saved.
    **Builds on:** the kit's master data, QA rules, the "Data" group of the AI-assisted modeller.
    **Size:** M.
    **First step:** "Fill from master data" on QA failures of the kind "type parameter empty".
18. **Drawing production.** The repetitive half of documentation, each step a dry run:
    - make the sheets from the register
    - place the views on them
    - apply the view templates
    - tag everything that should be tagged
    - tidy the tags
    - get the sheets ready to issue

    **Builds on:** Sheets, Annotate, Flow Tag Tidy and Sheet Layout, Issue.
    **Size:** M.
    **First step:** "Place views on sheets" from the register's view list.
19. **MEP layouts drafted by AI.** In WIP models, as a starting point for the engineer:
    - lights placed from each room's lux target (`FMC_Lux_Target`)
    - sockets from the room programme
    - circuits from the boards
    - pipes and ducts routed between connectors

    The engineer checks and owns it.
    **Builds on:** the family builder, Systems, the room programme from the brief.
    **Size:** L.
    **First step:** lights from the lux target in one room type.
20. **Families from a datasheet.** Drop in a manufacturer's datasheet PDF. AI reads the dimensions, connectors and
    parameters, writes the build steps, and the family builder makes the family, flex-tests it and saves it to
    staging for the Family Librarian.
    **Builds on:** the family builder (B1: the water heater, 39 steps from the kit spec), the kit's family specs.
    **Size:** M.
    **First step:** one PDF to one step list, compared by hand with the kit spec.
21. **The review assistant.** AI summarises the review register for the weekly meeting: what's new, overdue and
    solved, and who's waiting on whom. Counted per model and discipline, never per person (14.5). It drafts the
    minutes, and the chair edits them.
    **Builds on:** the review register, Reports.
    **Size:** S.
    **First step:** a "Meeting summary" report kind.
22. **Brief compliance.** After Start from brief, AI compares the model's rooms and areas with the brief, room by
    room, and lists every difference: "Study is 10.4 m², brief says 12 m² minimum".
    **Builds on:** Start from brief, the room data.
    **Size:** S.
    **First step:** a QA rule kind "room area against the brief".

## D. Complete BIM: one hub, every app

23. **Navisworks Manage and Simulate, with the Formcraft pane inside.** The same pane, code and look, docked in
    Navisworks:
    - Federate the latest models from `02_Shared`
    - Clash tests from a kit clash matrix (which pairs of disciplines to test, and with what tolerances)
    - 4D with TimeLiner, linked to the programme
    - Quantification for the QS
    - Viewpoints into Review
    - "Show in Revit", which selects the clashing elements in the right model

    Navisworks never edits the Revit models.
    **Builds on:** the shell (any WPF host), the server's tool pattern.
    **Size:** L.
    **First step:** a Navisworks add-in that reports the federated models and runs one clash test.
24. **Robot made simple.** Robot's API can be driven from outside Robot, so the work happens in a guided Structural
    workflow in the Revit pane:
    1. Check the analytical model (built).
    2. Send it to Robot.
    3. The engineer enters the loads and the design code, in a plain form.
    4. Run the analysis.
    5. Results come back into the kit's `FMC_FEA_` fields, with the differences listed (built).

    A small Formcraft window inside Robot covers what must happen there. The AI never chooses loads or sizes and never
    changes a section; the engineer decides and signs.
    **Builds on:** Engineer › Structural, the kit's FEA fields.
    **Size:** L.
    **First step:** read a finished Robot model's results back into Revit.
25. **IFC and IDS checking.** Check every model before issue against the kit's IDS files (`07_IFC_IDS`), with the
    open-source IfcOpenShell. Clients and government projects increasingly ask for IFC; this proves the model meets
    their information requirements.
    **Builds on:** Issue's Ready to issue check, the kit's IDS folder.
    **Size:** M.
    **First step:** export IFC from a test model and run one IDS file against it.
26. **One hub, many apps.** Formcraft's MCP server stays the single hub. Each app (Revit, Navisworks, Robot, a
    renderer) is a connector behind the same rules: the lock, write roots, dry runs, the log and the kit. The
    multi-Revit routing grows from "which Revit" to "which app". Data moves as files the kit controls (NWC, IFC, the
    analytical model, glTF), and results come back into kit fields.
    **Builds on:** multi-Revit routing (PR #73), the guard.
    **Size:** M.
    **First step:** an `app` target beside `revit` in the routing.
27. **Rendering.** No MCP server was found for Enscape, Twinmotion, D5, V-Ray or Lumion. Blender (free) and Unreal
    Engine have community MCP servers.
    - **Blender, for automated work:** overnight renders of chosen views with the kit's materials, on one office PC.
    - **Enscape, for interactive work** with clients in Revit.

    Both follow the Manual's honest presentation rule (9.9).
    **Builds on:** the materials section, the kit's brand assets.
    **Size:** M.
    **First step:** one Revit view exported to Blender and rendered with a kit material.
28. **Speckle for phones and the web.** Speckle (open-source) shows the model on any phone or tablet. Clients,
    contractors and site staff see the model, progress colours and issues without a Revit seat.
    **Builds on:** Build's progress and package colours, Review.
    **Size:** M.
    **First step:** send one model to a Speckle server and open it on a phone.
29. **Programmes: MS Project and Primavera.** Link each task to model elements through `FMC_Task_ID` (the kit has it),
    so 4D in Navisworks, progress in Build and the S-curve in Reports all come from one programme.
    **Builds on:** the kit's time and procurement parameters, Build.
    **Size:** M.
    **First step:** read a programme export and count which elements each task covers.
30. **Power BI dashboards.** The Manual already defines the measures (Part 13.4). Formcraft's tidy CSVs (Reports,
    Build, QA history) feed a ready-made dashboard for each project and for the firm.
    **Builds on:** Reports' CSV for Power BI, the Manual's DAX measures.
    **Size:** S.
    **First step:** a Power BI template that reads the Reports CSV.

## E. Construction, site and handover

31. **A priced BOQ from the model.** Build measures by the kit's codes today. Add:
    - the QS's approved rates (behind the rates permission)
    - PC and provisional sums
    - waste factors (the kit has `FMC_Waste_Factor`)
    - an Excel BOQ in the firm's template, with an audit sheet that traces every line to element IDs (as
      `fmc_boq_build.py` does)

    **Builds on:** Build, the kit's codes and rates fields, the kit's BoQ builder.
    **Size:** M.
    **First step:** run the kit's `fmc_boq_build.py` on Build's export.
32. **Valuations and variations.** Compare the model at two dates: what was added, removed and changed, priced. That
    is the basis of an interim valuation and of every variation claim.
    **Builds on:** Build's baseline and change flags.
    **Size:** M.
    **First step:** a priced "changed since the baseline" report.
33. **Site progress from a phone.** A site engineer takes a photo, picks the zone and sets the status. It arrives as a
    pending change to `FMC_Construction_Status`; the PM approves, and the model, the progress view and the S-curve all
    update.
    - WhatsApp is how site teams talk, so progress pictures and reports go out that way too.
    - Nothing reaches the model without approval and one Undo.

    **Builds on:** Build, the progress colours, the approval pattern.
    **Size:** L.
    **First step:** a CSV of status changes, imported with a dry run.
34. **Procurement tracking.** Packages from `FMC_Trade_Package`, with each package's status, lead time and PO
    reference (all in the kit), shown on the model and in a tender register.
    **Builds on:** Build's packages, the kit's procurement fields.
    **Size:** M.
    **First step:** a packages table with lead times and the earliest required date.
35. **Handover and asset data.** At handover the client gets the asset register, operation data and the as-built
    model (Manual Part 15.5), checked for completeness. COBie is one output format.
    **Builds on:** QA rules, the IFC/IDS check, the kit's asset parameters.
    **Size:** L.
    **First step:** a "handover readiness" QA gate.
36. **Digital twin for facilities.** After handover, the model becomes the building's record: rooms, assets and
    maintenance dates, viewed on the web. That's a service the firm can sell after the project ends.
    **Builds on:** handover data, Speckle.
    **Size:** L.
    **First step:** one building's asset data shown on a Speckle model.

## F. East Africa

37. **Permit packs.** One button produces the drawing set, forms and checklist a city authority asks for:
    - Uganda: KCCA and municipal councils, under the Building Control Act 2013 (the Manual already covers authority
      submissions)
    - Kenya: Nairobi County's e-permit
    - Tanzania: Dar es Salaam
    - Rwanda: Kigali's BPMIS

    Faster permits is the reason firms adopt BIM.
    **Builds on:** Issue, the sheet register, the title blocks.
    **Size:** M per authority.
    **First step:** KCCA's checklist as a QA rulebook, then the set from Issue.
38. **Local rates and products.** Add UGX, KES, TZS and RWF rates from the QS institutes, and families of local
    products, so the model prices like a local job and specifies what's on the market:
    - the kit's codes are already local (blockwork, hoop iron)
    - local manufacturers' roofing, blocks, tiles, cement and steel

    **Builds on:** the master data, the family library.
    **Size:** M.
    **First step:** one rates sheet per country, and ten local product families.
39. **Swahili and French.**
    - The pane in Swahili (all of East Africa) and French (Rwanda, Burundi, the DRC).
    - Ask answers in the language it's asked in, including Luganda.
    - Plain English first makes translation easy.

    **Builds on:** the plain-language rewrite (idea 3).
    **Size:** M.
    **First step:** move the pane's text into resource files.
40. **Works on modest hardware and patchy internet.**
    - Offline first: the licence already allows offline days.
    - Light on memory.
    - Updates that resume after a dropped connection.
    - Nothing needs the cloud during work.

    **Builds on:** the licence's offline days, the updater.
    **Size:** S.
    **First step:** test the whole flow with the network unplugged.
41. **Climate-aware design checks.** QA rules for the region's climate:
    - daylight ratios (the kit has `FMC_Daylight_Ratio_pct`)
    - cross-ventilation
    - roof overhangs
    - rainwater harvesting volumes
    - solar PV on the roof area

    Good design for the tropics, checked in the model.
    **Builds on:** QA rulebooks, room data.
    **Size:** M.
    **First step:** a daylight-ratio rule from the room data.
42. **Universities and students.**
    - Free student licences.
    - A course built on Formcraft's lessons and the Manual's training programmes, with Makerere, Nairobi, Ardhi and
      the University of Rwanda.
    - Graduates who learned BIM on Formcraft carry it into firms.

    **Builds on:** lessons (idea 7), the Manual's training content.
    **Size:** M.
    **First step:** one university pilot course.
43. **Government projects.** Public clients are starting to ask for BIM. A ready "BIM for public projects" pack helps
    firms win those tenders and do them properly:
    - BEP templates
    - information requirements
    - IFC delivery
    - ISO 19650 alignment

    **Builds on:** the Manual's BEP framework, IFC/IDS checking.
    **Size:** M.
    **First step:** a BEP template for a public client.

## G. Beyond East Africa

44. **An open kit format.** Publish the schemas of the kit: rulebooks, CIS, codes, family specs, the clash matrix.
    Other countries and firms can then make their own kits. Formcraft becomes the platform; each country brings its
    own standards.
    **Builds on:** the kit, its rulebook schema v0.1, CIS v0.1.
    **Size:** M.
    **First step:** document the kit layout and each schema in one public page.
45. **Kit and family marketplace.** Firms share or sell their kits, rulebooks and families through the Family
    Librarian's release process. The best local families become regional standards.
    **Builds on:** the family staging and release process, the open kit format.
    **Size:** L.
    **First step:** a curated shared library for two partner firms.
46. **buildingSMART and ISO 19650.** Align with buildingSMART's IDS and BCF, and with ISO 19650 naming and states (the
    Manual already follows it). Certification makes Formcraft acceptable to international clients.
    **Builds on:** naming rules, CDE states, IDS, the Review register (BCF-shaped).
    **Size:** M.
    **First step:** export the Review register as BCF.

## H. Business

47. **Pricing that fits the market.**
    - Monthly seats per module.
    - Mobile-money payment (MTN MoMo, Airtel Money, M-Pesa).
    - Free student and university licences.
    - A free tier with the checks only.

    The licence service (U17) is where this lands.
    **Builds on:** the licence and seats (mock today), the modules.
    **Size:** M.
    **First step:** decide the module prices with three pilot firms.
48. **Partner firms and certification.** Certified Formcraft trainers and partner firms in each country, who earn
    from training and setup. The Manual's competency levels become a recognised certificate.
    **Builds on:** the competency matrix (18.2), lessons.
    **Size:** M.
    **First step:** certify the first trainers inside Formcraft.

## I. Sustainability

49. **Embodied carbon per model.** The kit has carbon factors (`FMC_Carbon_Factor`, `FMC_Carbon_Source`) on every code.
    Build already measures by code, so a carbon report per model is one step away. Clients and funders increasingly
    ask for it.
    **Builds on:** Build, the kit's carbon fields.
    **Size:** S.
    **First step:** a carbon column in Build's BOQ.
50. **Recycled content and supply distance.** The kit has `FMC_Recycled_Content_Pct` and `FMC_Supply_Distance_km`.
    Report them with the carbon, to favour local materials.
    **Builds on:** the carbon report.
    **Size:** S.
    **First step:** add both to the carbon report.

## J. Trust, security and reliability

51. **The end-to-end test in CI.** Run `tests/e2e` on every PR, with a small sample kit stored in the repo, so a break
    in any tool is caught before merge.
    **Builds on:** `tests/e2e` (PR #80).
    **Size:** S.
    **First step:** a sample kit in `tests/kit`.
52. **A Revit smoke test.** Every week, in a Revit 2025 virtual machine, driven by a Revit journal file, run each
    section's dry run on the pilot model. It covers what the fake Revit can't (transactions, Undo, view filters, the
    ribbon).
    **Builds on:** the journal-driven checks already used for U10.
    **Size:** M.
    **First step:** one journal that opens a model and runs the self-test.
53. **Supported versions.** Revit 2025 for the pilot, then 2026. Say so in the installer, and refuse older versions
    with a clear message.
    **Size:** S.
54. **Data protection.** Projects hold personal data (names, phone numbers) and client information. The Uganda Data
    Protection and Privacy Act 2019, Kenya's Data Protection Act 2019 and their neighbours apply. Keep personal data
    out of logs (as Ask does), encrypt what syncs, and write a short privacy note for clients.
    **Builds on:** logging rules (14.5), Ask's text-free log.
    **Size:** S.
    **First step:** check every log for personal data.
55. **Crash reports, by choice.** If the person agrees, a crash report (no model data, no names) goes to Formcraft,
    so problems are fixed before anyone reports them.
    **Size:** S.
    **First step:** a local crash file the person can send.

---

## Suggested order for the next three months

| Weeks | Focus | Ideas |
|---|---|---|
| 1–2 | The pilot in Revit 2025: test, fix, sign the build | 1, 6, 51, 53 |
| 3–4 | Make it easy | 2, 3, 10, 11 |
| 5–6 | AI that does the safe work | 15 (after approval), 17, 18 |
| 7–9 | Navisworks clashes into Review, then the clash loop | 23, 16 |
| 10–12 | Robot, Project Browser, a priced BOQ, carbon | 24, 9, 31, 49 |

East Africa ideas 37–43 start alongside, with the first pilot firms.

## Waiting on a decision

- **The AI-assisted modeller:** approve the change request in [AI_ASSISTED_MODELLER.md](AI_ASSISTED_MODELLER.md) (BIM
  Manager and MD, Part 18.4).
- **FormCraft Electrical:** it writes 16 FMC_ parameters the kit doesn't have. Add them to the kit, or rename them.
- **The CIS format:** approve `fmc-cis/0.1` (docs/CIS.md), or put a format in the kit.
- **Keyboard shortcuts:** one export of Revit's Keyboard Shortcuts from the owner starts the standard (idea 10).
- **Earlier questions:** where prints and reports go (01_WIP or 06_QA), and the revision and status code lists (MAN 4.4).
