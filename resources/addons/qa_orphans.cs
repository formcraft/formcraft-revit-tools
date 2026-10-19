// @addon qa_orphans  @version 1.0  @writes model  @dryrun yes
// @does Finds face-based instances with no host (orphans), instances floating off their host's faces and duplicates at one point; optionally re-hosts orphans on the nearest face (from KISIC 15_flat_ceilings_relight).
// @params {"categories":[],"float_tolerance_mm":5,"duplicate_tolerance_mm":1,"rehost":false,"rehost_max_mm":300,"limit":50}
// @returns {"dry_run":bool,"checked":n,"orphans":n,"floating":n,"duplicates":n,"rehosted":n,"rehost_failed":[...],"items":[{"id":n,"issue":"orphan|floating|duplicate","category":"...","family":"...","type":"...","mark":"...","comments":"...","at_mm":[x,y,z]}]}
// @usings Newtonsoft.Json.Linq
//
// categories: BuiltInCategory names (OST_LightingFixtures or LightingFixtures); empty = lighting, electrical, devices,
// generic models and specialty equipment. Report only unless rehost is true; a re-host makes a new instance of the same
// type on the nearest ceiling, floor or wall face within rehost_max_mm, copies Comments, Mark and the family's own
// parameters, and deletes the orphan (one transaction through FmcScript.Tx; a dry run rolls it back).
// Lessons encoded (docs/handoff/KISIC_GAP_SCRIPTS.md §6):
//   3  deleting a host leaves face-based instances in place with Host == null: run this after every host change;
//   5  OfClass(FamilyInstance) before the cast: a DirectShape in the same category would throw;
//   2  the face is found by projecting the point onto HostObjectUtils faces, the nearest one wins;
//   6  locals inside lambdas and loops have their own names (CS0136).
var args = FmcScript.Params(parameters);
bool dryRun = FmcScript.IsDryRun(parameters);
double floatTolMm = (double?)args["float_tolerance_mm"] ?? 5;
double dupTolMm = (double?)args["duplicate_tolerance_mm"] ?? 1;
bool rehost = (bool?)args["rehost"] ?? false;
double rehostMaxMm = (double?)args["rehost_max_mm"] ?? 300;
int limit = (int?)args["limit"] ?? 50;
if (floatTolMm < 0 || dupTolMm <= 0 || rehostMaxMm <= 0 || limit < 1) throw new ArgumentException("tolerances and limit must be positive");

var catNames = ((args["categories"] as JArray) ?? new JArray()).Select(t => ((string)t ?? "").Trim()).Where(s => s.Length > 0).ToList();
if (catNames.Count == 0)
    catNames = new List<string> { "OST_LightingFixtures", "OST_LightingDevices", "OST_ElectricalFixtures", "OST_ElectricalEquipment",
        "OST_CommunicationDevices", "OST_DataDevices", "OST_FireAlarmDevices", "OST_SecurityDevices", "OST_NurseCallDevices",
        "OST_GenericModel", "OST_SpecialityEquipment", "OST_PlumbingFixtures", "OST_MechanicalEquipment" };
var bics = new List<BuiltInCategory>();
var badCats = new List<string>();
foreach (string catName in catNames)
{
    if (Enum.TryParse(catName.StartsWith("OST_") ? catName : "OST_" + catName, true, out BuiltInCategory bic)) bics.Add(bic);
    else badCats.Add(catName);
}
if (badCats.Count > 0) throw new ArgumentException("Not Revit categories: " + string.Join(", ", badCats));

// Lesson 5: OfClass(FamilyInstance) first.
var instances = new FilteredElementCollector(document).OfClass(typeof(FamilyInstance))
    .WherePasses(new ElementMulticategoryFilter(bics)).WhereElementIsNotElementType().Cast<FamilyInstance>().ToList();

string Text(Element el, BuiltInParameter bip) => el.get_Parameter(bip)?.AsString() ?? "";
XYZ PointOf(FamilyInstance inst) => (inst.Location as LocationPoint)?.Point;
bool FaceBased(FamilyInstance inst)
{
    FamilyPlacementType kind = inst.Symbol.Family.FamilyPlacementType;
    return kind == FamilyPlacementType.WorkPlaneBased || kind == FamilyPlacementType.OneLevelBasedHosted;
}

