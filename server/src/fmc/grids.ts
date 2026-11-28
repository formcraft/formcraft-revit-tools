/**
 * fmc_grids_from_link: copy the grids of one loaded Revit link into the host.
 * The caller never supplies code. The server builds one fixed script and sends it through send_code_to_revit.
 * Only the link id and screened grid names are substituted. The Revit API has no call that creates a
 * Copy/Monitor relationship (PostableCommand.CopyMonitor only opens the UI; GetMonitoredLinkElementIds only reads).
 */
import { screenScript } from "./scriptguard.js";

export interface GridsInput {
  document?: string;
  link?: number | string;
  names?: string[];
  dry_run?: boolean;
}

export interface GridsPlan {
  ok: boolean;
  reasons: string[];
  document: string;
  link: number;
  names: string[];
  dry_run: boolean;
  script?: string;
  params?: Record<string, unknown>;
}

/** A quote or a newline in a grid name would break out of the verbatim string. Reject it; do not escape it in. */
export function scriptLiteralProblem(value: string, label: string): string | null {
  if (/["\r\n\u0000]/.test(value)) return `${label} contains a quote or a newline, so it is not placed in the script. Nothing was sent.`;
  return null;
}

function linkId(value: number | string | undefined): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  return null;
}

function verbatim(value: string): string {
  return '@"' + value + '"';
}

const SCRIPT = `
long linkId = __LINK__;
bool dry = __DRY__;
bool filter = __FILTER__;
var wanted = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { __NAMES__ };
const double tol = 1.0 / 304.8;
Element found = document.GetElement(new ElementId(linkId));
RevitLinkInstance link = found as RevitLinkInstance;
if (link == null) return new { ok = false, message = "link must be the element id of a Revit link instance in this document." };
Document linked = link.GetLinkDocument();
if (linked == null) return new { ok = false, message = "The link is not loaded, so its grids were not copied." };
Transform xform = link.GetTotalTransform();
var placed = new Dictionary<string, Curve>(StringComparer.OrdinalIgnoreCase);
foreach (Grid existing in new FilteredElementCollector(document).OfClass(typeof(Grid)).Cast<Grid>())
  if (!string.IsNullOrEmpty(existing.Name)) placed[existing.Name] = existing.Curve;
var ids = new List<long>();
var madeNames = new List<string>();
var skipped = new List<object>();
var lengths = new List<object>();
bool extentsKept = true;
int skippedCount = 0;
foreach (Grid grid in new FilteredElementCollector(linked).OfClass(typeof(Grid)).Cast<Grid>())
{
  string name = grid.Name ?? "";
  if (name.Length == 0) continue;
  if (filter && !wanted.Contains(name)) continue;
  Curve want = Moved(grid.Curve, xform);
  if (want == null)
  {
    skippedCount++;
    if (skipped.Count < 40) skipped.Add(new { name, reason = "not a horizontal line or arc" });
    continue;
  }
  Curve have;
  if (placed.TryGetValue(name, out have))
  {
    skippedCount++;
    string reason = SamePlace(have, want, tol) ? "already in the host" : "name exists at a different position";
    if (skipped.Count < 40) skipped.Add(new { name, reason });
    continue;
  }
  if (!dry)
  {
    Grid made = Grid.Create(document, want);
    made.Name = name;
    // the link grid's own 3D extents, moved by the link's Z
    try
    {
      Outline ext = grid.GetExtents();
      double bottom = xform.OfPoint(ext.MinimumPoint).Z, top = xform.OfPoint(ext.MaximumPoint).Z;
      if (top - bottom > tol) made.SetVerticalExtents(bottom, top);
    }
    catch (Exception) { extentsKept = false; }
    ids.Add(made.Id.Value);
  }
  if (lengths.Count < 40) lengths.Add(new { name, length_mm = Math.Round(want.Length * 304.8) });
  placed[name] = want;
  madeNames.Add(name);
}
return new { ok = true, dry_run = dry, created = madeNames.Count, skipped = skippedCount, ids, names = madeNames.Take(40).ToList(), skipped_names = skipped, monitored = false, lengths, extents_kept = extentsKept };
Curve Moved(Curve curve, Transform t)
{
  Line line = curve as Line;
  if (line != null)
  {
    XYZ dir = t.OfVector(line.Direction);
    dir = new XYZ(dir.X, dir.Y, 0);
    if (dir.GetLength() < 1e-9) return null;
    dir = dir.Normalize();
    if (line.IsBound)
    {
      // keep the link grid's own length: its two ends, moved and laid flat at Z 0
      XYZ a = t.OfPoint(line.GetEndPoint(0)), b = t.OfPoint(line.GetEndPoint(1));
      a = new XYZ(a.X, a.Y, 0);
      b = new XYZ(b.X, b.Y, 0);
      if (a.DistanceTo(b) < 1e-6) return null;
      return Line.CreateBound(a, b);
    }
    XYZ p = t.OfPoint(line.Origin);
    p = new XYZ(p.X, p.Y, 0);
    return Line.CreateBound(p - dir * 100, p + dir * 100);
  }
  Arc arc = curve as Arc;
  if (arc == null) return null;
  Arc moved = arc.CreateTransformed(t) as Arc;
  if (moved == null) return null;
  XYZ x = new XYZ(moved.XDirection.X, moved.XDirection.Y, 0);
  XYZ y = new XYZ(moved.YDirection.X, moved.YDirection.Y, 0);
  if (x.GetLength() < 1e-9 || y.GetLength() < 1e-9) return null;
  return Arc.Create(new XYZ(moved.Center.X, moved.Center.Y, 0), moved.Radius, moved.GetEndParameter(0), moved.GetEndParameter(1), x.Normalize(), y.Normalize());
}
bool SamePlace(Curve a, Curve b, double tol)
{
  Line la = a as Line, lb = b as Line;
  if (la != null && lb != null)
  {
    if (Math.Abs(Math.Abs(la.Direction.DotProduct(lb.Direction)) - 1) > 1e-6) return false;
    return (lb.Origin - la.Origin).CrossProduct(la.Direction).GetLength() <= tol;
  }
  Arc aa = a as Arc, ab = b as Arc;
  if (aa != null && ab != null) return aa.Center.DistanceTo(ab.Center) <= tol && Math.Abs(aa.Radius - ab.Radius) <= tol;
  return false;
}
`;

export function gridsScript(link: number, names: string[], dry: boolean): string {
  const filter = names.length > 0;
  const list = names.map(verbatim).join(", ");
  const code = SCRIPT
    .replaceAll("__LINK__", String(link))
    .replaceAll("__DRY__", dry ? "true" : "false")
    .replaceAll("__FILTER__", filter ? "true" : "false")
    .replaceAll("__NAMES__", list);
  if (code.includes("__")) throw new Error("[FMC-GRIDS] The script template was not filled. Nothing was sent.");
  const problem = screenScript(code);
  if (problem) throw new Error(problem.message);
  return code;
}

export function planGrids(input: GridsInput): GridsPlan {
  const document = (input.document ?? "").trim();
  const reasons: string[] = [];
  if (!document) reasons.push("document is required: the host model. The active document is not used.");
  const titleProblem = document ? scriptLiteralProblem(document, "document") : null;
  if (titleProblem) reasons.push(titleProblem);
  const link = linkId(input.link);
  if (link == null) reasons.push("link must be the element id of a Revit link instance.");
  const names = (input.names ?? []).map((name) => String(name).trim()).filter(Boolean);
  if (names.length > 200) reasons.push("names lists at most 200 grid names.");
  for (const name of names) {
    const problem = scriptLiteralProblem(name, `grid name ${name}`);
    if (problem) reasons.push(problem);
  }
  const dry = input.dry_run !== false;
  const unique = [...new Set(reasons)];
  if (unique.length || link == null) return { ok: false, reasons: unique, document, link: link ?? 0, names, dry_run: dry };
  let script: string;
  try { script = gridsScript(link, names, dry); }
  catch (error) { return { ok: false, reasons: [error instanceof Error ? error.message : String(error)], document, link, names, dry_run: dry }; }
  return {
    ok: true, reasons: [], document, link, names, dry_run: dry, script,
    params: {
      document,
      code: script,
      parameters: [],
      usings: [],
      transactionMode: dry ? "read_only" : "auto",
      purpose: "Copy grids from a link",
      dry_run: dry,
    },
  };
}

/** After the gate has accepted fmc_grids_from_link, the socket command is the fixed script on the host document. */
export function wireGrids(params: Record<string, unknown>): { command: "send_code_to_revit"; params: Record<string, unknown> } {
  const document = typeof params.document === "string" ? params.document.trim() : "";
  if (!document) throw new Error("[FMC-GRIDS] The script has no host document. Nothing was sent.");
  if (typeof params.code !== "string" || !params.code.trim()) throw new Error("[FMC-GRIDS] The script is missing. Nothing was sent.");
  const dry = params.dry_run !== false && params.transactionMode !== "auto";
  return {
    command: "send_code_to_revit",
    params: {
      code: params.code,
      parameters: [],
      usings: [],
      transactionMode: params.transactionMode === "read_only" || dry ? "read_only" : "auto",
      purpose: "Copy grids from a link",
      document,
    },
  };
}
