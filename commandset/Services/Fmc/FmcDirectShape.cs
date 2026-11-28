using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Reads for fmc_directshape. mode check: the document, the whitelist and every solid of a planned set are tried out
    /// (solids are built in memory, nothing is added to the model). mode list: the DirectShapes this tool made.
    /// No transaction. Nothing is saved or synced.
    /// </summary>
    public class FmcDirectShapeHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double CubicFeetToM3 = 0.0283168466;
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft DirectShape read";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            string titleBefore = app.ActiveUIDocument?.Document?.Title ?? "";
            string viewBefore = app.ActiveUIDocument?.ActiveView?.UniqueId ?? "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw FmcDirectShapeGeo.Fail("FMC-DOC-REQUIRED", "fmc_directshape needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    string mode = (Parameters.Value<string>("mode") ?? "").Trim();
                    if (mode == "list") Result = ListOurs(doc);
                    else if (mode == "check") Result = CheckSet(doc);
                    else throw FmcDirectShapeGeo.Fail("FMC-DS-SPEC", "fmc_directshape knows mode check and list.");
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                    Result["read_only"] = true;
                    Result["saved"] = false;
                    Result["synced"] = false;
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally
            {
                string titleAfter = app.ActiveUIDocument?.Document?.Title ?? "";
                string viewAfter = app.ActiveUIDocument?.ActiveView?.UniqueId ?? "";
                if (Result != null && string.IsNullOrEmpty(Error))
                    Result["active_unchanged"] = titleBefore == titleAfter && viewBefore == viewAfter;
                _done.Set();
            }
        }

        private JObject ListOurs(Document doc)
        {
            int limit = Math.Max(1, Math.Min(200, Parameters.Value<int?>("limit") ?? 50));
            var ours = FmcDirectShapeGeo.Ours(doc, Parameters);
            var runs = ours.GroupBy(FmcDirectShapeGeo.RunOf).OrderBy(g => g.Key)
                .Select(g => new JObject { ["run_id"] = g.Key, ["count"] = g.Count() });
            return new JObject
            {
                ["count"] = ours.Count,
                ["runs"] = new JArray(runs),
                ["shapes"] = new JArray(ours.Take(limit).Select(FmcDirectShapeGeo.Row)),
                ["truncated"] = ours.Count > limit,
                ["application_id"] = FmcDirectShapeGeo.ApplicationId,
            };
        }

        private JObject CheckSet(Document doc)
        {
            FmcDirectShapeGeo.RefuseDocument(doc, Parameters);
            HashSet<string> allowed = FmcDirectShapeGeo.Allowed(Parameters);
            List<DsShape> shapes = FmcDirectShapeGeo.ParseShapes(Parameters, allowed);
            var existing = new HashSet<string>(new FilteredElementCollector(doc).OfClass(typeof(DirectShape)).Cast<DirectShape>()
                .Where(FmcDirectShapeGeo.IsOurs).Select(d => d.Name), StringComparer.OrdinalIgnoreCase);
            var rows = new JArray();
            var problems = new JArray();
            foreach (DsShape shape in shapes)
            {
                var row = new JObject { ["index"] = shape.Index, ["name"] = shape.Name, ["category"] = shape.CategoryName, ["name_in_use"] = existing.Contains(shape.Name) };
                try
                {
                    if (!Enum.TryParse(shape.Bic, out BuiltInCategory bic) || !DirectShape.IsValidCategoryId(new ElementId(bic), doc))
                        throw FmcDirectShapeGeo.Fail("FMC-DS-CATEGORY", shape.CategoryName + " is not valid for a DirectShape in this document.");
                    double z = FmcDirectShapeGeo.LevelFeet(doc, shape.Level);
                    double volume = 0;
                    foreach (DsPart part in shape.Parts) volume += FmcDirectShapeGeo.BuildSolid(part, z).Volume;
                    row["ok"] = true;
                    row["solid_count"] = shape.Parts.Count;
                    row["volume_m3"] = Math.Round(volume * CubicFeetToM3, 6);
                    row["level"] = shape.Level;
                }
                catch (Exception ex)
                {
                    row["ok"] = false;
                    row["problem"] = ex.Message;
                    problems.Add(new JObject { ["index"] = shape.Index, ["message"] = ex.Message });
                }
                rows.Add(row);
            }
            return new JObject { ["shapes"] = rows, ["problems"] = problems, ["would_create"] = problems.Count == 0 ? shapes.Count : 0 };
        }
    }
}
