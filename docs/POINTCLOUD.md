# fmc_pointcloud: point cloud against model

Source: L011-F25 (Pursuits Feasibility, tools row 16, NBRB and DITACO): "Read E57 or LAZ, align to the model, report how
far each element is off". Build plan item 61 / G029.

## What it does
1. Reads the scan on the server (`server/src/fmc/cloudread.ts`, no new dependency):
   - **E57** (ASTM E2807): every data3D scan, cartesian or spherical, Float / Integer / ScaledInteger fields (bit-packed),
     invalid-state points left out, the scan pose applied. Checked against the libE57 reference files (bunny double and
     bunny int32 give identical points) and the CC0 cube in `tests/data/pointcloud`.
   - **LAS** 1.0-1.4, any point format, scale and offset applied.
   - **LAZ** is detected (point format bit 7/6 or .laz) and refused with `FMC-POINTCLOUD-LAZ`: decompress to LAS first
     (`pdal translate in.laz out.las`, or LAStools `laszip`; LASzip is LGPL-2.1, so it is not bundled).
   - Sampled by stride to `max_points` (default 300,000) while streaming; a big scan is never held whole.
2. Reads the model (`fmc_pointcloud_read`, read-only, no transaction): each element of the kit categories (or
   `element_ids`) as a triangle mesh in metres, in shared coordinates (default; built from `GetProjectPosition`) or
   internal; also lists point clouds already linked in Revit with their transforms (information only).
3. Aligns: `offset` {x, y, z, rotation_deg} is the start; `alignment: icp` (default) refines it on 20,000 points with
   point-to-surface ICP, yaw plus translation (`icp_z_only`, default true) or full 3D (Horn). It is rejected, and the
   start kept, if it moves more than `max_shift_m` (0.5) or turns more than `max_rotation_deg` (3), finds too few pairs or
   makes the fit worse.
4. Measures: each point goes to the nearest element surface within `search_radius_m` (kit, default 0.15 m). Per element:
   points, signed mean (+ outside the face), mean |d|, RMS, p95, max, mean shift x/y/z (mm), tolerance and status
   WITHIN / OFF (p95 > tolerance) / NO-COVERAGE (< `min_points`). Also bands 0-5 / 5-10 / 10-20 / 20-50 / 50-100 / >100 mm
   and how many points matched nothing (clutter, or something not modelled).

## Safety
- Read-only against the model. `dry_run` (default true) measures and answers without writing anything.
- `dry_run: false` writes `<model>_Deviation_<cloud>_<yyyyMMdd-HHmm>.csv` and `.json` in `output_folder` (default
  `reports_dir\PointCloud`), which must be inside `write_roots` or `reports_dir`, never a CDE gate folder or a protected
  original. Files are never overwritten.
- Status PROVISIONAL with the sample spec; `can_pass` only when every checked element is WITHIN on a kit spec.

## Kit file
`03_Master_Data/FMC_PointCloud.json` (sample `server/data/FMC_PointCloud.json`, PROVISIONAL): `categories`,
`tolerance_mm`, `tolerances_mm` by Revit category name, `search_radius_m`, `min_points`.
