/**
 * Property lines (category OST_SiteProperty) for Revit 2025.4 and 2026.
 *
 * There is no public create API in those releases. Autodesk.Revit.DB.PropertyLine exists and inherits Element,
 * and that is the whole public surface: no PropertyLine.Create, no Document.Create.NewPropertyLine, no SiteUtils.
 * send_code that calls PropertyLine.Create fails to compile (CS0117). The methods arrive in Revit 2027
 * (PropertyLine.Create from CurveLoops or from a property table). This build does not call Create, including by
 * reflection: a 2025.4 / 2026 session does not have the method, and a later Revit is reported instead of guessed.
 *
 * UI automation is not used. PostCommand(PostableCommand.PropertyLine) runs only after this API context ends, so it
 * cannot be awaited, and it opens a dialog ("Create by sketching" or "Create by entering distances and bearings")
 * that then enters Pick Lines. Driving that dialog from outside Revit is brittle across 2025 and 2026, languages
 * and focus, and a wrong click sketches into the model. The op selects the lines and posts the command, then
 * returns FMC-NEEDS-HUMAN. It never reports a created id until property_line_verify reads one back.
 *
 * The installed add-in is not changed. Reads and the optional tag go through send_code_to_revit; the command goes
 * through the existing fmc_post_command. A server hot-swap is enough.
 */
import { screenScript } from "./scriptguard.js";

export const CODE_NO_API = "FMC-NO-API-PROPERTYLINE";
export const CODE_NEEDS_HUMAN = "FMC-NEEDS-HUMAN";
export const CODE_CREATE_PRESENT = "FMC-PROPERTYLINE-CREATE-PRESENT";
export const CODE_NO_TAG = "FMC-NO-PROPERTYLINE-TAG";

/** Ends closer than this are the same point. Revit's shortest curve is about 0.8 mm. */
export const JOIN_MM = 1;

export const HUMAN_STEPS =
  "Choose Create by sketching, then Pick Lines, pick the lines, and finish. " +
  "The Property Line command opens that dialog after this call returns. It cannot be awaited, and no property line has been created.";

export const KIT_PROPERTY_LINE_TAG =
  "The Formcraft kit has no property-line tag family. scripts/kitbuild/annotation/tags_spec.py lists no FMC_TAG for " +
  "OST_SitePropertyTags or OST_SitePropertyLineSegmentTags. A segment is tagged only when a tag of that category is already loaded " +
  "(Revit's Property Line Tag, or tag_type as Family: Type). No tag family is created here.";

const MARK = "FMC-PROPERTYLINE-SUMMARY:";

export interface PropertyOp {
  op: string;
  [key: string]: unknown;
}

export type SendCommand = (command: string, params: Record<string, unknown>) => Promise<unknown>;

type Pt = [number, number, number];

export interface ChainSegment {
  id: string;
  a: Pt;
  b: Pt;
}

export type ChainResult =
  | { ok: true; order: string[]; closed: boolean }
  | { ok: false; problems: string[] };

export interface CurveRow {
  id?: unknown;
  missing?: boolean;
  rejected?: string;
  kind?: string;
  owner_view?: string;
  start_mm?: unknown;
  end_mm?: unknown;
}

const NO_API_REASON =
  "Revit 2025 and 2026 have no API that creates a property line. PropertyLine.Create arrives in Revit 2027. " +
  "points_mm was not sent to Revit, and no model line was drawn in its place. Nothing was created.";

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function asPoint(value: unknown): Pt | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) return null;
  if (!value.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return [value[0], value[1], value.length === 3 ? value[2] as number : 0];
}

/** A point list is one chain when every edge is longer than a millimetre and corners meet only as neighbours. */
export function pointLoopProblems(points: unknown, closed: boolean): string[] {
  if (!Array.isArray(points)) return ["points_mm must be a list of [x, y] or [x, y, z] in millimetres"];
  if (points.length > 200) return ["points_mm takes at most 200 points"];
  if (points.length < (closed ? 3 : 2)) {
    return [closed ? "a closed property line needs at least 3 points" : "points_mm needs at least 2 points"];
  }
  const problems: string[] = [];
  const pts: Pt[] = [];
  for (let i = 0; i < points.length; i++) {
    const pt = asPoint(points[i]);
    if (!pt) problems.push(`point ${i + 1} must be [x, y] or [x, y, z] in millimetres`);
    else pts.push(pt);
  }
  if (problems.length || pts.length !== points.length) return problems;
  const explicitClose = dist(pts[0], pts[pts.length - 1]) <= JOIN_MM;
  const ring = explicitClose ? pts.slice(0, -1) : pts;
  if (closed && ring.length < 3) return ["a closed property line needs at least 3 corners"];
  const seq = closed ? [...ring, ring[0]] : ring;
  for (let i = 0; i < seq.length - 1; i++) {
    if (dist(seq[i], seq[i + 1]) <= JOIN_MM) problems.push(`edge ${i + 1} is shorter than ${JOIN_MM} mm`);
  }
  const z = ring.map((p) => p[2]);
  if (Math.max(...z) - Math.min(...z) > JOIN_MM) {
    problems.push("points are not in one horizontal plane (z differs by more than 1 mm). A property line lies in a horizontal plane.");
  }
  for (let i = 0; i < ring.length; i++) {
    for (let j = i + 2; j < ring.length; j++) {
      const closingPair = closed && i === 0 && j === ring.length - 1;
      if (closingPair) continue;
      if (dist(ring[i], ring[j]) <= JOIN_MM) problems.push(`point ${i + 1} meets point ${j + 1}, so the loop is not a simple chain`);
    }
  }
  return problems;
}

type Attempt =
  | { kind: "ok"; order: string[]; start: Pt; end: Pt }
  | { kind: "branch"; at: string }
  | { kind: "gap" };

function planeProblem(segs: ChainSegment[]): string | null {
  const z = segs.flatMap((seg) => [seg.a[2], seg.b[2]]);
  if (Math.max(...z) - Math.min(...z) > JOIN_MM) return "the lines are not in one horizontal plane (z differs by more than 1 mm)";
  return null;
}

