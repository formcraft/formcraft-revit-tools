// @addon strips_on_room_walls  @version 1.0  @writes model  @dryrun yes
// @does Perimeter LED strips on the walls of each room at a height, one per straight wall segment, with an optional vertical corner run (from KISIC 04, 15 and 18).
// @params {"rooms":[],"type":"","height_mm":2850,"inset_mm":30,"min_segment_mm":300,"walls":"all","length_param":"Length","switch":"","switch_param":"FMC Switch","comment":"Strip {room} horizontal","corners":{},"corner_base_mm":300,"corner_run_mm":2500,"corner_comment":"Strip {room} vertical corner","replace":true,"face_tolerance_mm":50}
// @required rooms,type
// @returns {"dry_run":bool,"placed":n,"total_m":x,"rooms":[{"room":"06","placed":n,"metres":x}],"replaced":n,"skipped":["..."],"ids":[...]}
// @usings Newtonsoft.Json.Linq
//
// rooms: room numbers (or names), or ["all"]. type: "Family:Type" of a face-based strip family already loaded (the kit's
// FMC_E_LightFixture_StripLED). walls: "all" or the sides to light, e.g. "N,W" (the side of the room the wall is on).
// corners: {"<room>": "NW" | <segment index>}: a vertical run of corner_run_mm from corner_base_mm at that corner.
// switch: the switch group, written to the shared parameter "FMC Switch". replace: first deletes strips of the same
// family in those rooms whose Comments match, so a re-run doesn't double them. Heights are above the room's level.
// Lessons encoded (docs/handoff/KISIC_GAP_SCRIPTS.md §6):
//   1  one transaction through FmcScript.Tx: commits, rolls back on any error, a dry run rolls back;
//   2  the wall face is found by projecting a probe at the segment's middle onto HostObjectUtils.GetSideFaces (nearest wins);
//   4  Revit's Switch ID is read-only on fittings: the switch goes in the shared parameter "FMC Switch";
//   5  OfClass(FamilyInstance) before the cast (DirectShapes share categories);
//   6  locals inside lambdas and loops have their own names (CS0136).
var args = FmcScript.Params(parameters);
bool dryRun = FmcScript.IsDryRun(parameters);
var roomKeys = ((args["rooms"] as JArray) ?? new JArray()).Select(t => ((string)t ?? "").Trim()).Where(s => s.Length > 0).ToList();
string typeKey = ((string)args["type"] ?? "").Trim();
double heightMm = (double?)args["height_mm"] ?? 2850;
double insetMm = (double?)args["inset_mm"] ?? 30;
double minSegMm = (double?)args["min_segment_mm"] ?? 300;
string wallsArg = ((string)args["walls"] ?? "all").Trim().ToUpperInvariant();
string lengthParam = (string)args["length_param"] ?? "Length";
string switchValue = ((string)args["switch"] ?? "").Trim();
string switchParam = (string)args["switch_param"] ?? "FMC Switch";
string commentTpl = (string)args["comment"] ?? "Strip {room} horizontal";
var corners = (args["corners"] as JObject) ?? new JObject();
double cornerBaseMm = (double?)args["corner_base_mm"] ?? 300;
double cornerRunMm = (double?)args["corner_run_mm"] ?? 2500;
string cornerTpl = (string)args["corner_comment"] ?? "Strip {room} vertical corner";
bool replace = (bool?)args["replace"] ?? true;
double faceTolMm = (double?)args["face_tolerance_mm"] ?? 50;

if (roomKeys.Count == 0) throw new ArgumentException("rooms is required: room numbers, or [\"all\"]");
if (heightMm <= 0 || insetMm < 0 || minSegMm <= 0 || faceTolMm <= 0 || cornerRunMm < 0) throw new ArgumentException("heights, inset and tolerances must be positive");
var sides = wallsArg == "ALL" ? new HashSet<string> { "N", "E", "S", "W" } : new HashSet<string>(wallsArg.Split(',').Select(s => s.Trim()).Where(s => s.Length > 0));
if (sides.Count == 0 || sides.Any(s => s != "N" && s != "E" && s != "S" && s != "W")) throw new ArgumentException($"walls is \"all\" or sides from N,E,S,W, not \"{wallsArg}\"");

// The strip type: "Family:Type", loaded and face-based (kit data comes from the kit: this add-on never loads a family).
string[] typeParts = typeKey.Split(new[] { ':' }, 2);
if (typeParts.Length != 2) throw new ArgumentException($"type is \"Family:Type\", not \"{typeKey}\"");
FamilySymbol strip = new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>()
    .FirstOrDefault(s => s.FamilyName == typeParts[0].Trim() && s.Name == typeParts[1].Trim());
