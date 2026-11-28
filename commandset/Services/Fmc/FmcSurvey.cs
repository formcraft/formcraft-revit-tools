using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>fmc_survey: toposolid types, levels, existing toposolids and the internal-to-shared matrix. No transaction.</summary>
    public class FmcSurveyHandler : FmcSiteHandlerBase
    {
        protected override string Tool => "fmc_survey";

        protected override JObject Run(UIApplication app, Document doc)
        {
            JObject result = DocFacts(doc);
            result["internal_to_shared"] = InternalToSharedMm(doc);
            var types = new JArray();
            foreach (ToposolidType type in new FilteredElementCollector(doc).OfClass(typeof(ToposolidType)).Cast<ToposolidType>())
                types.Add(new JObject { ["id"] = type.Id.Value.ToString(), ["name"] = type.Name ?? "" });
            var levels = new JArray();
            foreach (Level level in new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => l.Elevation))
                levels.Add(new JObject { ["id"] = level.Id.Value.ToString(), ["name"] = level.Name ?? "", ["elevation_mm"] = Mm(level.Elevation) });
            var solids = new JArray();
            foreach (Toposolid solid in new FilteredElementCollector(doc).OfClass(typeof(Toposolid)).Cast<Toposolid>())
            {
                var row = new JObject
                {
                    ["id"] = solid.Id.Value.ToString(),
                    ["type"] = doc.GetElement(solid.GetTypeId())?.Name ?? "",
                    ["comments"] = solid.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString() ?? "",
                };
                BoundingBoxXYZ box = solid.get_BoundingBox(null);
                if (box != null) row["bbox_mm"] = Box(box);
                solids.Add(row);
            }
            result["toposolid_types"] = types;
            result["levels"] = levels;
            result["toposolids"] = solids;
            return result;
        }

        internal static JObject Box(BoundingBoxXYZ box) => new JObject
        {
            ["min_x"] = Mm(box.Min.X), ["min_y"] = Mm(box.Min.Y), ["min_z"] = Mm(box.Min.Z),
            ["max_x"] = Mm(box.Max.X), ["max_y"] = Mm(box.Max.Y), ["max_z"] = Mm(box.Max.Z),
        };
    }

    /// <summary>
    /// fmc_survey_apply: one transaction. Toposolid.Create from the points the server sent (internal millimetres, already
    /// transformed from shared coordinates with the fmc_coord matrix and checked), with the given type and level.
    /// Comments carries FMC_SURVEY and the file name. The bounding box is read back for the server's height check.
    /// </summary>
    public class FmcSurveyApplyHandler : FmcSiteHandlerBase
    {
        protected override string Tool => "fmc_survey_apply";

        protected override JObject Run(UIApplication app, Document doc)
        {
            Refuse(doc);
            List<XYZ> points = PointsFeet(Parameters["xyz_mm"]);
            if (points.Count < 3) throw new InvalidOperationException("[FMC-SURVEY-FEW] A toposolid needs at least 3 points.");
            if (!long.TryParse(Parameters.Value<string>("type_id"), out long typeId) || !(doc.GetElement(new ElementId(typeId)) is ToposolidType type))
                throw new InvalidOperationException("[FMC-SURVEY-TYPE] type_id is not a toposolid type.");
            if (!long.TryParse(Parameters.Value<string>("level_id"), out long levelId) || !(doc.GetElement(new ElementId(levelId)) is Level level))
                throw new InvalidOperationException("[FMC-SURVEY-LEVEL] level_id is not a level.");
            using (var transaction = new Transaction(doc, "Formcraft survey toposolid"))
            {
                transaction.Start();
                try
                {
                    Toposolid solid = Toposolid.Create(doc, points, type.Id, level.Id)
                        ?? throw new InvalidOperationException("Toposolid.Create returned nothing.");
                    string comments = (Parameters.Value<string>("comments") ?? "FMC_SURVEY").Trim();
                    Parameter p = solid.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS);
                    bool tagged = p != null && !p.IsReadOnly && p.Set(comments);
                    doc.Regenerate();
                    BoundingBoxXYZ box = solid.get_BoundingBox(null);
                    transaction.Commit();
                    var result = new JObject
                    {
                        ["ok"] = true,
                        ["toposolid_id"] = solid.Id.Value.ToString(),
                        ["unique_id"] = solid.UniqueId,
                        ["points"] = points.Count,
                        ["type"] = type.Name ?? "",
                        ["level"] = level.Name ?? "",
                        ["level_elevation_mm"] = Mm(level.Elevation),
                        ["comments_set"] = tagged,
                        ["saved"] = false,
                        ["synced"] = false,
                    };
                    if (box != null) result["bbox_mm"] = FmcSurveyHandler.Box(box);
                    return result;
                }
                catch
                {
                    if (transaction.HasStarted() && !transaction.HasEnded()) transaction.RollBack();
                    throw;
                }
            }
        }
    }
}
