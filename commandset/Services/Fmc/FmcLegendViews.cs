using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>Reads legend views and legend components. No transaction. A missing seed is a result, not a throw.</summary>
    public class FmcLegendViewsHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft legend views";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            string titleBefore = app.ActiveUIDocument?.Document?.Title ?? "";
            string viewBefore = app.ActiveUIDocument?.ActiveView?.UniqueId ?? "";
            try
            {
                RevitMCPCommandSet.Bridge.FmcAiJob.Enter(app, RevitMCPCommandSet.Bridge.FmcAiJob.JobOf(Parameters));
                string key = (Parameters.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_legend seed needs document. Refusing to use the active document.");
                var rows = new JArray();
                rows.Add(FmcLegendRead.Read(FmcLegendRead.Find(app, key)));
                string source = (Parameters.Value<string>("source_document") ?? "").Trim();
                if (source.Length > 0 && !FmcTarget.Same(FmcLegendRead.Find(app, key), source))
                    rows.Add(FmcLegendRead.Read(FmcLegendRead.Find(app, source)));
                Result = new JObject
                {
                    ["read_only"] = true,
                    ["saved"] = false,
                    ["documents"] = rows,
                    ["images"] = new JArray(),
                    ["free_text"] = false,
                };
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
    }

    internal static class FmcLegendRead
    {
        private const double Mm = 304.8;

        internal static Document Find(UIApplication app, string key)
        {
            var open = new List<Document>();
            foreach (Document doc in app.Application.Documents)
                if (doc != null && !doc.IsLinked) open.Add(doc);
            var hits = open.Where(d => FmcTarget.Same(d, key)).ToList();
            if (hits.Count > 1)
                throw new InvalidOperationException($"[FMC-DOC-AMBIGUOUS] \"{key}\" matches {hits.Count} open documents. Pass the full path.");
            if (hits.Count == 0)
                throw new InvalidOperationException($"[FMC-DOC-NOT-FOUND] No open document has title or path \"{key}\".");
            return hits[0];
        }

        internal static JObject Read(Document doc)
        {
            var views = new JArray();
            var components = new JArray();
            foreach (View view in new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>())
            {
                if (view.IsTemplate || view.ViewType != ViewType.Legend) continue;
                int count = 0;
                try { count = new FilteredElementCollector(doc, view.Id).OfCategory(BuiltInCategory.OST_LegendComponents).GetElementCount(); }
                catch { count = 0; }
                views.Add(new JObject
                {
                    ["id"] = view.Id.Value.ToString(),
                    ["name"] = view.Name ?? "",
                    ["scale"] = view.Scale,
                    ["component_count"] = count,
                });
            }
            foreach (Element element in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_LegendComponents).WhereElementIsNotElementType())
            {
                Parameter type = element.get_Parameter(BuiltInParameter.LEGEND_COMPONENT);
                Parameter direction = element.get_Parameter(BuiltInParameter.LEGEND_COMPONENT_VIEW);
                Parameter length = element.get_Parameter(BuiltInParameter.LEGEND_COMPONENT_LENGTH);
                string viewId = "";
                try { if (element.OwnerViewId != null && element.OwnerViewId != ElementId.InvalidElementId) viewId = element.OwnerViewId.Value.ToString(); } catch { viewId = ""; }
                components.Add(new JObject
                {
                    ["id"] = element.Id.Value.ToString(),
                    ["view_id"] = viewId,
                    ["type_id"] = type != null && type.StorageType == StorageType.ElementId && type.AsElementId() != null && type.AsElementId() != ElementId.InvalidElementId ? type.AsElementId().Value.ToString() : "",
                    ["direction"] = direction != null && direction.StorageType == StorageType.Integer ? direction.AsInteger() : JValue.CreateNull(),
                    ["length_mm"] = length != null && length.StorageType == StorageType.Double ? Math.Round(length.AsDouble() * Mm, 3) : JValue.CreateNull(),
                });
            }
            return new JObject
            {
                ["title"] = doc.Title ?? "",
                ["path"] = doc.PathName ?? "",
                ["is_central"] = FmcPhaseIds.IsCentral(doc),
                ["views"] = views,
                ["components"] = components,
            };
        }
    }
}