if (strip == null) throw new ArgumentException($"{typeKey} is not loaded in {document.Title}: load the kit family first (Setup › Families or fmc_library)");
if (strip.Family.FamilyPlacementType != FamilyPlacementType.WorkPlaneBased) throw new ArgumentException($"{typeKey} is not face-based, so it can't sit on a wall face");

var allRooms = new FilteredElementCollector(document).OfCategory(BuiltInCategory.OST_Rooms).WhereElementIsNotElementType()
    .OfType<Room>().Where(r => r.Area > 0 && r.Location != null).ToList();
var rooms = roomKeys.Count == 1 && roomKeys[0].Equals("all", StringComparison.OrdinalIgnoreCase)
    ? allRooms
    : roomKeys.Select(k => allRooms.FirstOrDefault(r => r.Number == k) ?? allRooms.FirstOrDefault(r => string.Equals(r.Name, k, StringComparison.OrdinalIgnoreCase))).ToList();
var unknownRooms = roomKeys.Where((k, i) => !(roomKeys.Count == 1 && k.Equals("all", StringComparison.OrdinalIgnoreCase)) && rooms[i] == null).ToList();
if (unknownRooms.Count > 0) throw new ArgumentException("No placed room with the number or name: " + string.Join(", ", unknownRooms));

string Render(string tpl, Room forRoom, string side) => tpl.Replace("{room}", forRoom.Number).Replace("{side}", side);
string CommentOf(Element el) => el.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString() ?? "";

// Lesson 2: the wall side face nearest a probe point, within the tolerance.
(Reference faceRef, XYZ offset) WallFace(Wall wall, XYZ probe)
{
    Reference best = null; XYZ bestOffset = null; double bestDist = FmcScript.Mm(faceTolMm);
    foreach (ShellLayerType shell in new[] { ShellLayerType.Interior, ShellLayerType.Exterior })
        foreach (Reference sideRef in HostObjectUtils.GetSideFaces(wall, shell))
        {
            var face = wall.GetGeometryObjectFromReference(sideRef) as Face;
            IntersectionResult hit = face?.Project(probe);
            if (hit == null || hit.Distance > bestDist) continue;
            bestDist = hit.Distance; best = sideRef; bestOffset = hit.XYZPoint - probe;
        }
    return (best, bestOffset);
}

// The side of the room a straight segment is on, from its outward normal (Revit's outer loop runs anticlockwise).
string SideOf(XYZ dirAlong, bool anticlockwise)
{
    XYZ outward = anticlockwise ? new XYZ(dirAlong.Y, -dirAlong.X, 0) : new XYZ(-dirAlong.Y, dirAlong.X, 0);
    return Math.Abs(outward.X) >= Math.Abs(outward.Y) ? (outward.X > 0 ? "E" : "W") : (outward.Y > 0 ? "N" : "S");
}