function attempt(segs: ChainSegment[], startIndex: number, reverse: boolean): Attempt {
  const used = new Set<number>([startIndex]);
  const first = segs[startIndex];
  const start = reverse ? first.b : first.a;
  let end = reverse ? first.a : first.b;
  const order = [first.id];
  while (used.size < segs.length) {
    const hits: Array<{ index: number; next: Pt }> = [];
    for (let i = 0; i < segs.length; i++) {
      if (used.has(i)) continue;
      const seg = segs[i];
      if (dist(end, seg.a) <= JOIN_MM) hits.push({ index: i, next: seg.b });
      else if (dist(end, seg.b) <= JOIN_MM) hits.push({ index: i, next: seg.a });
    }
    if (hits.length === 0) return { kind: "gap" };
    if (hits.length > 1) return { kind: "branch", at: order[order.length - 1] };
    used.add(hits[0].index);
    order.push(segs[hits[0].index].id);
    end = hits[0].next;
  }
  return { kind: "ok", order, start, end };
}

/** Order model or detail lines into one chain. closed requires the two loose ends to meet. */
export function chainSegments(segs: ChainSegment[], closed: boolean): ChainResult {
  if (segs.length === 0) return { ok: false, problems: ["no lines to chain"] };
  if (segs.length > 200) return { ok: false, problems: ["a property line takes at most 200 lines"] };
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const seg of segs) {
    if (seen.has(seg.id)) problems.push(`line ${seg.id} is repeated`);
    seen.add(seg.id);
    if (dist(seg.a, seg.b) <= JOIN_MM) problems.push(`line ${seg.id} is shorter than ${JOIN_MM} mm`);
  }
  if (problems.length) return { ok: false, problems };
  const flat = planeProblem(segs);
  if (segs.length === 1) {
    if (flat) return { ok: false, problems: [flat] };
    if (closed) return { ok: false, problems: ["one line does not close"] };
    return { ok: true, order: [segs[0].id], closed: false };
  }
  let openChain: { order: string[] } | null = null;
  let branch: string | null = null;
  for (let start = 0; start < segs.length; start++) {
    for (const reverse of [false, true]) {
      const step = attempt(segs, start, reverse);
      if (step.kind === "branch") {
        branch = `more than one line meets at the end of ${step.at}; a property line needs one chain`;
        continue;
      }
      if (step.kind !== "ok") continue;
      const meets = dist(step.end, step.start) <= JOIN_MM;
      if (closed && !meets) {
        openChain = { order: step.order };
        continue;
      }
      if (flat) return { ok: false, problems: [flat] };
      return { ok: true, order: step.order, closed: meets };
    }
  }
  if (branch) return { ok: false, problems: [branch] };
  if (closed && openChain) {
    return { ok: false, problems: ["the lines are one chain but do not close (the ends are more than 1 mm apart)"] };
  }
  return { ok: false, problems: [`the lines are not one contiguous chain (a gap is larger than ${JOIN_MM} mm)`] };
}

function isPropertyOp(op: PropertyOp | null | undefined): boolean {
  if (!op || typeof op !== "object") return false;
  return op.op === "property_line" || op.op === "property_line_verify" || op.op === "property_line_tag";
}

function mentions(op: PropertyOp): boolean {
  if (isPropertyOp(op)) return true;
  if (op.op === "for_each" && Array.isArray(op.ops)) return (op.ops as PropertyOp[]).some((inner) => inner && mentions(inner));
  return false;
}

/** property: this batch is only a property-line op. none: the add-in runs it. mixed / for_each: refuse. */
export function classifyPropertyBatch(ops: PropertyOp[]): "property" | "none" | "mixed" | "for_each" {
  if (ops.some((op) => op?.op === "for_each" && mentions(op))) return "for_each";
  const flagged = ops.filter(isPropertyOp);
  if (flagged.length === 0) return "none";
  if (flagged.length === ops.length) return "property";
  return "mixed";
}

export type PropertyKind = "create" | "verify" | "tag";

export function propertyKind(op: PropertyOp): PropertyKind | null {
  if (op.op === "property_line_verify") return "verify";
  if (op.op === "property_line_tag") return "tag";
  if (op.op !== "property_line") return null;
  if (op.action == null || op.action === "create") return "create";
  if (op.action === "verify") return "verify";
  if (op.action === "tag") return "tag";
  return null;
}

/**
 * The batch tool defaults dry_run to false. This op stays a dry run unless the op itself sets dry_run false,
 * and a batch dry run forces it off. Posting the Property Line command is not rolled back by a transaction.
 */
export function propertyLineIsDry(op: PropertyOp, batchDry: boolean): boolean {
  if (batchDry) return true;
  return op.dry_run !== false;
}

function asId(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function idList(value: unknown, label: string, where: string): { ids: Array<string | number> } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) return { error: `${where}: ${label} needs at least one element id` };
  if (value.length > 200) return { error: `${where}: ${label} takes at most 200 ids` };
  const ids: Array<string | number> = [];
  for (const item of value) {
    const id = asId(item);
    if (id == null) return { error: `${where}: ${label} must be element ids` };
    ids.push(id);
  }
  return { ids };
}

function boolField(value: unknown, label: string, where: string): string | null {
  if (value != null && typeof value !== "boolean") return `${where}: ${label} must be true or false`;
  return null;
}

