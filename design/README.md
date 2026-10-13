# Design

The UI design for every screen of the plugin. These boards are the reference the shell is built against.

## Where to look

- **Live, clickable:** the central canvas "Formcraft Revit Tools — Central Canvas" on claude.ai, page
  "Formcraft Revit Tools", section "Every screen of the plugin" (one column per module, plus Core and Account).
- **Source in this repo:** `boards/<column>/*.dc.html`. Each file is one board (Design Component HTML). They render
  only inside the canvas runtime, so open the canvas to see them; read the files for exact text, sizes and colours.

| Folder | Boards |
|---|---|
| `boards/core` | Pane shell and states, responsive pane, Connect, Settings (General), Admin, Ask Claude, ribbon overview, screen inventory, Log file window, search (Ctrl+K), UI kit |
| `boards/account` | Sign in, first-run setup, Settings › Account, Admin › Licences and seats, locked/offline/error states, updates, account website |
| `boards/manage` | Settings › Manage, Project, Templates, Families, Materials, Sheets, Annotate, Issue, Review, Workshare, Links, QA, Rules, Reports, revision on the drawing, sheet prints, ribbon, material database |
| `boards/flow` | Settings › Flow, Touch, on-view previews, gestures, ribbon |
| `boards/model` | Settings › Model, Start from brief, Systems, Structural, Scripts and automation, automation flow, ribbon |
| `boards/build` | Settings › Build, Build pane, web workspace, workspace window, Revit views, ribbon |

## How a board maps to code

- The left part of every pane board is the pane (440 px wide); the right part is the guide table: field, control,
  what it feeds, and the rule behind it. Build the pane; the guide table tells you what each control does.
- Colours, type and spacing are the tokens in `shell/Formcraft.Shell/Theme/FmcTheme.xaml` (`docs/UI_KIT.md`).
- Values in boards are samples. Placeholders look like `[NAME A]` or `[PRICE]`.

## Regenerating boards

`generators/` holds the Python that wrote the boards. `python3 generators/gen_panes.py out` writes the pane boards to
`out/project/`; `gen_ui.py`, `gen_ribbon.py` and `gen_build.py` write the rest to the folder given. Change a board by
changing its generator, then republish to the canvas.
