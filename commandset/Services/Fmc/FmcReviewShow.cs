using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_review_show (docs/PLAN_MARK_REVIEW.md, R4/R5): one click on a ticket brings you back to it. Its elements are
    /// selected (in this model and through links) and shown; when the ticket has a camera, a section box or a point and
    /// `view` is true, your own 3D view "FMC Review - <you>" takes its camera and a section box around it (the box the
    /// ticket kept, or 1.5 m around the place), and opens. Only that view of yours changes, never the model's elements.
    /// A clash ticket names Revit element ids with their source model: only the ones from this model are selected.
    /// </summary>
    public class FmcReviewShowHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return _done.WaitOne(timeoutMilliseconds); }
        public string GetName() => "Formcraft review show";

        private static double Ft(double mm) => mm / 304.8;
        private static XYZ P(JToken a) => new XYZ(Ft(a[0].Value<double>()), Ft(a[1].Value<double>()), Ft(a[2].Value<double>()));
        private static XYZ V(JToken a) => new XYZ(a[0].Value<double>(), a[1].Value<double>(), a[2].Value<double>());

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try { Result = Show(app); }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        private JObject Show(UIApplication app)
        {
            UIDocument ui = app.ActiveUIDocument ?? throw new InvalidOperationException("Open the model in Revit first");
            Document doc = ui.Document;
            JObject w = Parameters["where"] as JObject ?? new JObject();
            var notes = new JArray();

            // the elements: by UniqueId here, by Revit id when the clash came from this model, and through links
            var ids = new List<ElementId>();
            foreach (string u in (w["unique_ids"] as JArray ?? new JArray()).Select(t => t.Value<string>()))
                if (doc.GetElement(u) is Element e) ids.Add(e.Id);
            foreach (JObject c in (Parameters["revit_ids"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string model = c.Value<string>("model") ?? "";
                bool here = model.Length == 0 || doc.Title.IndexOf(System.IO.Path.GetFileNameWithoutExtension(model), StringComparison.OrdinalIgnoreCase) >= 0;
                if (here && long.TryParse(c.Value<string>("id"), out long n) && doc.GetElement(new ElementId(n)) != null) ids.Add(new ElementId(n));
                else if (!here) notes.Add($"element {c.Value<string>("id")} is in {model}: open that model or its link");
            }
            var refs = ids.Select(id => new Reference(doc.GetElement(id))).ToList();
            var links = new FilteredElementCollector(doc).OfClass(typeof(RevitLinkInstance)).Cast<RevitLinkInstance>().ToList();
            int linked = 0;
            foreach (JObject l in (w["linked"] as JArray ?? new JArray()).OfType<JObject>())
            {
                var inst = links.FirstOrDefault(x => string.Equals(x.GetLinkDocument()?.Title, l.Value<string>("link"), StringComparison.OrdinalIgnoreCase));
                Element le = inst?.GetLinkDocument()?.GetElement(l.Value<string>("unique_id"));
                if (le == null) { notes.Add($"{l.Value<string>("unique_id")} isn't in a loaded link {l.Value<string>("link")}"); continue; }
                refs.Add(new Reference(le).CreateLinkReference(inst));
                linked++;
            }

            // the place: the ticket's own section box, or 1.5 m around its point (or around its elements)
            bool wantView = Parameters.Value<bool?>("view") != false;
            XYZ min = null, max = null;
            if (w["section_box"] is JObject sb) { min = P(sb["min"]); max = P(sb["max"]); }
            else
            {
                XYZ c = w["point_mm"] is JArray pt ? P(pt) : null;
                if (c == null && ids.Count > 0)
                {
                    var boxes = ids.Select(id => doc.GetElement(id).get_BoundingBox(null)).Where(b => b != null).ToList();
                    if (boxes.Count > 0) c = new XYZ(boxes.Average(b => (b.Min.X + b.Max.X) / 2), boxes.Average(b => (b.Min.Y + b.Max.Y) / 2), boxes.Average(b => (b.Min.Z + b.Max.Z) / 2));
                }
                if (c != null) { var r = new XYZ(Ft(1500), Ft(1500), Ft(1500)); min = c - r; max = c + r; }
            }
            string viewName = "";
            if (wantView && (min != null || w["camera"] is JObject))
            {
                View3D v = ReviewView(doc, app.Application.Username, w["camera"] as JObject, min, max);
                ui.ActiveView = v;
                viewName = v.Name;
            }
            ui.Selection.SetReferences(refs);
            if (viewName.Length == 0 && ids.Count > 0) { try { ui.ShowElements(ids); } catch { /* not in any view: the selection holds */ } }
            return new JObject { ["selected"] = ids.Count, ["linked"] = linked, ["view"] = viewName, ["notes"] = notes };
        }

        /// <summary>Your own review view, made the first time: the ticket's camera and section box, in one transaction.</summary>
        private static View3D ReviewView(Document doc, string user, JObject camera, XYZ min, XYZ max)
        {
            string name = "FMC Review - " + (string.IsNullOrWhiteSpace(user) ? Environment.UserName : user);
            View3D v = new FilteredElementCollector(doc).OfClass(typeof(View3D)).Cast<View3D>().FirstOrDefault(x => !x.IsTemplate && x.Name == name);
            using (var t = new Transaction(doc, "FMC review view"))
            {
                t.Start();
                if (v == null)
                {
                    ViewFamilyType vft = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().First(x => x.ViewFamily == ViewFamily.ThreeDimensional);
                    v = View3D.CreateIsometric(doc, vft.Id);
                    v.Name = name;
                }
                if (min != null && max != null)
                {
                    v.IsSectionBoxActive = true;
                    v.SetSectionBox(new BoundingBoxXYZ { Min = new XYZ(Math.Min(min.X, max.X), Math.Min(min.Y, max.Y), Math.Min(min.Z, max.Z)), Max = new XYZ(Math.Max(min.X, max.X), Math.Max(min.Y, max.Y), Math.Max(min.Z, max.Z)) });
                }
                if (camera != null && !v.IsPerspective)
                {
                    XYZ eye = P(camera["eye"]), fwd = V(camera["direction"]).Normalize(), up = V(camera["up"]).Normalize();
                    // the up direction must be square to the forward one
                    up = (up - fwd.Multiply(up.DotProduct(fwd))).Normalize();
                    v.SetOrientation(new ViewOrientation3D(eye, up, fwd));
                }
                t.Commit();
            }
            return v;
        }
    }
}
