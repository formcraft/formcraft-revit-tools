using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// One transaction for fmc_directshape. mode create makes a DirectShape per shape, each carrying ApplicationId and an
    /// ApplicationDataId with the run id, so it can be found again. mode remove deletes only DirectShapes this tool made.
    /// If any shape fails the transaction is rolled back and nothing is made. The server has already checked the lease and
    /// confirm. The document is never saved or synchronised.
    /// </summary>
    public class FmcDirectShapeApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft DirectShape apply";

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
                    throw FmcDirectShapeGeo.Fail("FMC-DOC-REQUIRED", "fmc_directshape_apply needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    FmcDirectShapeGeo.RefuseDocument(doc, Parameters);
                    string mode = (Parameters.Value<string>("mode") ?? "").Trim();
                    if (mode == "create") Result = Create(doc);
                    else if (mode == "remove") Result = Remove(doc);
                    else throw FmcDirectShapeGeo.Fail("FMC-DS-SPEC", "fmc_directshape_apply knows mode create and remove.");
                    Result["saved"] = false;
                    Result["synced"] = false;
                    Result["read_only"] = false;
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                    Result["is_central"] = false;
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

        private JObject Create(Document doc)
        {
            string run = (Parameters.Value<string>("run_id") ?? "").Trim();
            if (!FmcDirectShapeGeo.RunPattern.IsMatch(run)) throw FmcDirectShapeGeo.Fail("FMC-DS-SPEC", "run_id is missing or not a run id (DS-yyyymmddHHMMSS-xxxx).");
            HashSet<string> allowed = FmcDirectShapeGeo.Allowed(Parameters);
            List<DsShape> shapes = FmcDirectShapeGeo.ParseShapes(Parameters, allowed);
            var created = new JArray();
            using (var transaction = new Transaction(doc, "Formcraft DirectShape create"))
            {
                transaction.Start();
                try
                {
                    foreach (DsShape shape in shapes)
                    {
                        if (!Enum.TryParse(shape.Bic, out BuiltInCategory bic) || !DirectShape.IsValidCategoryId(new ElementId(bic), doc))
                            throw FmcDirectShapeGeo.Fail("FMC-DS-CATEGORY", shape.CategoryName + " is not valid for a DirectShape in this document.");
                        double z = FmcDirectShapeGeo.LevelFeet(doc, shape.Level);
                        var solids = new List<GeometryObject>();
                        foreach (DsPart part in shape.Parts) solids.Add(FmcDirectShapeGeo.BuildSolid(part, z));
                        DirectShape ds = DirectShape.CreateElement(doc, new ElementId(bic));
                        ds.ApplicationId = FmcDirectShapeGeo.ApplicationId;
                        ds.ApplicationDataId = FmcDirectShapeGeo.DataPrefix + run + "|" + (shape.Index + 1);
                        ds.SetShape(solids);
                        ds.Name = shape.Name;
                        ds.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.Set("FMC " + run + " " + shape.Purpose);
                        if (shape.Mark.Length > 0) ds.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.Set(shape.Mark);
                        created.Add(FmcDirectShapeGeo.Row(ds));
                    }
                    transaction.Commit();
                }
                catch
                {
                    if (transaction.HasStarted() && !transaction.HasEnded()) transaction.RollBack();
                    throw;
                }
            }
            return new JObject { ["ok"] = true, ["mode"] = "create", ["run_id"] = run, ["created"] = created, ["rolled_back"] = false };
        }

        private JObject Remove(Document doc)
        {
            string run = (Parameters.Value<string>("of_run") ?? "").Trim();
            var asked = (Parameters["ids"] as JArray ?? new JArray()).Select(x => x.ToString()).ToList();
            if (run.Length == 0 && asked.Count == 0 && Parameters.Value<bool?>("all") != true)
                throw FmcDirectShapeGeo.Fail("FMC-DS-SELECT", "remove needs ids, of_run or all true.");
            List<DirectShape> ours = FmcDirectShapeGeo.Ours(doc, Parameters);
            var skipped = new JArray();
            foreach (string id in asked)
                if (!ours.Any(d => d.Id.Value.ToString() == id))
                    skipped.Add(new JObject { ["id"] = id, ["code"] = "FMC-DS-NOT-OURS", ["message"] = "Not a DirectShape fmc_directshape made (or not in the run asked for). It was not touched." });
            var held = new JArray();
            var kept = new List<ElementId>();
            FmcCheckout.Partition(doc, ours.Select(d => d.Id).ToList(), kept, held);
            foreach (JToken row in held) skipped.Add(row);
            var removable = new List<ElementId>();
            foreach (ElementId id in kept)
            {
                if (doc.GetElement(id)?.Pinned == true) skipped.Add(new JObject { ["id"] = id.Value, ["code"] = "FMC-DS-PINNED" });
                else removable.Add(id);
            }
            if (removable.Count > 0)
            {
                using (var transaction = new Transaction(doc, "Formcraft DirectShape remove"))
                {
                    transaction.Start();
                    try
                    {
                        doc.Delete(removable);
                        transaction.Commit();
                    }
                    catch
                    {
                        if (transaction.HasStarted() && !transaction.HasEnded()) transaction.RollBack();
                        throw;
                    }
                }
            }
            return new JObject { ["ok"] = true, ["mode"] = "remove", ["removed"] = new JArray(removable.Select(i => i.Value)), ["skipped"] = skipped, ["rolled_back"] = false };
        }
    }
}
