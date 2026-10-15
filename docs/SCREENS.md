# Screens

Every screen is drawn and clickable on the central canvas, page "Formcraft Revit Tools", section
"Every screen of the plugin". Board names in brackets.

| Column | Screens |
|---|---|
| Manage | Settings › Manage (PaneSettingsManage), Materials (PaneMaterials), Project (PaneProject), Revision on the drawing (ReviewOnSheet), Sheet prints (SheetPrints), ribbon (R_Manage). Templates, Families, Issue, Review, Workshare, Links, QA, Rules, Reports are on the Manage page |
| Flow | Settings › Flow, Touch (PaneFlowTouch), Sheets, Annotate, Flow on the view (UI_Overlays), Gestures (Flow_Gestures), ribbon (R_Flow). View range has no board yet: a Revit task dialog (Drag a rectangle, Click corners, Change this view's range), then a dialog over the pane (FmcDialog with Settings rows, `FlowViewRangeDialog`): Area, what Apply makes (an amber note for the fallback view), Starts from, Top level and offset, Cut plane offset, Bottom level and offset (not on ceiling plans), View depth level and offset; Cancel and Apply |
| Model | Settings › Model, Start from brief (PaneModelBrief), Systems, Structural, ribbon (R_Model), Scripts and automation (PaneScripts, under Check › Scripts with a +Model tag), automation flow (M_Automation) |
| Engineer | Casework (CW_Pane, CW_Overview, CW_Outputs) and Ceilings (CL_Pane, CL_Overview, CL_Pack), +Model: each step is mapped below |
| Build | Settings › Build, Build pane, web workspace (B_Web), workspace window (B_Workspace), Revit views (B_RevitViews), ribbon (R_Build) |
| Core | Screen inventory (UI_Inventory), Log file (UI_Log), Search Ctrl+K (UI_Palette); pane shell, Connect, Settings General, Admin, Ask Claude in the Core section |
| Stage D (proposed 14 Oct, `docs/PLAN_EXECUTION.md`) | Map (coord/StageD_Map), Admin › AI involvement (core/PaneAdminAI), Templates › Builder (manage/PaneTemplatesBuilder), Families › Quality and release (manage/PaneFamiliesRelease), Sheets › Legends and schedules (manage/PaneLegends), Data › Excel and Power BI (manage/PaneData), Automation › Runs and triggers (model/PaneAutomationRuns), Structure with Robot (model/PaneStructRobot), Coordinate › Clashes (coord/PaneCoordClashes), Formcraft pane in Navisworks (coord/PaneNavisworks). Drawn on the claude.ai canvas "Formcraft New Panes"; not yet on the central canvas, and without the guide table: the guide is in `docs/UI_DEVELOPMENT.md` Stage D |
| Account and shell | Sign in (PaneSignIn), First-run setup (PaneWelcome), Settings › Account (PaneAccount), Admin › Licences and seats (PaneSeats), States (PaneStates), Updates (PaneUpdates), UI kit (UI_Kit), Account website (UI_AccountWeb) |

What is built so far, and what still differs from the boards: `docs/STATUS.md`.

## Engineer › Casework and Ceilings (CW3, CL3)

Boards in `design/boards/model/`. Each pane step is one step of the section's step bar (`StepBarSetting`); the preview
renders every step at 440 px and compact at 360 px (`casework-<theme>-stepN-<width>.png`, `ceilings-<theme>-stepN-<width>.png`).

| Screen | Board (frame) | Code |
|---|---|---|
| Casework › 1 Room | CW_Pane "1 · Room and brief" | `CaseworkPage` step 0 |
| Casework › 2 Layouts | CW_Pane "2 · Layout options" | `CaseworkPage` step 1 |
| Casework › 3 Check | CW_Pane "3 · Checks and dry run" | `CaseworkPage` step 2 |
| Casework › 4 Units | CW_Pane "4 · Unit editor" | `CaseworkPage` step 3 |
| Casework › 5 Outputs | CW_Pane "5 · Workshop pack"; CW_Outputs (cut list, nesting, cost) | `CaseworkPage` step 4 |
| Casework, dark and compact | CW_Pane "Dark theme and compact width" | theme tokens; step bar numbers only below 400 px |
| Casework, what it is for | CW_Overview | context only |
| Ceilings › 1 Room | CL_Pane "1 · Room and brief" | `CeilingsPage` step 0 |
| Ceilings › 2 Designs | CL_Pane "2 · Designs" | `CeilingsPage` step 1 |
| Ceilings › 3 Check | CL_Pane "3 · Checks and dry run" | `CeilingsPage` step 2 |
| Ceilings › 4 Features | CL_Pane "4 · Features" | `CeilingsPage` step 3 |
| Ceilings › 5 Pack | CL_Pane "5 · Ceiling pack"; CL_Pack (set-out, BoQ) | `CeilingsPage` step 4 |
| Ceilings, dark and on the Revit view | CL_Pane "Dark theme, and what shows on the Revit view" | theme tokens; the RCP overlay comes with CL2 |
| Ceilings, what it is for | CL_Overview | context only |