/** Problems found before Revit. select is already resolved into ids. */
export function validatePropertyOp(op: PropertyOp): string | null {
  const kind = propertyKind(op);
  const where = "property_line";
  if (!kind) return `${where}: action must be create, verify or tag`;
  const dry = boolField(op.dry_run, "dry_run", where);
  if (dry) return dry;
  const closed = boolField(op.closed, "closed", where);
  if (closed) return closed;
  const keep = boolField(op.keep_source, "keep_source", where);
  if (keep) return keep;
  if (op.level != null && typeof op.level !== "string") return `${where}: level must be text`;
  if (op.name != null && typeof op.name !== "string") return `${where}: name must be text`;
  if (kind === "create") {
    const hasPoints = op.points_mm != null;
    const hasIds = op.from_ids != null || op.select != null;
    if (hasPoints && hasIds) return `${where}: give from_ids or points_mm, not both. ${NO_API_REASON}`;
    if (!hasPoints && !hasIds) return `${where}: give from_ids (model or detail line ids) or points_mm`;
    if (hasIds && op.from_ids != null) {
      const ids = idList(op.from_ids, "from_ids", where);
      if ("error" in ids) return ids.error;
    }
    return null;
  }
  if (kind === "verify") {
    if (op.points_mm != null) return `${where}: verify reads property lines that already exist. points_mm cannot create one. ${NO_API_REASON}`;
    if (op.known_ids != null && !Array.isArray(op.known_ids)) return `${where}: known_ids must be a list of property line ids`;
    if (op.delete_source_ids != null) {
      const ids = idList(op.delete_source_ids, "delete_source_ids", where);
      if ("error" in ids) return ids.error;
    }
    return null;
  }
  if (op.view == null || String(op.view).trim() === "") return `${where}: tag needs view`;
  if (op.tag_type != null && typeof op.tag_type !== "string") return `${where}: tag_type must be text`;
  const leader = boolField(op.leader, "leader", where);
  if (leader) return leader;
  if (op.ids != null) {
    const ids = idList(op.ids, "ids", where);
    if ("error" in ids) return ids.error;
  } else if (op.select == null) return `${where}: tag needs ids or select`;
  return null;
}

function summaryLines(op: PropertyOp, kind: PropertyKind, dry: boolean): string[] {
  if (kind === "verify") {
    const drop = Array.isArray(op.delete_source_ids) ? op.delete_source_ids.length : 0;
    return [
      dry || drop === 0
        ? "Read property lines (OST_SiteProperty) and their segments. Nothing is created or deleted."
        : `Read property lines. Source lines are deleted only when a new property line is found (${drop} ids).`,
    ];
  }
  if (kind === "tag") {
    const n = Array.isArray(op.ids) ? op.ids.length : 0;
    return [dry
      ? `Dry run: tag ${n} property line segments in ${op.view}. The transaction is rolled back. Nothing is kept.`
      : `Tag ${n} property line segments in ${op.view}. No tag is kept unless a property-line tag type is already loaded.`];
  }
  const n = Array.isArray(op.from_ids) ? op.from_ids.length : 0;
  if (dry) return [`Read ${n} model or detail lines and check they form one chain. Nothing is posted and nothing is created.`];
  return [
    `Read ${n} model or detail lines. If they form one chain, select them and start Revit's Property Line command.`,
    HUMAN_STEPS,
    "Source lines are kept.",
  ];
}

function scriptCall(code: string, payload: unknown, dry: boolean, document: string | undefined, ids: Array<string | number>, purpose: string) {
  const problem = screenScript(code);
  if (problem) throw new Error(problem.message);
  const params: Record<string, unknown> = {
    code,
    parameters: [JSON.stringify(payload)],
    usings: ["System.Reflection", "Newtonsoft.Json.Linq"],
    transactionMode: dry ? "read_only" : "auto",
    dry_run: dry,
    purpose,
    ...(ids.length ? { elementIds: ids.slice(0, 200) } : {}),
    ...(document ? { document } : {}),
  };
  return params;
}

export function propertyLineApprovalLines(code: string): string[] | null {
  const lines = code.split(/\r?\n/).map((line) => {
    const at = line.indexOf(MARK);
    return at >= 0 ? line.slice(at + MARK.length).trim() : "";
  }).filter(Boolean);
  return lines.length ? lines : null;
}

const CURVE_SCRIPT = `
var raw = parameters != null && parameters.Length > 0 ? parameters[0] as string : null;
if (string.IsNullOrWhiteSpace(raw)) throw new InvalidOperationException("property line batch is missing its payload");
var ask = JObject.Parse(raw);
JArray Pt(XYZ p) { return new JArray(Math.Round(p.X * 304.8, 3), Math.Round(p.Y * 304.8, 3), Math.Round(p.Z * 304.8, 3)); }
Element ById(JToken t)
{
    if (t == null || t.Type == JTokenType.Null) return null;
    if (t.Type == JTokenType.Integer || t.Type == JTokenType.Float)
        return document.GetElement(new ElementId(t.Value<long>()));
    string s = (t.ToString() ?? "").Trim();
    long n;
    if (long.TryParse(s, out n))
    {
        Element e = document.GetElement(new ElementId(n));
        if (e != null) return e;
    }
    return s.Length == 0 ? null : document.GetElement(s);
}
bool createApi = typeof(PropertyLine).GetMethods(BindingFlags.Public | BindingFlags.Static).Any(m => m.Name == "Create");
string active = "";
try { if (document.ActiveView != null) active = document.ActiveView.Name ?? ""; } catch (System.Exception) { }
var curves = new JArray();
foreach (JToken t in (JArray)ask["ids"])
{
    var row = new JObject { ["id"] = t };
    Element e = ById(t);
    if (e == null) { row["missing"] = true; curves.Add(row); continue; }
    row["id"] = e.Id.Value;
    CurveElement ce = e as CurveElement;
    if (ce == null)
    {
        row["kind"] = e.GetType().Name;
        row["rejected"] = "not a model or detail line";
        curves.Add(row);
        continue;
    }
    row["kind"] = e is ModelCurve ? "model" : e is DetailCurve ? "detail" : "curve";
    Curve c = ce.GeometryCurve;
    if (c == null || !c.IsBound) { row["rejected"] = "the line has no bound curve"; curves.Add(row); continue; }
    row["start_mm"] = Pt(c.GetEndPoint(0));
    row["end_mm"] = Pt(c.GetEndPoint(1));
    if (e.OwnerViewId != null && e.OwnerViewId != ElementId.InvalidElementId)
    {
        Element owner = document.GetElement(e.OwnerViewId);
        if (owner != null) row["owner_view"] = owner.Name;
    }
    curves.Add(row);
}
string version = "";
try { version = document.Application.VersionNumber ?? ""; } catch (System.Exception) { }
return new JObject { ["create_api"] = createApi, ["revit"] = version, ["active_view"] = active, ["curves"] = curves };
`.trim();