IEnumerable<Solid> SolidsOf(GeometryElement geometry)
{
    if (geometry == null) yield break;
    foreach (GeometryObject obj in geometry)
    {
        if (obj is Solid solid && solid.Faces.Size > 0) yield return solid;
        else if (obj is GeometryInstance gi) foreach (Solid inner in SolidsOf(gi.GetInstanceGeometry())) yield return inner;
    }
}

// The distance from a point to the nearest face of an element's own geometry (MaxValue when no face lies under it).
double FaceDistance(Element hostEl, XYZ point)
{
    double best = double.MaxValue;
    foreach (Solid solid in SolidsOf(hostEl.get_Geometry(new Options { DetailLevel = ViewDetailLevel.Fine })))
        foreach (Face face in solid.Faces)
        {
            IntersectionResult hit = face.Project(point);
            if (hit != null && hit.Distance < best) best = hit.Distance;
        }
    return best;
}

var items = new List<Dictionary<string, object>>();
Dictionary<string, object> Item(FamilyInstance inst, string issue, double? distanceMm)
{
    XYZ at = PointOf(inst);
    var row = new Dictionary<string, object>
    {
        ["id"] = inst.Id.Value, ["issue"] = issue, ["category"] = inst.Category?.Name ?? "",
        ["family"] = inst.Symbol.FamilyName, ["type"] = inst.Symbol.Name,
        ["mark"] = Text(inst, BuiltInParameter.ALL_MODEL_MARK), ["comments"] = Text(inst, BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS),
        ["at_mm"] = at == null ? null : FmcScript.ToMm(at),
    };
    if (distanceMm.HasValue) row["distance_mm"] = distanceMm.Value >= 1e6 ? (object)"off every face" : Math.Round(distanceMm.Value, 1);
    return row;
}

var orphans = new List<FamilyInstance>();
int floating = 0, duplicates = 0;
foreach (FamilyInstance inst in instances)
{
    if (!FaceBased(inst) || PointOf(inst) == null) continue;
    if (inst.Host == null) { orphans.Add(inst); items.Add(Item(inst, "orphan", null)); continue; }
    if (inst.Symbol.Family.FamilyPlacementType != FamilyPlacementType.WorkPlaneBased || !(inst.Host is HostObject)) continue;
    double gapMm = FmcScript.ToMm(FaceDistance(inst.Host, PointOf(inst)));
    if (gapMm > floatTolMm) { floating++; items.Add(Item(inst, "floating", gapMm)); }
}

// Duplicates: the same type at the same point (within the tolerance), counted once per extra copy.
var seen = new Dictionary<string, long>();
foreach (FamilyInstance inst in instances)
{
    XYZ at = PointOf(inst);
    if (at == null) continue;
    double cell = FmcScript.Mm(dupTolMm);
    string key = $"{inst.Symbol.Id.Value}|{Math.Round(at.X / cell)}|{Math.Round(at.Y / cell)}|{Math.Round(at.Z / cell)}";
    if (seen.TryGetValue(key, out long firstId)) { duplicates++; var dupRow = Item(inst, "duplicate", null); dupRow["same_as"] = firstId; items.Add(dupRow); }
    else seen[key] = inst.Id.Value;
}