var boundaryOptions = new SpatialElementBoundaryOptions { SpatialElementBoundaryLocation = SpatialElementBoundaryLocation.Finish };
var summary = FmcScript.Tx(document, "FMC add-on strips_on_room_walls", dryRun, () =>
{
    int placed = 0, replaced = 0;
    double totalFt = 0;
    var perRoom = new List<object>();
    var skipped = new List<string>();
    var ids = new List<long>();
    bool noLength = false, noSwitch = false;

    FamilyInstance Place(Reference onFace, XYZ at, XYZ along, double lengthFt, string comment)
    {
        FamilyInstance fi = document.Create.NewFamilyInstance(onFace, at, along, strip);
        Parameter len = fi.LookupParameter(lengthParam);
        if (len != null && !len.IsReadOnly) len.Set(lengthFt); else noLength = true;
        fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.Set(comment);
        if (switchValue.Length > 0)
        {
            Parameter sw = fi.LookupParameter(switchParam);
            if (sw != null && !sw.IsReadOnly) sw.Set(switchValue); else noSwitch = true;
        }
        ids.Add(fi.Id.Value);
        placed++;
        totalFt += lengthFt;
        return fi;
    }

    foreach (Room room in rooms)
    {
        double levelZ = room.Level?.ProjectElevation ?? 0;
        double z = levelZ + FmcScript.Mm(heightMm);
        if (replace)
        {
            // Lesson 5: OfClass(FamilyInstance) first.
            var old = new FilteredElementCollector(document).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>()
                .Where(f => f.Symbol.Family.Id == strip.Family.Id)
                .Where(f => { string c = CommentOf(f); return c == Render(commentTpl, room, "") || c == Render(cornerTpl, room, "")
                    || new[] { "N", "E", "S", "W" }.Any(sd => c == Render(commentTpl, room, sd)); })
                .Select(f => f.Id).ToList();
            if (old.Count > 0) { document.Delete(old); replaced += old.Count; }
        }

        IList<IList<BoundarySegment>> loops = room.GetBoundarySegments(boundaryOptions);
        if (loops == null || loops.Count == 0) { skipped.Add($"{room.Number}: no boundary"); continue; }
        IList<BoundarySegment> segs = loops[0];
        double area2 = 0;
        foreach (BoundarySegment seg in segs) { XYZ s0 = seg.GetCurve().GetEndPoint(0), s1 = seg.GetCurve().GetEndPoint(1); area2 += s0.X * s1.Y - s1.X * s0.Y; }
        bool anticlockwise = area2 > 0;

        // The corner run: a segment index, or the boundary corner nearest the room's NE/NW/SE/SW extreme.
        int cornerSeg = -1;
        JToken cornerArg = corners[room.Number];
        if (cornerArg != null && cornerRunMm > 0)
        {
            if (cornerArg.Type == JTokenType.Integer) cornerSeg = (int)cornerArg;
            else
            {
                string tag = ((string)cornerArg ?? "").Trim().ToUpperInvariant();
                if (tag.Length != 2 || "NS".IndexOf(tag[0]) < 0 || "EW".IndexOf(tag[1]) < 0) { skipped.Add($"{room.Number}: corner \"{tag}\" is not NE, NW, SE or SW"); }
                else
                {
                    double sx = tag[1] == 'E' ? 1 : -1, sy = tag[0] == 'N' ? 1 : -1, bestScore = double.MinValue;
                    for (int k = 0; k < segs.Count; k++)
                    {
                        XYZ start = segs[k].GetCurve().GetEndPoint(0);
                        double score = sx * start.X + sy * start.Y;
                        if (score > bestScore) { bestScore = score; cornerSeg = k; }
                    }
                }
            }
        }

        int roomPlaced = 0;
        double roomFt = 0;
        for (int k = 0; k < segs.Count; k++)
        {
            BoundarySegment bs = segs[k];
            Curve curve = bs.GetCurve();
            var wall = document.GetElement(bs.ElementId) as Wall;
            string where = $"{room.Number} segment {k}";
            if (wall == null) { skipped.Add($"{where}: not a wall (room separation line or column)"); continue; }
            if (!(curve is Line)) { skipped.Add($"{where}: curved wall"); continue; }
            if (curve.Length < FmcScript.Mm(minSegMm)) { if (k != cornerSeg) skipped.Add($"{where}: shorter than {minSegMm} mm"); continue; }
            XYZ a = curve.GetEndPoint(0), b = curve.GetEndPoint(1);
            XYZ dir = (b - a).Normalize();
            string side = SideOf(dir, anticlockwise);
            bool lit = sides.Contains(side);
            if (!lit && k != cornerSeg) continue;
            XYZ mid = new XYZ((a.X + b.X) / 2, (a.Y + b.Y) / 2, z);
            var (faceRef, offset) = WallFace(wall, mid);
            if (faceRef == null) { skipped.Add($"{where}: no face of wall {wall.Id.Value} within {faceTolMm} mm"); continue; }
            double inset = FmcScript.Mm(insetMm);
            if (lit)
            {
                double lengthFt = curve.Length - 2 * inset;
                if (lengthFt <= 0) { skipped.Add($"{where}: shorter than twice the inset"); continue; }
                Place(faceRef, new XYZ(a.X, a.Y, z) + dir * inset + offset, dir, lengthFt, Render(commentTpl, room, side));
                roomPlaced++; roomFt += lengthFt;
            }
            if (k == cornerSeg)
            {
                XYZ cornerAt = new XYZ(a.X, a.Y, levelZ + FmcScript.Mm(cornerBaseMm)) + dir * inset + offset;
                Place(faceRef, cornerAt, XYZ.BasisZ, FmcScript.Mm(cornerRunMm), Render(cornerTpl, room, side));
                roomPlaced++; roomFt += FmcScript.Mm(cornerRunMm);
            }
        }
        if (cornerSeg >= segs.Count) skipped.Add($"{room.Number}: corner segment {cornerSeg} doesn't exist ({segs.Count} segments)");
        perRoom.Add(new { room = room.Number, name = room.Name, placed = roomPlaced, metres = Math.Round(FmcScript.ToMm(roomFt) / 1000, 2) });
    }
    if (noLength) skipped.Add($"{typeKey} has no writable instance parameter \"{lengthParam}\": lengths not set");
    if (noSwitch) skipped.Add($"{typeKey} has no writable \"{switchParam}\" parameter: bind the kit's shared parameter (switch not recorded)");
    return new
    {
        dry_run = dryRun, placed, total_m = Math.Round(FmcScript.ToMm(totalFt) / 1000, 2), rooms = perRoom, replaced, skipped,
        ids = dryRun ? new List<long>() : ids.Take(200).ToList(),
    };
});
return summary;