const VERIFY_SCRIPT = `
var raw = parameters != null && parameters.Length > 0 ? parameters[0] as string : null;
if (string.IsNullOrWhiteSpace(raw)) throw new InvalidOperationException("property line batch is missing its payload");
JArray Pt(XYZ p) { return new JArray(Math.Round(p.X * 304.8, 3), Math.Round(p.Y * 304.8, 3), Math.Round(p.Z * 304.8, 3)); }
void AddCurves(Element e, JArray into)
{
    GeometryElement g = null;
    try { g = e.get_Geometry(new Options()); } catch (System.Exception) { return; }
    if (g == null) return;
    foreach (GeometryObject o in g)
    {
        Curve c = o as Curve;
        if (c != null && c.IsBound) into.Add(new JObject { ["start_mm"] = Pt(c.GetEndPoint(0)), ["end_mm"] = Pt(c.GetEndPoint(1)) });
        GeometryInstance gi = o as GeometryInstance;
        if (gi == null) continue;
        GeometryElement ig = gi.GetInstanceGeometry();
        if (ig == null) continue;
        foreach (GeometryObject io in ig)
        {
            Curve ic = io as Curve;
            if (ic != null && ic.IsBound) into.Add(new JObject { ["start_mm"] = Pt(ic.GetEndPoint(0)), ["end_mm"] = Pt(ic.GetEndPoint(1)) });
        }
    }
}
string Shown(Parameter p)
{
    if (p == null) return "";
    try { return p.AsValueString() ?? ""; } catch (System.Exception) { return ""; }
}
JObject SegRow(Element e)
{
    var row = new JObject { ["id"] = e.Id.Value, ["type_name"] = e.GetType().Name };
    if (e.Category != null) row["category"] = e.Category.Name;
    Parameter dist = e.get_Parameter(BuiltInParameter.PROPERTY_SEGMENT_DISTANCE);
    Parameter bear = e.get_Parameter(BuiltInParameter.PROPERTY_SEGMENT_BEARING);
    Parameter rad = e.get_Parameter(BuiltInParameter.PROPERTY_SEGMENT_RADIUS);
    Parameter lr = e.get_Parameter(BuiltInParameter.PROPERTY_SEGMENT_L_R);
    if (dist != null && dist.StorageType == StorageType.Double) row["distance_mm"] = Math.Round(dist.AsDouble() * 304.8, 3);
    if (dist != null) row["distance_shown"] = Shown(dist);
    if (bear != null && bear.StorageType == StorageType.Double) row["bearing_internal"] = bear.AsDouble();
    if (bear != null) row["bearing_shown"] = Shown(bear);
    if (rad != null && rad.StorageType == StorageType.Double) row["radius_mm"] = Math.Round(rad.AsDouble() * 304.8, 3);
    if (lr != null) row["left_right"] = Shown(lr);
    LocationCurve lc = e.Location as LocationCurve;
    if (lc != null && lc.Curve != null && lc.Curve.IsBound)
        row["curve"] = new JObject { ["start_mm"] = Pt(lc.Curve.GetEndPoint(0)), ["end_mm"] = Pt(lc.Curve.GetEndPoint(1)), ["from"] = "location" };
    return row;
}
JObject SegmentApi()
{
    System.Type t = typeof(PropertyLine).Assembly.GetType("Autodesk.Revit.DB.PropertyLineSegment");
    var row = new JObject { ["found"] = t != null };
    if (t == null) return row;
    var names = new JArray();
    bool curve = false, bearing = false, distance = false;
    foreach (var p in t.GetProperties(BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly))
    {
        names.Add(p.Name);
        if (p.Name == "Curve" && p.GetGetMethod() != null) curve = true;
        if (p.Name == "Bearing" && p.GetGetMethod() != null) bearing = true;
        if (p.Name == "Distance" && p.GetGetMethod() != null) distance = true;
    }
    row["public_properties"] = names;
    row["curve"] = curve;
    row["bearing"] = bearing;
    row["distance"] = distance;
    return row;
}
bool createApi = typeof(PropertyLine).GetMethods(BindingFlags.Public | BindingFlags.Static).Any(m => m.Name == "Create");
var segFilter = new ElementCategoryFilter(BuiltInCategory.OST_SitePropertyLineSegment);
var claimed = new HashSet<long>();
var lines = new JArray();
foreach (Element line in new FilteredElementCollector(document).OfClass(typeof(PropertyLine)).ToElements())
{
    var segs = new JArray();
    try
    {
        foreach (ElementId id in line.GetDependentElements(segFilter))
        {
            Element seg = document.GetElement(id);
            if (seg == null) continue;
            claimed.Add(id.Value);
            segs.Add(SegRow(seg));
        }
    }
    catch (System.Exception) { }
    var curves = new JArray();
    AddCurves(line, curves);
    string name = "";
    try { name = line.Name ?? ""; } catch (System.Exception) { }
    int count = segs.Count > 0 ? segs.Count : curves.Count;
    lines.Add(new JObject
    {
        ["id"] = line.Id.Value, ["name"] = name, ["unique_id"] = line.UniqueId,
        ["segment_count"] = count, ["segments_from"] = segs.Count > 0 ? "category" : "geometry",
        ["segments"] = segs, ["curves"] = curves,
    });
}
var unmatched = new JArray();
foreach (Element seg in new FilteredElementCollector(document).OfCategory(BuiltInCategory.OST_SitePropertyLineSegment).WhereElementIsNotElementType().ToElements())
{
    if (claimed.Contains(seg.Id.Value)) continue;
    unmatched.Add(SegRow(seg));
}
string version = "";
try { version = document.Application.VersionNumber ?? ""; } catch (System.Exception) { }
return new JObject
{
    ["create_api"] = createApi, ["revit"] = version,
    ["property_line_segment_type"] = SegmentApi(),
    ["property_lines"] = lines, ["unmatched_segments"] = unmatched,
};
`.trim();