int rehosted = 0;
var rehostFailed = new List<string>();
var newIds = new List<long>();
if (rehost && orphans.Count > 0)
{
    // Lesson 2: candidate faces are the host objects' own faces, the nearest by projection wins.
    (Reference reference, XYZ point, XYZ normal) NearestFace(XYZ probe)
    {
        double reach = FmcScript.Mm(rehostMaxMm);
        var box = new Outline(probe - new XYZ(reach, reach, reach), probe + new XYZ(reach, reach, reach));
        var hosts = new FilteredElementCollector(document).WherePasses(new BoundingBoxIntersectsFilter(box))
            .WherePasses(new ElementMulticlassFilter(new List<Type> { typeof(Ceiling), typeof(Floor), typeof(Wall) })).Cast<HostObject>().ToList();
        Reference bestRef = null; XYZ bestPoint = null, bestNormal = null; double bestDist = reach;
        foreach (HostObject hostObj in hosts)
        {
            var refs = new List<Reference>();
            if (hostObj is Ceiling) refs.AddRange(HostObjectUtils.GetBottomFaces(hostObj));
            else if (hostObj is Floor) refs.AddRange(HostObjectUtils.GetTopFaces(hostObj));
            else { refs.AddRange(HostObjectUtils.GetSideFaces(hostObj, ShellLayerType.Interior)); refs.AddRange(HostObjectUtils.GetSideFaces(hostObj, ShellLayerType.Exterior)); }
            foreach (Reference faceRef in refs)
            {
                var face = hostObj.GetGeometryObjectFromReference(faceRef) as Face;
                IntersectionResult hit = face?.Project(probe);
                if (hit == null || hit.Distance > bestDist) continue;
                bestDist = hit.Distance; bestRef = faceRef; bestPoint = hit.XYZPoint; bestNormal = face.ComputeNormal(hit.UVPoint);
            }
        }
        return (bestRef, bestPoint, bestNormal);
    }

    void CopyValue(Parameter fromParam, Parameter toParam)
    {
        if (toParam == null || toParam.IsReadOnly || !fromParam.HasValue || fromParam.StorageType != toParam.StorageType) return;
        try
        {
            switch (fromParam.StorageType)
            {
                case StorageType.Double: toParam.Set(fromParam.AsDouble()); break;
                case StorageType.Integer: toParam.Set(fromParam.AsInteger()); break;
                case StorageType.String: toParam.Set(fromParam.AsString() ?? ""); break;
                case StorageType.ElementId: toParam.Set(fromParam.AsElementId()); break;
            }
        }
        catch (Exception) { /* a value the new instance refuses is left at its default */ }
    }

    FmcScript.Tx(document, "FMC add-on qa_orphans: re-host orphans", dryRun, () =>
    {
        foreach (FamilyInstance orphan in orphans)
        {
            var (faceRef, onFace, normal) = NearestFace(PointOf(orphan));
            if (faceRef == null) { rehostFailed.Add($"{orphan.Id.Value} {orphan.Symbol.FamilyName}: no ceiling, floor or wall face within {rehostMaxMm} mm"); continue; }
            XYZ hand = orphan.HandOrientation;
            XYZ along = hand - normal.Multiply(hand.DotProduct(normal));
            if (along.GetLength() < 1e-6) along = normal.CrossProduct(XYZ.BasisZ).GetLength() > 1e-6 ? normal.CrossProduct(XYZ.BasisZ) : XYZ.BasisX;
            FamilyInstance made = document.Create.NewFamilyInstance(faceRef, onFace, along.Normalize(), orphan.Symbol);
            CopyValue(orphan.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS), made.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS));
            CopyValue(orphan.get_Parameter(BuiltInParameter.ALL_MODEL_MARK), made.get_Parameter(BuiltInParameter.ALL_MODEL_MARK));
            foreach (Parameter own in orphan.Parameters)
            {
                if (own.Definition is InternalDefinition internalDef && internalDef.BuiltInParameter != BuiltInParameter.INVALID) continue;
                CopyValue(own, own.IsShared ? made.get_Parameter(own.GUID) : made.LookupParameter(own.Definition.Name));
            }
            newIds.Add(made.Id.Value);
            document.Delete(orphan.Id);
            rehosted++;
        }
    });
}

return new
{
    dry_run = dryRun,
    @checked = instances.Count,
    orphans = orphans.Count,
    floating,
    duplicates,
    rehost,
    rehosted,
    rehost_failed = rehostFailed,
    new_ids = dryRun ? new List<long>() : newIds,
    items = items.Take(limit).ToList(),
    more = Math.Max(0, items.Count - limit),
    next = orphans.Count > 0 && !rehost ? "Re-run with rehost true (dry run first) to re-host the orphans on the nearest face" : null,
};
