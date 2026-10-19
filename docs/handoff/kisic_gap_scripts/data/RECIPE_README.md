# KISIC model recipe

Replays the Kisasi Imaging Centre model into a fresh, **unsaved** Revit project (Metric Multi-discipline). The person saves at the very end.

| Step | File | Status |
|---|---|---|
| 01 Existing shell (walls 20/20 joined, doors, openings, slabs, ceiling) | 01_shell.cs | tested once, now with built-in join QA |
| 02 Rooms + area check | 02_rooms.cs | tested |
| 03 Check views + PNG export to 01_WIP\A\_check | 03_check_views.cs | tested (combined) |
| 04 LED strips, rooms + veranda | 04_strips.cs | rewritten without the step that crashed Revit; dry run first |
| 04b LED diffuser self-illumination | to write | run alone, or set in Enscape |
| 05 Light fittings + switches | recipe data ready | families to build: panel, fan-light, wall light, linear task |
| 06 Electrical | recipe data ready | needs socket/DB families |
| 07 Mechanical (AC) | waiting on A/B/C | |
| 08 Plumbing | recipe data ready | |
| 09 Furniture + planting | recipe data ready | kit families first |
| 10 Enscape views + video | list ready | |

Everything about positions, sizes and rules is in `KISIC_Model_Recipe.json`; the scripts read nothing else from the old document.
Heights are assumed (ceiling 3.0 m, soffit 2.7 m) until Monday's measurements; change them in the JSON and the scripts' constants.