const TAG_SCRIPT = `
var raw = parameters != null && parameters.Length > 0 ? parameters[0] as string : null;
if (string.IsNullOrWhiteSpace(raw)) throw new InvalidOperationException("property line batch is missing its payload");
var ask = JObject.Parse(raw);
Element ById(JToken t)
{
    if (t == null || t.Type == JTokenType.Null) return null;
    if (t.Type == JTokenType.Integer || t.Type == JTokenType.Float)
        return document.GetElement(new ElementId(t.Value<long>()));
    string s = (t.ToString() ?? "").Trim();
    long n;
    if (long.TryParse(s, out n))
    {
        Element e = document.GetElement(new ElementId(n));
        if (e != null) return e;
    }
    return s.Length == 0 ? null : document.GetElement(s);
}
View ViewOf(string text)
{
    text = (text ?? "").Trim();
    long n;
    if (long.TryParse(text, out n))
    {
        View byId = document.GetElement(new ElementId(n)) as View;
        if (byId != null) return byId;
    }
    foreach (View v in new FilteredElementCollector(document).OfClass(typeof(View)).Cast<View>())
    {
        if (v.IsTemplate) continue;
        if (string.Equals(v.Name, text, System.StringComparison.OrdinalIgnoreCase)) return v;
    }
    throw new InvalidOperationException("no view " + text);
}
bool IsSegTag(FamilySymbol s)
{
    return s != null && s.Category != null && s.Category.Id.Value == (long)BuiltInCategory.OST_SitePropertyLineSegmentTags;
}
var symbols = new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().Where(IsSegTag).ToList();
string want = (ask.Value<string>("tag_type") ?? "").Trim();
FamilySymbol sym = null;
if (want.Length == 0)
{
    sym = symbols.FirstOrDefault(s => s.FamilyName != null && s.FamilyName.StartsWith("FMC_", System.StringComparison.OrdinalIgnoreCase));
    if (sym == null) sym = symbols.FirstOrDefault(s =>
        (s.FamilyName != null && s.FamilyName.IndexOf("Property Line", System.StringComparison.OrdinalIgnoreCase) >= 0)
        || (s.Name != null && s.Name.IndexOf("Property Line", System.StringComparison.OrdinalIgnoreCase) >= 0));
    if (sym == null) sym = symbols.FirstOrDefault();
}
else
{
    int colon = want.IndexOf(':');
    if (colon > 0)
    {
        string fam = want.Substring(0, colon).Trim();
        string typ = want.Substring(colon + 1).Trim();
        sym = symbols.FirstOrDefault(s => s.FamilyName != null && s.Name != null
            && string.Equals(s.FamilyName, fam, System.StringComparison.OrdinalIgnoreCase)
            && string.Equals(s.Name, typ, System.StringComparison.OrdinalIgnoreCase));
    }
    if (sym == null) sym = symbols.FirstOrDefault(s =>
        string.Equals(s.FamilyName, want, System.StringComparison.OrdinalIgnoreCase)
        || string.Equals(s.Name, want, System.StringComparison.OrdinalIgnoreCase)
        || string.Equals(s.FamilyName + ": " + s.Name, want, System.StringComparison.OrdinalIgnoreCase));
}
if (sym == null)
    throw new InvalidOperationException("FMC-NO-PROPERTYLINE-TAG: no Site Property Line Segment tag is loaded. The Formcraft kit has no property-line tag family. Load Revit's Property Line Tag, or pass tag_type as Family: Type. Nothing was tagged.");
if (!sym.IsActive) sym.Activate();
View view = ViewOf(ask.Value<string>("view"));
bool leader = ask.Value<bool?>("leader") ?? true;
var targets = new List<Element>();
var skipped = new JArray();
var segFilter = new ElementCategoryFilter(BuiltInCategory.OST_SitePropertyLineSegment);
foreach (JToken t in (JArray)ask["ids"])
{
    Element e = ById(t);
    if (e == null) { skipped.Add(new JObject { ["id"] = t, ["reason"] = "not in the document" }); continue; }
    if (e is PropertyLine)
    {
        int added = 0;
        try
        {
            foreach (ElementId id in e.GetDependentElements(segFilter))
            {
                Element seg = document.GetElement(id);
                if (seg == null) continue;
                targets.Add(seg);
                added++;
            }
        }
        catch (System.Exception) { }
        if (added == 0) skipped.Add(new JObject { ["id"] = e.Id.Value, ["reason"] = "the property line has no segment elements to tag" });
        continue;
    }
    if (e.Category != null && e.Category.Id.Value == (long)BuiltInCategory.OST_SitePropertyLineSegment) { targets.Add(e); continue; }
    skipped.Add(new JObject { ["id"] = e.Id.Value, ["reason"] = "not a property line or a property line segment" });
}
var created = new JArray();
foreach (Element target in targets)
{
    Reference r = new Reference(target);
    XYZ p;
    LocationCurve lc = target.Location as LocationCurve;
    if (lc != null && lc.Curve != null) p = lc.Curve.Evaluate(0.5, true);
    else
    {
        BoundingBoxXYZ bb = target.get_BoundingBox(null);
        if (bb == null) { skipped.Add(new JObject { ["id"] = target.Id.Value, ["reason"] = "no point to tag" }); continue; }
        p = (bb.Min + bb.Max) / 2.0;
    }
    IndependentTag tag = IndependentTag.Create(document, view.Id, r, leader, TagMode.TM_ADDBY_CATEGORY, TagOrientation.Horizontal, p);
    if (tag.GetTypeId() != sym.Id) tag.ChangeTypeId(sym.Id);
    created.Add(tag.Id.Value);
}
return new JObject
{
    ["tag_type"] = sym.FamilyName + ": " + sym.Name,
    ["created_ids"] = created, ["skipped"] = skipped,
    ["segment_count"] = targets.Count,
    ["counts"] = new JObject { ["created"] = created.Count, ["skipped"] = skipped.Count },
};
`.trim();

