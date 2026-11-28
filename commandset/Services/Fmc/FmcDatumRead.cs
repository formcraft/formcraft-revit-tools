using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Read for the grid, level, dimension and placement dry runs (server/src/fmc/datum.ts). No transaction.
    /// The project base point and survey point in internal mm, grid and level names (levels by ProjectElevation, which is
    /// internal), the asked views and whether they take dimensions, and instances of the asked types.
    /// </summary>
    public class FmcDatumReadHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft datum read";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                Document doc = FmcCallContext.Document(app);
                Result = Read(doc, Parameters ?? new JObject());
                Result["resolved_document"] = FmcTarget.Resolved(doc);
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        static readonly HashSet<ViewType> Dimensionable = new HashSet<ViewType>
        {
            ViewType.FloorPlan, ViewType.CeilingPlan, ViewType.Elevation, ViewType.Section, ViewType.Detail,
            ViewType.DraftingView, ViewType.AreaPlan, ViewType.EngineeringPlan,
        };

        internal static JObject Read(Document doc, JObject parameters)
        {
            var result = new JObject
            {
                ["read_only"] = true,
                ["title"] = doc.Title ?? "",
                ["base_point"] = Point(SafePosition(() => BasePoint.GetProjectBasePoint(doc)?.Position)),
                ["survey_point"] = Point(SafePosition(() => BasePoint.GetSurveyPoint(doc)?.Position)),
            };
            var grids = new JArray();
            foreach (Grid grid in new FilteredElementCollector(doc).OfClass(typeof(Grid)).Cast<Grid>())
                grids.Add(new JObject { ["id"] = grid.Id.Value.ToString(), ["name"] = grid.Name ?? "" });
            result["grids"] = grids;
            var levels = new JArray();
            foreach (Level level in new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>())
                levels.Add(new JObject { ["id"] = level.Id.Value.ToString(), ["name"] = level.Name ?? "", ["elevation_mm"] = Mm(level.ProjectElevation) });
            result["levels"] = levels;
            var views = new JArray();
            foreach (JToken token in parameters["view_ids"] as JArray ?? new JArray())
            {
                if (!long.TryParse(token?.ToString(), out long id)) continue;
                if (doc.GetElement(new ElementId(id)) is not View view) continue;
                views.Add(new JObject
                {
                    ["id"] = id.ToString(),
                    ["name"] = view.Name ?? "",
                    ["view_type"] = view.ViewType.ToString(),
                    ["can_dimension"] = !view.IsTemplate && Dimensionable.Contains(view.ViewType),
                });
            }
            result["views"] = views;
            var typeIds = new HashSet<long>();
            foreach (JToken token in parameters["type_ids"] as JArray ?? new JArray())
                if (long.TryParse(token?.ToString(), out long id)) typeIds.Add(id);
            var instances = new JArray();
            if (typeIds.Count > 0)
            {
                foreach (FamilyInstance fi in new FilteredElementCollector(doc).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>())
                {
                    long typeId = fi.GetTypeId()?.Value ?? -1;
                    if (!typeIds.Contains(typeId) || fi.Location is not LocationPoint lp) continue;
                    instances.Add(new JObject
                    {
                        ["id"] = fi.Id.Value.ToString(),
                        ["type_id"] = typeId.ToString(),
                        ["x"] = Mm(lp.Point.X),
                        ["y"] = Mm(lp.Point.Y),
                        ["z"] = Mm(lp.Point.Z),
                    });
                }
            }
            result["instances"] = instances;
            return result;
        }

        static XYZ SafePosition(Func<XYZ> read)
        {
            try { return read(); } catch (Exception) { return null; }
        }

        static JToken Point(XYZ p) => p == null ? JValue.CreateNull() : new JObject { ["x"] = Mm(p.X), ["y"] = Mm(p.Y), ["z"] = Mm(p.Z) };

        static double Mm(double feet) => Math.Round(feet * 304.8, 1);
    }
}
