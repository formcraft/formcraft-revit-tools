# RC frame design with Revit + Robot: the process (from the Ogala main house, 27–28 Oct 2026)

Owner 28 Oct: "Robot processes are being noted and referred to as we are making recipes for using Robot structural
analysis and design." This is the running record of how the AI designs a preliminary RC frame from an architecture
model, so it can become a tool (fmc_structure frame → fmc_robot design). PRELIMINARY – NOT FOR CONSTRUCTION until an
engineer of record signs.

## 1. Facts from the architecture model
- Open the structural model (ISO name, from FMC_S_Template_v2.2) with the architecture model **linked** (the arch model
  closed in the session, or the link fails). `fmc_struct_facts {link: "<part of the link name>"}` reads walls (type,
  function, thickness, base/top level, height, openings area), floors (layers, outlines), roofs, rooms, columns.
- Leave out parts of the site the owner excludes (`exclude_levels`, e.g. the boys' quarters).

## 2. Frame plan (fmc/frame.ts v2) and approval
- Structural lines: exterior walls, or ≥ 2.4 m of wall on a grid line. Columns only where walls meet on those lines
  (junctions closer than 1.8 m share one), every upper column on one below (else the beam carries it: no floating
  columns), spans over 6 m split. Beams where a wall or slab bears; ground beams under ground-storey walls; pads;
  RC slabs (concrete core ≥ 100 mm) as structural floors; grids only where columns are.
- `frameSvg` draws one plan per level: **show the owner before building** (owner rule).

## 3. Build in Revit (fmc_model_edit, dry run first, then apply, then save)
- Probe types with a dry run naming a bogus type: the error lists the model's types.
- Slab types of the right RC thickness made with `duplicate_type` (select `{category, types: true, type_name}`; layers).
- Sized frame types are made on the fly (`size_mm` → "RC bxh", pads "PAD BxBxh").
- Save with `fmc_revit_file {action: "save"}`. Batches: 000d13 (build), 001141 (gravity sizes), 001555 (pads).

## 4. Robot model (scratch scripts now; to become fmc_robot design)
- Revit made no analytical members for these families (fmc_analytical_export found 0), so the Robot model is built
  from the frame plan and the Revit ids of the build batch: columns pad-top → level, beams at level; **ground beams
  left out** (they bear on the ground and pads, and have no node on the columns at ±0.00).
- Loads from the kit takedown: slab G/Q to the nearest beam (500 mm samples), walls to the nearest beam of their base
  level (250 mm samples), roof load by beam length. Self-weight on in G.
- Seismic (US 319, kit seismic.*): Cd = C·Z·I·K = 0.08 × 0.8 × 1.0 × 2; W = G + 25% Q (roof imposed nil); Fi by
  W·h; storey force shared by column stiffness (b⁴) — the slab as a diaphragm. Combinations G+1.3Q±1.25E,
  0.9G±1.25E, plus ULS 1.35G+1.5Q and SLS G+Q. Wind (vb not given by the kit; ~0.4 kPa assumed) ≈ 10% of the seismic
  shear: seismic governs.
- Connector (connectors/robot): bar_loads per case, node_loads, combinations; results give N, My, Mz, V per bar
  (5 points) and node displacements for drift.

## 5. Lessons (what went wrong and why)
1. Pinned bases + bare frame: drift 3–10× the limit. Fixed bases help but the bare frame is still too flexible
   for a heavy (stone-walled) house.
2. Model the masonry infill (walls ≥ 150 mm, ≥ 80% of the panel, openings ≤ 30%) as diagonal struts
   (0.15 × diagonal wide, Em 3 GPa): consistent with the kit's K = 2 "frame with masonry infill".
3. RC shear walls: per direction the two most solid top-storey panels farthest apart, **solid on every storey down to
   the foundations**, modelled as an X of braces with the wall's shear stiffness G·t·L/h × (1 − opening share).
4. Least concrete (owner 28 Oct): start every member at its minimum (columns 230, beams span/12), raise column steel
   1% → 3% before a bigger column, let walls take the lateral load; the attic as a suspended timber floor (0.6 kN/m²
   instead of 5.5) cut the seismic base shear 1,035 → 859 kN.
5. Robot: after a crash the COM API answers E_FAIL to every call until Robot is restarted (never kill the owner's
   Robot; ask). A connector call stuck on a dead Robot must be killed (fmc-robot.exe only).
6. Harness: no `sleep` in loops; run names need seconds (several runs a minute); loops over 10 minutes go to the
   background.

7. **Robot dialogs** (save changes?, warnings) stall every call. The connector now runs Robot with Interactive = 0,
   closes the previous project without the save question, hands Robot back after saving, and every call has a
   10-minute timeout that reports "Robot is blocked (a dialog?)" instead of hanging.
8. **Stopping a loop doesn't stop its children**: a stopped iterate.sh kept running rounds and overwrote sizes.json.
   iterate.sh now holds a lock file per work folder. Never kill fmc-robot.exe mid-call (it leaves Robot in E_FAIL);
   stop the shell and let the call finish.
9. **Own solver** (scripts/structure/frame3d.py, `robot-run.mjs ... local`): same model, same results format, ~2 s per
   round instead of minutes; Robot is the independent final check (compare-runs.py).
10. **Diaphragms on irregular grids**: rectangle bays missed a third of the column heads (drift 3–10× too big).
    Each column head is now tied to its 4 nearest heads where the slab lies between them.
11. **Confined masonry is enough here**: with real diaphragms, the stone/block infill (built tight into the frame)
    passes drift without RC shear walls (`config.shear_walls: false`) – least concrete, and how the owner builds.
12. **Architect's own structural elements** (portico RC columns and beam) are not walls, so the wall-based planner
    missed them: `given-members.py` adds them (extra.json + extra.out.json, read by every script).
13. Owner's checklist for a complete design: dead, imposed, wind, seismic loads; slab reinforcement plan; stairs;
    roof trusses; BBS; typical details; general notes; report with plain-words summary and an objective checklist.

## Pipeline (one command each, from the plugin repo)
| Step | Script |
|---|---|
| Frame plan + build | fmc_structure frame → revit-edit.mjs (build.out.json) |
| Architect's given members | given-members.py → revit-edit.mjs extra.json apply (extra.out.json) |
| Analysis + sizing loop | iterate.sh <work> <runs> (local solver; SOLVER=send for Robot) |
| Reinforcement + BBS | rc-design.py, then stair-slab.py (stairs, slab plan, BBS sheet) |
| Revit update | revit-apply.mjs <work> <design json> apply; revit-cmd.mjs fmc_revit_file save |
| Roof | truss-design.py → revit-edit.mjs truss_ops.json |
| Sheets | drawings.py, notes-details.py, stair-slab.py ops → revit-edit.mjs |
| Report | report.py → publish |
| Robot check | robot-run.mjs send + compare-runs.py |

## 6. Member check (simplified EC2, fck 25 conservative, B500, d = h − 50)
- Beams: M ≤ 0.156 fck b d²; V ≤ VRd,max (θ = 45°); deepen 50 mm at a time, then 300 wide.
- Columns: N/NRd + (Mmax + 0.5 Mmin)/MRd ≤ 1 with e ≥ max(h/30, 20 mm); ρ 1–3%, then a size up.
- Drift: elastic × 5/K ≤ 0.010 h and 60 mm per storey.

## 7. Outputs
Sheets S-100.. (foundations + ground beams, framing plans, 3D), member check CSV, reinforcement design and bar bending
schedules (BS 8666 shape codes, kit rebar.* and detailing.*), design report — in 01_WIP\_Structure.