const DELETE_SOURCE_SCRIPT = `
var raw = parameters != null && parameters.Length > 0 ? parameters[0] as string : null;
if (string.IsNullOrWhiteSpace(raw)) throw new InvalidOperationException("property line batch is missing its payload");
var ask = JObject.Parse(raw);
Element ById(JToken t)
{
    if (t == null || t.Type == JTokenType.Null) return null;
    if (t.Type == JTokenType.Integer || t.Type == JTokenType.Float)
        return document.GetElement(new ElementId(t.Value<long>()));
    string s = (t.ToString() ?? "").Trim();
    long n;
    if (long.TryParse(s, out n))
    {
        Element e = document.GetElement(new ElementId(n));
        if (e != null) return e;
    }
    return s.Length == 0 ? null : document.GetElement(s);
}
var deleted = new JArray();
var missing = new JArray();
foreach (JToken t in (JArray)ask["ids"])
{
    Element e = ById(t);
    if (e == null) { missing.Add(t); continue; }
    if (e is PropertyLine) throw new InvalidOperationException(e.Id.Value + " is a property line. Source lines are model or detail lines. Nothing was deleted.");
    if (!(e is CurveElement)) throw new InvalidOperationException(e.Id.Value + " is not a model or detail line. Nothing was deleted.");
    document.Delete(e.Id);
    deleted.Add(e.Id.Value);
}
return new JObject { ["deleted_ids"] = deleted, ["missing_ids"] = missing };
`.trim();

function withSummary(body: string, lines: string[]): string {
  return lines.map((line) => `// ${MARK} ${line}`).join("\n") + "\n" + body;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseResult(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try { return parseResult(JSON.parse(value)); } catch { return null; }
  }
  return asRecord(value);
}

function fail(body: Record<string, unknown>): { body: Record<string, unknown>; isError: boolean } {
  return { isError: true, body: { applied: false, created: false, created_id: null, ...body } };
}

async function call(send: SendCommand, command: string, params: Record<string, unknown>) {
  try {
    return { ok: true as const, value: await send(command, params) };
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
  }
}

function sentResult(value: unknown, dry: boolean): { ok: true; result: Record<string, unknown>; document?: Record<string, unknown> } | { ok: false; body: Record<string, unknown> } {
  const row = asRecord(value) ?? {};
  const stamped = asRecord(row.document);
  if (row.success === false) {
    const message = String(row.errorMessage || row.error || "Revit rolled the script back. Nothing was changed.");
    return {
      ok: false,
      body: {
        applied: false, dry_run: dry, created: false, created_id: null, rolled_back: true,
        reason: message,
        ...(String(message).includes(CODE_NO_TAG) ? { code: CODE_NO_TAG, kit_tag_family: null, kit_note: KIT_PROPERTY_LINE_TAG } : {}),
        ...(typeof row.errorCode === "string" ? { errorCode: row.errorCode } : {}),
        ...(stamped ? { document: stamped } : {}),
      },
    };
  }
  const result = parseResult(row.result) ?? parseResult(row);
  if (!result) return { ok: false, body: { applied: false, dry_run: dry, created: false, reason: "Revit returned no property-line result. Nothing was changed." } };
  return { ok: true, result, ...(stamped ? { document: stamped } : {}) };
}

async function resolveSelect(op: PropertyOp, key: "from_ids" | "ids", send: SendCommand): Promise<PropertyOp> {
  if (!op.select || typeof op.select !== "object" || Array.isArray(op.select)) return op;
  const query = { ...(op.select as Record<string, unknown>) };
  if (query.limit == null) query.limit = 500;
  const found = asRecord(await send("fmc_select_by", query));
  const selected = Array.isArray(found?.ids) ? found.ids : [];
  const ids = [...(Array.isArray(op[key]) ? op[key] as unknown[] : []), ...selected];
  const seen = new Set<string>();
  const unique: Array<string | number> = [];
  for (const id of ids) {
    const item = asId(id);
    if (item == null || seen.has(String(item))) continue;
    seen.add(String(item));
    unique.push(item);
  }
  const { select: _select, ...rest } = op;
  return { ...rest, [key]: unique };
}

function curveRows(result: Record<string, unknown>): CurveRow[] {
  return Array.isArray(result.curves) ? result.curves as CurveRow[] : [];
}

export function problemsFromCurves(rows: CurveRow[], closed: boolean, activeView = ""): { problems: string[]; chain: ChainResult | null } {
  const problems: string[] = [];
  const segs: ChainSegment[] = [];
  const detailViews = new Set<string>();
  for (const row of rows) {
    const id = row.id == null ? "?" : String(row.id);
    if (row.missing) { problems.push(`${id} is not in the document`); continue; }
    if (row.rejected) { problems.push(`${id}: ${row.rejected}`); continue; }
    const a = asPoint(row.start_mm);
    const b = asPoint(row.end_mm);
    if (!a || !b) { problems.push(`${id} has no endpoints`); continue; }
    if (row.kind === "detail") detailViews.add(row.owner_view || "");
    segs.push({ id, a, b });
  }
  if (detailViews.size > 1) problems.push("detail lines belong to more than one view; Pick Lines can see only the active view");
  const detailView = detailViews.size === 1 ? [...detailViews][0] : "";
  if (detailView && activeView && detailView !== activeView) {
    problems.push(`detail lines belong to ${detailView}, but the active view is ${activeView}. Open ${detailView}, then run this op again. Nothing was posted.`);
  }
  if (problems.length) return { problems, chain: null };
  const chain = chainSegments(segs, closed);
  if (!chain.ok) return { problems: chain.problems, chain };
  return { problems: [], chain };
}

function notApplied(op: PropertyOp): Record<string, unknown> {
  return {
    ...(typeof op.level === "string" && op.level.trim() ? { level: op.level.trim(), level_applied: false } : {}),
    ...(typeof op.name === "string" && op.name.trim() ? { name: op.name.trim(), name_applied: false } : {}),
  };
}

function keepNote(op: PropertyOp, ids: Array<string | number>): Record<string, unknown> {
  const keep = op.keep_source !== false;
  return {
    keep_source: keep,
    source_kept: true,
    source_ids: ids,
    ...(keep ? {} : {
      delete_after_verify: ids,
      keep_note: "keep_source false does not delete the lines now. The Property Line command cannot be awaited, so deleting first would remove the lines you have to pick. After property_line_verify reports a new property line, pass these ids as delete_source_ids.",
    }),
  };
}

