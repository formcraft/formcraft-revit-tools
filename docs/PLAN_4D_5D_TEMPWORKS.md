# PLAN: 4D / 5D and Temporary Works (owner talk, 19 Oct 2026)

Status: **parked ideas.** Nothing here is coded until the owner says go. Queue rows: Project `QUEUE.md` › P9 (T1–T12).

## 1. Decisions so far (owner, 19 Oct)
- No SYNCHRO MCP exists yet (Bentley's MCPs: iTwin IoT, STAAD.Pro, MicroStation). The "Syncro" connector in Claude's
  directory is IT-management software, not Bentley: never connect it.
- 4D runs on **Navisworks Manage TimeLiner** (already bridged), not SYNCHRO: about 75% of SYNCHRO. The gaps (drag
  re-sequencing, earned value) are filled by Formcraft Build.
- **Temporary Works** is a feature of **Formcraft Model** (modelling, quantities, time links; it never shows money).
- **Costs, the 3D cost model and 4D/5D playback** live in **Formcraft Build**. Build owns the rate library and writes
  rates into the model; modellers never type rates.
- Data flows one way: Model (geometry, quantities, time) → Build (rates) → cost, cash flow, valuations.

## 2. Kit already changed (19 Oct, on the pilot PC)
`01_Shared_Parameters\FMC_SharedParameters.txt` (backup `FMC_SharedParameters_backup_2026-10-19.txt`): 188 → 204.
- Group 4 (4D): FMC_Task_Type, FMC_Task_Sequence, FMC_Planned_Start, FMC_Planned_Finish, FMC_Actual_Start,
  FMC_Actual_Finish, FMC_Percent_Complete, FMC_4D_Set_Key, FMC_Project_Start_Date, FMC_Data_Date, FMC_Data_Day,
  FMC_Planned_Start_Day, FMC_Planned_Finish_Day, FMC_Actual_Start_Day, FMC_Actual_Finish_Day.
- Group 20 (Logistics): FMC_Temp_Works_Type.
- Already there: FMC_Task_ID, FMC_Zone, Construction/Procurement Status, Lead Time, PO Ref, Curing Days, Laydown Area,
  Delivery Batch, Trade Package, Subcontractor ID, Unit Rate, Cost Code WBS.
- GUIDs are uuid5 of `formcraft:<name>` (stable). Not yet bound to any template (T1).

## 3. Date rule (Revit has no date parameter type)
- Text ISO `YYYY-MM-DD` is the master (people, sheets, TimeLiner CSV, IFC). It sorts correctly as text.
- Each date has an INTEGER `_Day` twin = days from FMC_Project_Start_Date (Day 0), written only by the plugin.
- Gives durations in schedules (Finish_Day − Start_Day), 4D colour filters in Revit (against FMC_Data_Day), late items.
- **Date Guard (T3):** pane date picker writes both fields; an updater re-derives `_Day` on every change and overwrites
  hand-typed numbers; input such as `2/11/26` is normalised (day-first, Uganda, confirmed once); checks Finish ≥ Start,
  Actual ≤ Data Date, gap after a pour ≥ FMC_Curing_Days (Guard log); moving Project Start recalculates every `_Day`.
  Later: `_Day` twins for FMC_Install_Date and FMC_Warranty_End.

## 4. Where 4D is viewed
1. **Revit (working check):** a "4D" Data Date slider in the Formcraft Browser; view filters colour done / in progress /
   not started. **4D sequence sheets** (6–12 staged 3D views per sheet) from the Sheets Manager.
2. **Navisworks Manage (master):** TimeLiner + Animator (cranes, hoists, props) + time-based clash; AVI / frames out.
   Clients open the NWD in free Navisworks Freedom (confirm playback on install).
3. **Web / tablet (future, Formcraft Build):** browser viewer with a date slider, cost and progress.

## 5. 4D Presentation Standard (to write as `FMC_Rulebook_4D.json`, T2)
- **Story:** existing site → site setup (hoarding, offices, crane up) → substructure (excavation as Demolish, curing
  gaps) → frame by level and pour (props in, pour, cure, strike) → envelope (weather-tight milestone) → MEP first fix,
  finishes, second fix by zone → external works → crane down, handover.
- **Overlays:** date and week counter, current activity, synced mini-Gantt with critical path, % complete, cost-to-date
  S-curve, workforce, milestones and hold points, Kampala rainy-season bands (about Mar–May and Sep–Nov).
- **Colours:** Construct green → real material; Demolish red; Temporary yellow; upcoming ghost grey. Planned vs actual:
  early blue, late red, on time real material.
- **Camera:** one fixed overview, short fly-ins at key moments, planned-vs-actual split screen, 2–4 minutes.
- **Audience versions** from one dataset: client/investor, contractor, QS, safety officer, tender panel.
- **Failure guards:** one element = one pour / lift / zone (Revit Parts for pours); the Guard lists tasks with no
  elements and elements with no task before export; temporary works must be modelled; no manual task linking.

## 6. Temporary Works feature (Formcraft Model, T7)
Tools: Site Setup · Crane Planner (reach to every element and laydown, height, clearance to neighbours and power lines)
· Scaffold Generator (by lift, bay, level, zone; boards, ties, edge protection) · Formwork & Propping (prop field,
formwork area, strike = pour + curing, back-propping) · Excavation & Support · Safety Layer · Temp Works Register
(BS 5975: TW coordinator, design check, permit to load / strike).

**Dates by rule (nobody types temp-works dates):** scaffold up = blockwork start on that level − 2 d, down = façade
finish + 1 d; props in = slab formwork start, out = pour + FMC_Curing_Days; crane up before the first slab, down after
the last heavy lift; hoarding and offices Day 0 → handover.

**5D for temp works (T9):** cost = erect + hire rate × weeks on site + dismantle. New params: FMC_Hire_Rate_Week,
FMC_Erect_Cost, FMC_Dismantle_Cost, FMC_Hire_Weeks (plugin-derived). What-if: slip a floor 3 weeks → extra hire shown.

**Family rules, all families:** one element = one buildable piece; type params carry cost, instance params carry time;
every family reports what the QS measures (concrete: volume + formwork contact area + edge length; scaffold: face m²
and lifts; props: count).
**Temp-works family rules (T8):** lightweight LOD 200; one **prop field** family (spacing params, reports count) and one
line-based **scaffold run** family (arrays bays and lifts), not hundreds of single items; clearance zones built in
(crane swing, exclusion, access); FMC_Task_Type = Temporary; own workset; one-click hide on design drawings. Material
switch on scaffold and props: **Steel Tube / System (Cuplock, Ringlock) / Timber Pole (eucalyptus)**, each with its own
hire rate, spacing and safety limits.

**Families:** cranes and lifting (tower flat-top, hammerhead, luffing; mobile crane; hoist; concrete pump; truck mixer)
· scaffolding (run, corner/return, loading bay, stair tower, edge protection) · formwork and propping (prop field, table
form, column and beam formwork, back-prop field) · site setup (hoarding run, gate, container office, toilet block,
store, wheel wash, skip, laydown area, temporary road) · excavation (volume, shoring panel, ramp, dewatering pump) ·
safety (barrier run, exclusion zone, netting, signage point).

## 7. Formcraft Build: 3D cost model (T10)
Colour-by-cost heat map · click an element → BOQ line (qty × rate, package, subcontractor) · filters (package, level,
zone, permanent vs temporary) · 4D slider linked to a cost S-curve · what-if programme slips · valuations (% complete ×
amounts → monthly certificate) · in Revit (Build pane, for QSs) and later the web / tablet viewer.

## 8. Navisworks bridge upgrades (T5–T6)
`fmc_navis` is read-only and clash-only today. Add a TimeLiner CSV export from model dates (no P6 needed), then
`timeliner_import`, `build_search_sets` (by FMC_4D_Set_Key), `auto_attach` (rules), `export_sim`. Goal: "make the 4D
for Kampala" in one sentence.

## 9. Open questions for the owner
1. Who sees rates in Build: access levels (QS full / manager totals / client headline) or everyone for now?
2. Temp-works rates: QS sets them per project, or starter default rates in the kit?
3. First temp-works tools: suggested Crane Planner + Site Setup → Formwork & Propping → Scaffold Generator.
4. Scaffold types from day one: all three, or steel + pole?
5. BS 5975 register now or later?

## 10. Proof (T11)
Kampala sample project (Q70), structure only first: foundations → frame by level, with props and a crane; Revit check
and sequence sheets, then the Navisworks video.

## 11. ArchiCAD (T12, being discussed 19 Oct)
Evaluate the community archicad-mcp (Archicad JSON API + Tapir add-on), map the FMC kit to Archicad (properties,
classifications, GDL objects) and decide the scope with the owner. Details to follow the owner's decision.
