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

## Keeping it reliable

13. Run `tests/e2e` in CI, with a small sample kit stored in the repo.
14. Add a weekly smoke test in a Revit 2025 virtual machine, driven by a Revit journal file, to cover what the fake
    Revit can't (transactions, Undo, view filters, the ribbon).
15. Officially support Revit 2025 and 2026 only for now, and say so in the installer.

## Waiting on a decision

- FormCraft Electrical writes 16 FMC_ parameters the kit doesn't have: add them to the kit, or rename them.
- The CIS format: approve `fmc-cis/0.1` (docs/CIS.md), or put a format in the kit.
- The kit has no keyboard-shortcuts file.
- Where prints and reports go (01_WIP or 06_QA), and the revision and status code lists (MAN 4.4).