async function runCreate(op: PropertyOp, batchDry: boolean, document: string | undefined, send: SendCommand) {
  const dry = propertyLineIsDry(op, batchDry);
  const closed = op.closed !== false;
  if (op.points_mm != null) {
    const problems = pointLoopProblems(op.points_mm, closed);
    return fail({
      dry_run: dry,
      code: CODE_NO_API,
      reason: NO_API_REASON,
      ...(problems.length ? { problems } : { loop: "closed and contiguous" }),
      closed,
      posted: false,
      addin_rebuild: false,
      ...notApplied(op),
    });
  }
  const ids = idList(op.from_ids, "from_ids", "property_line");
  if ("error" in ids) return fail({ dry_run: dry, reason: ids.error, posted: false });
  const lines = summaryLines({ ...op, from_ids: ids.ids }, "create", true);
  const read = await call(send, "send_code_to_revit", scriptCall(
    withSummary(CURVE_SCRIPT, lines),
    { ids: ids.ids },
    true,
    document,
    ids.ids,
    "read lines for a property line",
  ));
  if (!read.ok) return fail({ dry_run: dry, reason: read.message, posted: false, source_kept: true });
  const parsed = sentResult(read.value, true);
  if (!parsed.ok) return fail({ ...parsed.body, dry_run: dry, posted: false, source_kept: true });
  const rows = curveRows(parsed.result);
  const checked = problemsFromCurves(rows, closed, String(parsed.result.active_view ?? ""));
  const base = {
    dry_run: dry,
    closed,
    posted: false,
    addin_rebuild: false,
    create_api: parsed.result.create_api === true,
    revit: parsed.result.revit,
    active_view: parsed.result.active_view,
    ...notApplied(op),
    ...keepNote(op, ids.ids),
    ...(parsed.document ? { document: parsed.document } : {}),
  };
  if (checked.problems.length) return fail({ ...base, problems: checked.problems, reason: checked.problems[0] });
  const chain = checked.chain;
  if (!chain || !chain.ok) return fail({ ...base, reason: "the lines could not be chained" });
  const loop = { closed: chain.closed, ordered_ids: chain.order, join_mm: JOIN_MM };
  if (parsed.result.create_api === true) {
    return fail({
      ...base,
      loop,
      code: CODE_CREATE_PRESENT,
      reason: "This Revit has PropertyLine.Create (added in Revit 2027). This op targets 2025.4 and 2026, where that method does not exist, and it does not call Create. Nothing was posted and nothing was created.",
    });
  }
  if (dry) {
    return {
      isError: false,
      body: {
        ...base,
        applied: false,
        created: false,
        created_id: null,
        segment_count: null,
        loop,
        code: CODE_NEEDS_HUMAN,
        instructions: HUMAN_STEPS,
        reason: "Dry run: the lines form one chain. Nothing was posted. Set dry_run false on this op to select the lines and start the Property Line command. That still does not create the property line; a person finishes the dialog.",
      },
    };
  }
  const selectIds = chain.order.map((id) => (/^\d+$/.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : id));
  const posted = await call(send, "fmc_post_command", {
    command: "PropertyLine",
    select_ids: selectIds,
    ...(document ? { document } : {}),
  });
  if (!posted.ok) {
    const plan = /can't start|cannot start/i.test(posted.message);
    return fail({
      ...base,
      loop,
      code: CODE_NEEDS_HUMAN,
      reason: posted.message,
      ...(plan ? { instructions: `Open a plan view (a site plan is the usual one), then run this op again with dry_run false. ${HUMAN_STEPS}` } : {}),
    });
  }
  const started = asRecord(posted.value);
  return fail({
    ...base,
    posted: true,
    command: "PropertyLine",
    selected: Array.isArray(started?.selected) ? started.selected : selectIds,
    loop,
    segment_count: null,
    code: CODE_NEEDS_HUMAN,
    instructions: HUMAN_STEPS,
    reason: "The lines are selected and Revit's Property Line command was posted. No property line was created by this call.",
    next: "When the sketch is finished, call property_line_verify with known_ids of the property lines that existed before this command.",
  });
}

function knownSet(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) return null;
  return new Set(value.map((id) => String(id)));
}

async function runVerify(op: PropertyOp, batchDry: boolean, document: string | undefined, send: SendCommand) {
  const dry = propertyLineIsDry(op, batchDry);
  const lines = summaryLines(op, "verify", dry);
  const read = await call(send, "send_code_to_revit", scriptCall(
    withSummary(VERIFY_SCRIPT, lines),
    {},
    true,
    document,
    [],
    "read property lines",
  ));
  if (!read.ok) return fail({ dry_run: true, reason: read.message });
  const parsed = sentResult(read.value, true);
  if (!parsed.ok) return fail(parsed.body);
  const linesOut = Array.isArray(parsed.result.property_lines) ? parsed.result.property_lines as Array<Record<string, unknown>> : [];
  const known = knownSet(op.known_ids);
  const newLines = known ? linesOut.filter((line) => !known.has(String(line.id))) : null;
  const segmentCount = (newLines ?? linesOut).reduce((sum, line) => sum + (typeof line.segment_count === "number" ? line.segment_count : 0), 0);
  const body: Record<string, unknown> = {
    applied: false,
    dry_run: true,
    created: false,
    created_id: newLines && newLines.length === 1 ? newLines[0].id : null,
    segment_count: segmentCount,
    create_api: parsed.result.create_api === true,
    revit: parsed.result.revit,
    property_line_segment_type: parsed.result.property_line_segment_type,
    property_lines: linesOut,
    unmatched_segments: parsed.result.unmatched_segments,
    ...(newLines ? { new_ids: newLines.map((line) => line.id) } : { new_ids: null, note: "Pass known_ids (the property line ids from before the command) to tell which line is new." }),
    addin_rebuild: false,
    source_kept: true,
    ...(parsed.document ? { document: parsed.document } : {}),
  };
  const segmentApi = asRecord(parsed.result.property_line_segment_type);
  body.segment_members = {
    curve: segmentApi?.curve === true,
    bearing: segmentApi?.bearing === true,
    distance: segmentApi?.distance === true,
    parameters: "PROPERTY_SEGMENT_DISTANCE, PROPERTY_SEGMENT_BEARING, PROPERTY_SEGMENT_RADIUS and PROPERTY_SEGMENT_L_R are read when the element has them. They are not a create API.",
  };
  const deleteIds = Array.isArray(op.delete_source_ids) ? op.delete_source_ids : [];
  if (deleteIds.length === 0) return { isError: false, body };
  if (dry) {
    body.would_delete = deleteIds;
    body.keep_note = "Dry run: source lines were not deleted. Set dry_run false on this op after a new property line is listed in new_ids.";
    return { isError: false, body };
  }
  if (!known) {
    return fail({
      ...body,
      code: CODE_NEEDS_HUMAN,
      reason: "delete_source_ids needs known_ids so a new property line can be told apart from lines that were already there. Nothing was deleted.",
    });
  }
  if (!newLines || newLines.length === 0) {
    return fail({
      ...body,
      reason: "No new property line was found, so the source lines were kept. Nothing was deleted.",
    });
  }
  const drop = await call(send, "send_code_to_revit", scriptCall(
    withSummary(DELETE_SOURCE_SCRIPT, ["Delete the source model or detail lines. A new property line was found first. A property line is never deleted by this op."]),
    { ids: deleteIds },
    false,
    document,
    deleteIds.filter((id) => typeof id === "number" || typeof id === "string"),
    "delete property line source lines",
  ));
  if (!drop.ok) return fail({ ...body, source_kept: true, reason: drop.message });
  const dropped = sentResult(drop.value, false);
  if (!dropped.ok) return fail({ ...body, source_kept: true, ...dropped.body, reason: dropped.body.reason });
  body.source_kept = false;
  body.deleted_ids = dropped.result.deleted_ids;
  body.missing_ids = dropped.result.missing_ids;
  body.dry_run = false;
  body.applied = true;
  return { isError: false, body };
}

