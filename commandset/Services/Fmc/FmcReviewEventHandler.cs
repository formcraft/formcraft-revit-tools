using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Review (U20) on the Revit main thread. context reads the model's name, the active view and the selected elements, so
    /// a review item links to what the person was looking at. The register itself is a project file the server keeps;
    /// nothing here changes the model (revision clouds come next, behind the live-model lock).
    /// </summary>
    public class FmcReviewEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public string Action { get; set; } = "";
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                // Both actions work on the active view and the selection, so the document must be the active one.
                using var target = FmcTarget.Resolve(app, Parameters, mayOpen: false);
                UIDocument ui = target.RequireUi(Action == "cloud" ? "Drawing a revision cloud" : "Reading the review context");
                switch (Action)
                {
                    case "context": Result = Context(ui); break;
                    case "cloud": Result = Cloud(ui); break;
                    default: Error = $"Unknown FMC review action '{Action}'"; break;
                }
            }
            catch (Exception ex)
            {
                Error = ex.Message;
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public string GetName() => "FMC review";

        private const double Pad = 300 / 304.8; // 300 mm around the elements, in feet

        /// <summary>
        /// A revision cloud around the elements' extent in the active view, on the latest unissued revision (Revit only
        /// clouds unissued ones); with none, a "Review" revision is made. Plan, section, elevation, drafting and sheet views
        /// only. A dry run says what it would do and changes nothing; the server sends the real run through the lock.
        /// </summary>
        private JObject Cloud(UIDocument ui)
        {
            Document doc = ui.Document;
            View view = ui.ActiveView ?? throw new InvalidOperationException("Open the view to cloud on.");
            if (view is View3D || view.ViewType == ViewType.Schedule || view.ViewType == ViewType.Legend || view.IsTemplate)
                throw new InvalidOperationException("Clouds go on plan, section, elevation, drafting or sheet views: open one with the elements.");
            bool dry = Parameters.Value<bool?>("dry_run") != false;
            var ids = (Parameters["element_ids"] as JArray ?? new JArray()).Select(x => new ElementId(x.Value<long>())).ToList();
            XYZ origin = view.Origin, right = view.RightDirection, up = view.UpDirection;
            double minU = double.MaxValue, minV = double.MaxValue, maxU = double.MinValue, maxV = double.MinValue;
            int found = 0;
            foreach (ElementId id in ids)
            {
                BoundingBoxXYZ box = doc.GetElement(id)?.get_BoundingBox(view);
                if (box == null) continue;
                found++;
                foreach (XYZ p in new[] { box.Min, box.Max, new XYZ(box.Min.X, box.Max.Y, box.Min.Z), new XYZ(box.Max.X, box.Min.Y, box.Max.Z) })
                {
                    XYZ q = box.Transform.OfPoint(p) - origin;
                    double u = q.DotProduct(right), v = q.DotProduct(up);
                    minU = Math.Min(minU, u); maxU = Math.Max(maxU, u); minV = Math.Min(minV, v); maxV = Math.Max(maxV, v);
                }
            }
            if (found == 0) throw new InvalidOperationException("None of the item's elements show in " + view.Name + ": open a view where they do.");
            minU -= Pad; minV -= Pad; maxU += Pad; maxV += Pad;

            Revision open = Revision.GetAllRevisionIds(doc).Select(id => doc.GetElement(id) as Revision).Where(r => r != null && !r.Issued)
                .OrderBy(r => r.SequenceNumber).LastOrDefault();
            string revision = open != null ? (open.RevisionNumber ?? "") + " " + open.Description : "a new Review revision";
            string viewLabel = view is ViewSheet s ? s.SheetNumber + " " + s.Name : view.Name;
            if (dry)
                return new JObject { ["view"] = viewLabel, ["revision"] = revision.Trim(), ["elements"] = found,
                    ["size_mm"] = Math.Round((maxU - minU) * 304.8) + " x " + Math.Round((maxV - minV) * 304.8) };

            using (var t = new Transaction(doc, "Formcraft: review cloud " + Parameters.Value<string>("mark")))
            {
                t.Start();
                if (open == null)
                {
                    open = Revision.Create(doc);
                    open.Description = "Review";
                    open.Issued = false;
                }
                XYZ P(double u, double v) => origin + right * u + up * v;
                var corners = new[] { P(minU, minV), P(maxU, minV), P(maxU, maxV), P(minU, maxV) };
                var curves = new List<Curve>();
                for (int k = 0; k < 4; k++) curves.Add(Line.CreateBound(corners[k], corners[(k + 1) % 4]));
                RevisionCloud cloud = RevisionCloud.Create(doc, view, open.Id, curves);
                cloud.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.Set(Parameters.Value<string>("mark") ?? "");
                cloud.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.Set(Parameters.Value<string>("comment") ?? "");
                t.Commit();
                return new JObject { ["cloud_id"] = cloud.Id.Value, ["view"] = viewLabel, ["revision"] = ((open.RevisionNumber ?? "") + " " + open.Description).Trim() };
            }
        }

        private static JObject Context(UIDocument ui)
        {
            Document doc = ui.Document;
            View view = ui.ActiveView;
            var selected = ui.Selection.GetElementIds().Take(200).Select(id => id.Value).ToList();
            return new JObject
            {
                ["model"] = doc.Title.EndsWith(".rvt", StringComparison.OrdinalIgnoreCase) ? doc.Title : doc.Title + ".rvt",
                ["view"] = view?.Name ?? "", ["view_id"] = view?.Id.Value ?? -1,
                ["sheet"] = view is ViewSheet s ? s.SheetNumber : "",
                ["selected"] = new JArray(selected),
            };
        }
    }
}
