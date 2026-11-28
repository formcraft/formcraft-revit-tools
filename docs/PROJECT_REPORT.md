# Project report: one presentation for the whole project (owner 28 Oct 2026)

Owner: "use that very concept ... the hero section as the federated model ... filters to turn off architecture and
leave the structure, plumbing ... the whole project including electrical, plumbing ... the cost estimates should account
for everything ... interior design, cabinets ... plan to do that electrical work later ... make it so that we shall
fill it in. This is a test template project: it has to be a good pioneer."

## How it works
- Each discipline writes ONE package: `<project>\01_WIP\_Report\packages\<discipline>.json`
  `{discipline, label, status: designed | in_progress | not_started, summary, key: [[value, label]],
    model: {boxes: [[x0,y0,z0,x1,y1,z1,b,h]], prisms: [[[xy...], z0, z1]], roofs: [[x0,y0,x1,y1,z0,z1]], lines: [[p,q]]},
    quantities: [{item, qty, unit, rate: [low, likely, high], group}], checks: [[text, done|partial|not]],
    drawings: [png paths], notes: []}` (mm, UGX).
- `scripts/project/report.py <_Report> <out.html>` reads every package: federated 3D with a button per discipline
  (dashed = not modelled yet), "what is counted" board, cost plan (works by discipline, designed vs allowance,
  preliminaries and contingency from `_Report/report.json`), one chapter per discipline, road map, sign-off.
- `scripts/project/packages.py <01_WIP> <_Report>` writes architecture (from the architecture facts) and structure
  (from `_Structure`), and allowance packages for: plumbing & drainage, electrical, mechanical, interiors & joinery,
  fire & security, external works & fence, landscape.
- Rates: `_Report/rates.json` overrides any default (keys as in packages.py, e.g. "concrete", "wall_stone",
  "fence_m"): the QS's rates go there.

## Filling in a discipline (e.g. electrical, when it is designed)
1. Its own exporter (scripts/<discipline>/package.py) reads its Revit model (fixtures, cable trays, DBs, pipes as boxes
   or lines in mm) and its schedules (quantities × rates), sets status "designed", and overwrites its package.
2. Re-run report.py: its allowance disappears, the model appears in the 3D, its chapter fills with real figures.
3. Never hand-edit the page: the packages are the source.

## Rules
- Nothing counted twice: an element belongs to one package (e.g. the boundary wall drawn in the architecture model is
  costed only under external works).
- Every allowance says it is an allowance, with its basis (% of building cost or per m²).
- The report speaks as the presenting engineer (config `presenter`, `firm`); no tool names in the client text.
