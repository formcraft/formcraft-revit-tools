# KISIC build log – 19 Oct 2026 (unsaved Project1, Revit pid 29884)

| # | Step | Script / tool | Result |
|---|---|---|---|
| F | 16 family recipes | fmc_recipe batch KISIC-interior / -2 + build | 16/16 staged. Fixes on the way: power connectors PowerBalanced (Unbalanced can't link Apparent Load); slat wall needed an early add_type before the first type parameter. Gate A: Fail only on pending keynotes / type-name pattern (not releasable until the kit has the keynotes – staging use is fine) |
| 01 | Existing shell | 01_shell.cs | 10 walls, **20/20 ends joined** (QA runs after commit – joins only form on commit), 5 doors, 3 openings, 4 slabs |
| 02 | Rooms | 02_rooms.cs | 6 rooms, all areas = drawing (14.0 / 2.53 / 7.92 / 1.32 / 12.43 / 20.2 m²) |
| 03b | Ceilings | 03b_ceilings.cs + fmc_material | flat ×5, Scan raft 2850, lobby tray (bulkhead 2750, field 3050, 6 fascia), veranda bamboo soffit 2700 |
| 04 | Finishes | fmc_material assign + 04_finishes.cs | porcelain floors ×6, quarry tile veranda, linen-white paint (20 faces), terracotta accent wall |
| 05 | Furniture | 05_furniture.cs | 24 items: desk, slat wall, sofas, bark-cloth ×2, stools ×3, planters ×8, TV, couch, chairs, veranda benches ×3 |
| 06 | Lighting | 06_lighting.cs | 66 items incl. 37 strip pieces (horizontal + vertical corner runs + Scan raft halo + veranda V1), spots, panels, pendants, fan, wall lights, X-ray warning light. Lobby room frame origin = (4.225, 2.45) |
| 07 | Devices + MEP equipment | 07_devices_mep_equipment.cs | 55 items: 12 switch plates, DB-1, 17 sockets, 6 data, AC-1..4 (option A) + 4 roof units, 2 extract fans, 3 basins + 3 heaters, 4 sanitisers |
| 08 | 3D pipework | 08_pipework_tank_gullies.cs | 38 pipes + 22 elbows: refrigerant ×4, condensate ×4, cold water from roof tank, waste ×4; roof tank + 6 gullies |
| 09 | Casework / equipment placeholders | 09_casework_equipment_placeholders.cs | lab L-run (11 units as massing), fridge, X-ray + ultrasound placeholders, control console (**real run without a separate dry run** – placeholders only) |
| — | Views | inline | FMC Check - 3D interior, FMC Check - MEP 3D, cameras R1 R3 R5 R6 R7; clearance subcategories + planter foliage hidden in views |
| ✗ | Electrical circuits | — | **Not built.** ElectricalSystem.Create works, but SelectPanel fails: "panel and circuit do not match / distribution system invalid" for the kit DB (FMC_E_EQ_DB_Final_TPN) with a 415/240 Wye system. Every device carries its circuit in Comments ("circuit P5" etc.), so circuits can be made in one pass once the DB family/distribution system is fixed |

Open: AC option (A modelled), heights (assumed), DB position, X-ray/ultrasound makers, toilet, light-source photometry for new fittings, Enscape materials (LED self-illumination), electrical circuits.
| 10 | Lighting plan E103 | inline (see 10_lighting_plan_notes) | RCP "E-LP-01 Lighting Plan L00" 1:20, fixtures coloured by circuit (P1 blue, P2 red, P3 green, P4 orange, P8 purple), 28 tags, switch-group notes, key; schedules E-SCH-01 luminaires + E-SCH-02 switching; sheet E103 on the template's A0 title block; PDF in _out |
| 11 | Render materials | 11_render_materials.cs | emissive LED diffusers (3000 K strips/downlights, 4000 K panels/linear), frosted wall-light lens, red X-ray lens, TV screen "on", banana-fibre pendant shade, bronze wall-light body; 22 type material params set (were "none") |
| 12 | Views organised + cameras | inline | 3D views renamed "KISIC Rnn …" (renders) and "KISIC Qnn …" (checks); new cameras R02 lobby TV/desk/AC, R04 X-ray, R08 Control, R09 electronics (DB/desk/switches), R10 lobby reverse, R11 veranda night |
| ✗ | Enscape renders | computer use | Enscape started from Revit (export OK, "Pause Live Updates" shown), but its window never appeared on the captured screen, and "Render Image (Into Document)" produced nothing. Needs the person to bring the Enscape window forward |
