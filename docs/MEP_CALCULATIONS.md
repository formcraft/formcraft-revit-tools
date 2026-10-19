# MEP calculations from the kit (E1)

The kit's MEP calculations (FMC_Revit_Kit.xlsx: tab **Calculations** and the **Calc_*** worksheets) ported to code, so
the plugin makes calculation sheets from the model. Owner-approved 19 Oct 2026 (engineering-services track, step E1).

**Every sheet is a draft for the engineer to check and sign. Formcraft does not size or sign** (CLAUDE.md rule 5).

## How it runs

| Part | Where |
|---|---|
| Facts from Revit (read-only, no transaction) | `fmc_mep_facts` (commandset `Services/Fmc/FmcMepFacts.cs`) and `fmc_electrical_facts` (boards) |
| The calcs (pure functions) | `server/src/fmc/calc/` (one module per calc; `kit.ts` reads the workbook) |
| The tool | `fmc_calc`: `list`, `run`, `sheet` |
| Unattended test | `tests/revit/15_mep_calc.json` |

- **Kit values only from the kit** (rule 7): the workbook is read with the server's own reader (`fmc/xlsx.ts`), from
  `<kit>\03_Master_Data\FMC_Revit_Kit.xlsx` (or beside the guard's specs file). Nothing writes to the kit.
- **Every value is tagged** with its source: `kit:<tab>!<cell>`, `model:<element id>` (`model` alone: a sum over the
  model), `engineer` (given in the call's `inputs`), `calc` (worked out with the kit's formula), or `TBC`.
- **Missing means TBC.** A value the kit lacks is never invented: the sheet lists it under "TBC: what is missing", and
  `kit_change_requests` in the reply lists the ones the kit itself should add.
- **Checks** against the kit's limits give `pass`, `fail` or `TBC` per row; a calc's result is `fail` if any row fails,
  else `TBC` if anything is TBC, else `pass` (`no input` when the model has nothing to calculate).
- **Sheets** go to `<project>\01_WIP\<Role>\_Calcs\<date>_<calc>.md|.csv|.json` (Role: E, P, FP or LP), dry run first,
  never over an earlier sheet (a second one the same day is `_2`), never to 02_Shared or 03_Published (rule 2).
- Rounding follows the spreadsheet's formulas (Excel ROUND and ROUNDUP), so results match the kit sheets; the unit tests
  feed each sheet's own sample inputs and expect its numbers.

## The calcs

### CA-E-01 Maximum demand, transformer and generator

- **Kit:** Electrical_Settings (Load classification → demand factor, C10:C17); Calc_E_MaxDemand (power factor B16,
  transformer margin B18, generator margin B19, standard sizes rows 21-22, "agree within 2%" A33).
- **Model:** power circuits (load classification, true and apparent load); boards from `fmc_electrical_facts`.
- **Out:** per board and class: connected kW × kit factor = demand kW; board totals; building demand; kVA = kW / PF
  (ROUND 1); transformer and generator = next standard size ≥ kVA × margin; phase balance of single-phase units (number
  from the brief, `inputs.single_phase_units`); the result against Revit's own demand on the boards fed by no other board
  (in VA, Revit's demand load is apparent).
- Feeders to other boards are left out so no load counts twice.
- **Stays with the engineer:** demand factors (a class with no kit factor is TBC, "the engineer sets"), circuits with
  mixed or no classification, PF and margins (the kit's assumptions), plant selection with the utility and suppliers.

### CA-E-02 Voltage drop

- **Kit:** method and limits (Calc_E_VoltDrop A2: 3 % lighting, 5 % other).
- **Model:** each power circuit and feeder: voltage, design current (apparent current), Revit's circuit length, wire size.
- **Out:** VD = ROUND(mV/A/m × Ib × L / 1000, 2); VD % = ROUND(VD / V × 100, 2) against the limit (lighting if every class
  on the circuit is a lighting class; feeders and others use the other limit).
- **TBC:** the kit has **no mV/A/m table**; the engineer gives one for the cable and installation method
  (`inputs.mv_a_m`, e.g. `{"2.5": 18}`). The kit sheet's sample rows are never used as a table.
- **Stays with the engineer:** installation method, route length, cable selection.

### CA-P-01 Water demand, storage and septic tank

- **Kit:** Calc_P_Water occupancy table (L/person/day, D6:D8), days of storage (B12), tank size (B14), septic
  C = 180 P + 2000 (A2), visitors left out of the septic population (C10).
- **Model:** rooms (or spaces, never both) with FMC_Design_Population and their Occupancy; tanks with FMC_Tank_Capacity_L.
- **Out:** persons and L/day per occupancy, design population P, daily demand, storage, tanks required, storage modelled
  vs required, septic capacity.
- **TBC:** an occupancy the kit's table doesn't have; rooms with no population are left out and noted.

### CA-P-02 Drainage design flow

- **Kit:** Calc_P_Drainage DU table (B6:B11, System III values) and K (B14, dwellings 0.5).
- **Model:** plumbing fixtures; DU is the fixture's FMC_Discharge_Units, else the kit's DU matched by family and type name.
- **Out:** DU × count per fixture, sum DU, Qww = ROUND(K × √ΣDU, 2), design flow = max(Qww, largest DU).
- **Stays with the engineer:** the system type, K for uses other than dwellings, the split per stack or drain run.

### CA-FP-01 Portable extinguishers

- **Kit:** Calc_FP_Extinguishers rule (A2: Class A rating ≥ 0.065 × floor area, at least two per storey) and the
  chosen extinguisher's rating (B5, 13A).
- **Model:** rooms (area per level, net) and extinguishers (FMC_Extinguisher_Rating, level).
- **Out:** per storey: required rating (ROUND 1), extinguishers required, modelled count and rating, pass / fail.
- **Stays with the fire engineer:** gross vs net area, placement, travel distance, other fire classes.

### CA-FP-02 Hose reel coverage

- **Kit:** method only (Calculations: coverage radius = hose length + throw).
- **Model:** hose reels (FMC_Hose_Length_m, location, level); rooms' location points.
- **Out:** radius per reel; per room, the nearest reel on its level and whether the room's point is within its radius.
- **TBC:** the kit has **no throw value** (`inputs.hose_throw_m`) and no travel distance limits (the fire strategy).

### CA-LP-02 Earth resistance record

- **Kit:** method only (Calculations: measured resistance per pit against the design target).
- **Model:** earth pits (FMC_LP_Part = Earth) with FMC_Earth_Resistance_Ohm and Mark.
- **Out:** measured vs target per pit.
- **TBC:** the kit has **no design target** (`inputs.earth_target_ohm`); a pit not measured yet is TBC.

## Calcs the kit leaves to another tool

`fmc_calc list` names them from the kit's register ("Sheet or tool" column); they are not ported:

| Calc | Done by, per kit |
|---|---|
| CA-Z-01 Site coverage and plot ratio | FMC_UpdateProjectMetrics script |
| CA-A-01 Daylight and natural ventilation | the kit workbook's Calc_A_Daylight sheet |
| CA-S-01 / CA-S-02 Concrete, rebar, formwork | schedule calculated fields; FMC_FormworkArea (P2) |
| CA-E-03 Lighting levels | DIALux (specialist tool) |
| CA-M-01 Cooling load | Revit Systems Analysis |
| CA-M-02 Ventilation rates | schedule calculated fields |
| CA-P-03 Rainwater and storm run-off | schedule calculated fields |
| CA-LP-01 Lightning protection design | the kit workbook's Calc_LP_Design sheet (LPS class from the risk assessment) |
| CA-C-01 Earthworks | Revit toposolid / Civil 3D |
| CA-L-01 Planting quantities | schedule calculated fields |

## Kit change requests from v2.2

What the kit lacks for these calcs (each is TBC until the kit or the engineer gives it):

1. **CA-E-02** mV/A/m by conductor size and installation method (BS 7671 Appendix 4 or the cable maker's tables).
2. **CA-FP-02** hose reel throw (m), and where the travel distance limits come from.
3. **CA-LP-02** design earth resistance target (ohm) per earthing system.

## What stays with the engineer

Everything on the sheet is a draft: the engineer checks the inputs, confirms the kit's assumptions (power factor,
margins, L/person/day, DU and K), sets anything TBC, and signs. Formcraft never sets a demand factor, sizes a cable,
selects plant or signs a calculation.