async function runTag(op: PropertyOp, batchDry: boolean, document: string | undefined, send: SendCommand) {
  const dry = propertyLineIsDry(op, batchDry);
  const ids = idList(op.ids, "ids", "property_line");
  if ("error" in ids) return fail({ dry_run: dry, reason: ids.error, kit_tag_family: null, kit_note: KIT_PROPERTY_LINE_TAG });
  const lines = summaryLines({ ...op, ids: ids.ids }, "tag", dry);
  const sent = await call(send, "send_code_to_revit", scriptCall(
    withSummary(TAG_SCRIPT, lines),
    { view: op.view, ids: ids.ids, tag_type: typeof op.tag_type === "string" ? op.tag_type : "", leader: op.leader !== false },
    dry,
    document,
    ids.ids,
    "tag property line segments",
  ));
  if (!sent.ok) {
    const code = sent.message.includes(CODE_NO_TAG) ? CODE_NO_TAG : undefined;
    return fail({ dry_run: dry, reason: sent.message, ...(code ? { code } : {}), kit_tag_family: null, kit_note: KIT_PROPERTY_LINE_TAG });
  }
  const parsed = sentResult(sent.value, dry);
  if (!parsed.ok) return fail({ ...parsed.body, kit_tag_family: null, kit_note: KIT_PROPERTY_LINE_TAG });
  return {
    isError: false,
    body: {
      applied: dry ? false : true,
      dry_run: dry,
      created: !dry && Array.isArray(parsed.result.created_ids) && parsed.result.created_ids.length > 0,
      created_id: null,
      created_ids: parsed.result.created_ids,
      tag_type: parsed.result.tag_type,
      skipped: parsed.result.skipped,
      segment_count: parsed.result.segment_count,
      counts: parsed.result.counts,
      kit_tag_family: null,
      kit_note: KIT_PROPERTY_LINE_TAG,
      addin_rebuild: false,
      ...(parsed.document ? { document: parsed.document } : {}),
      ...(dry ? { note: "Dry run: tags were rolled back. Nothing was kept." } : {}),
    },
  };
}

const MIXED = "Put property_line, property_line_verify and property_line_tag in their own modify_model call. They do not run inside the add-in's batch. Other ops stay on the add-in.";

/**
 * Runs one property-line op. Returns null when the batch belongs to the add-in.
 * Refuses a mix, and a for_each that contains one, before anything is sent.
 */
export async function executePropertyLineBatch(
  ops: PropertyOp[],
  batchDry: boolean,
  document: string | undefined,
  send: SendCommand,
): Promise<{ body: Record<string, unknown>; isError: boolean } | null> {
  const kind = classifyPropertyBatch(ops);
  if (kind === "none") return null;
  if (kind === "for_each") {
    return fail({ reason: "A for_each that creates a property line is not run on this path. Pass from_ids. Nothing was changed." });
  }
  if (kind === "mixed") return fail({ reason: MIXED });
  if (ops.length !== 1) return fail({ reason: "One property line op per modify_model call. Nothing was sent." });
  let op = ops[0];
  const which = propertyKind(op);
  if (!which) return fail({ reason: validatePropertyOp(op) ?? "property_line action must be create, verify or tag" });
  const early = validatePropertyOp(op);
  if (early) {
    const points = op.points_mm != null;
    return fail({ reason: early, ...(points ? { code: CODE_NO_API, posted: false } : {}) });
  }
  if (which === "create" && op.select) op = await resolveSelect(op, "from_ids", send);
  if (which === "tag" && op.select) op = await resolveSelect(op, "ids", send);
  const problem = validatePropertyOp(op);
  if (problem) {
    const points = op.points_mm != null;
    return fail({ reason: problem, ...(points ? { code: CODE_NO_API, posted: false } : {}) });
  }
  if (which === "create") return runCreate(op, batchDry, document, send);
  if (which === "verify") return runVerify(op, batchDry, document, send);
  return runTag(op, batchDry, document, send);
}

export const PROPERTY_LINE_SCRIPTS = {
  curves: CURVE_SCRIPT,
  verify: VERIFY_SCRIPT,
  tag: TAG_SCRIPT,
  deleteSource: DELETE_SOURCE_SCRIPT,
};
