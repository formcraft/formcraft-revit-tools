using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// One transaction. Rotates a crop region or a scope box, or a sheet north arrow.
    /// Project north and the shared coordinates are read before and after. If they move, the transaction is rolled back.
    /// </summary>
    public class FmcNorthApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft north apply";

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
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_north_apply needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    if (doc.IsFamilyDocument) throw new InvalidOperationException("[FMC-NORTH] fmc_north_apply runs on a project model.");
                    Refuse(doc);
                    NorthLock before = NorthLock.Read(doc);
                    string action = (Parameters.Value<string>("action") ?? "").Trim();
                    var done = new JArray();
                    var skipped = new JArray();
                    using (var transaction = new Transaction(doc, "Formcraft north"))
                    {
                        transaction.Start();
                        try
                        {
                            if (action == "align_views") Align(doc, done, skipped);
                            else if (action == "north_arrows") Arrows(doc, done, skipped);
                            else throw new InvalidOperationException("[FMC-NORTH-PLAN] fmc_north_apply knows align_views and north_arrows.");
                            if (before.Moved(doc))
                            {
                                transaction.RollBack();
                                throw new InvalidOperationException("[FMC-NORTH-PROJECT-NORTH] Project north or the shared coordinates would have changed. The transaction was rolled back. Nothing was saved.");
                            }
                            transaction.Commit();
                        }
                        catch
                        {
                            if (transaction.HasStarted() && !transaction.HasEnded()) transaction.RollBack();
                            throw;
                        }
                    }
                    Result = new JObject
                    {
                        ["ok"] = true,
                        ["action"] = action,
                        ["applied"] = done,
                        ["skipped"] = skipped,
                        ["saved"] = false,
                        ["synced"] = false,
                        ["read_only"] = false,
                        ["project_north_changed"] = false,
                        ["shared_coordinates_changed"] = false,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                        ["is_central"] = false,
                    };
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

        private void Refuse(Document doc)
        {
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (Regex.IsMatch(blob, "hebert hostels", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("HEBERT HOSTELS is not written by fmc_north.");
            if (FmcPhaseIds.IsCentral(doc)) throw new InvalidOperationException("A central model is not written by fmc_north.");
            if (FmcTarget.IsProtected(doc.PathName ?? "", FmcTarget.Roots(Parameters)))
                throw new InvalidOperationException("The document is under a protected path.");
        }

        private void Align(Document doc, JArray done, JArray skipped)
        {
            string mode = (Parameters.Value<string>("mode") ?? "crop").Trim();
            var ops = (Parameters["ops"] as JArray ?? new JArray()).OfType<JObject>().ToList();
            if (mode == "scope_box")
            {
                string key = (Parameters.Value<string>("scope_box") ?? ops.Select(o => o.Value<string>("scope_box_id")).FirstOrDefault(s => !string.IsNullOrWhiteSpace(s)) ?? "").Trim();
                Element box = FindScope(doc, key);
                if (box == null) throw new InvalidOperationException("[FMC-NORTH-SCOPE-REQUIRED] No scope box named '" + key + "'.");
                double delta = ops.Select(o => o.Value<double?>("delta_deg") ?? 0).FirstOrDefault();
                var viewIds = new JArray();
                foreach (JObject op in ops)
                {
                    ViewPlan view = FindPlan(doc, op.Value<string>("view_id"));
                    if (view == null) { skipped.Add(new JObject { ["view_id"] = op.Value<string>("view_id"), ["code"] = "FMC-NORTH-VIEW-NOT-PLAN" }); continue; }
                    if (!Hold(doc, view.Id, skipped)) continue;
                    Parameter scope = view.get_Parameter(BuiltInParameter.VIEWER_VOLUME_OF_INTEREST);
                    if (scope == null || scope.IsReadOnly || !scope.Set(box.Id))
                    {
                        skipped.Add(new JObject { ["view_id"] = view.Id.Value.ToString(), ["code"] = "FMC-NORTH-SCOPE-REQUIRED" });
                        continue;
                    }
                    viewIds.Add(view.Id.Value.ToString());
                }
                if (Math.Abs(delta) > 1e-9)
                {
                    if (!Hold(doc, box.Id, skipped)) return;
                    XYZ at = (box.get_BoundingBox(null) is BoundingBoxXYZ bb) ? (bb.Min + bb.Max) * 0.5 : XYZ.Zero;
                    ElementTransformUtils.RotateElement(doc, box.Id, Line.CreateBound(at, at + XYZ.BasisZ), delta * Math.PI / 180.0);
                }
                done.Add(new JObject { ["mode"] = "scope_box", ["scope_box_id"] = box.Id.Value.ToString(), ["delta_deg"] = delta, ["views"] = viewIds, ["shared"] = true, ["note"] = "Assigning a scope box sets the crop to the box. Rotating it turns every view that uses it." });
                return;
            }
            foreach (JObject op in ops)
            {
                ViewPlan view = FindPlan(doc, op.Value<string>("view_id"));
                if (view == null) { skipped.Add(new JObject { ["view_id"] = op.Value<string>("view_id"), ["code"] = "FMC-NORTH-VIEW-NOT-PLAN" }); continue; }
                double? before = Basis(view);
                var ports = Ports(doc, view.Id);
                double delta = op.Value<double?>("delta_deg") ?? 0;
                if (!Hold(doc, view.Id, skipped)) continue;
                Element crop = CropElement(doc, view);
                bool activated = false;
                if (crop == null)
                {
                    try { view.CropBoxActive = true; doc.Regenerate(); activated = true; } catch { /* reported below if it is still missing */ }
                    crop = CropElement(doc, view);
                }
                if (crop == null)
                {
                    skipped.Add(new JObject { ["view_id"] = view.Id.Value.ToString(), ["code"] = "FMC-NORTH-CROP-NOT-FOUND", ["fix"] = "Revit returned no crop region element. There is no public CropRegion class." });
                    continue;
                }
                if (crop.Pinned)
                {
                    skipped.Add(new JObject { ["id"] = crop.Id.Value.ToString(), ["code"] = "FMC-NORTH-PINNED" });
                    continue;
                }
                if (!Hold(doc, crop.Id, skipped)) continue;
                if (Math.Abs(delta) > 1e-9)
                {
                    BoundingBoxXYZ box = view.CropBox;
                    XYZ center = box.Transform.OfPoint((box.Min + box.Max) * 0.5);
                    ElementTransformUtils.RotateElement(doc, crop.Id, Line.CreateBound(center, center + XYZ.BasisZ), delta * Math.PI / 180.0);
                    doc.Regenerate();
                }
                double? after = Basis(view);
                var shifts = new JArray();
                foreach (var pair in ports)
                {
                    if (doc.GetElement(pair.Key) is not Viewport port) continue;
                    XYZ now = port.GetBoxCenter();
                    double shift = now.DistanceTo(pair.Value) * 304.8;
                    bool restored = false;
                    string restoreError = "";
                    if (shift > 0.5)
                    {
                        try { port.SetBoxCenter(pair.Value); restored = true; }
                        catch (Exception ex) { restoreError = ex.Message; }
                    }
                    if (shift > 0.5)
                        shifts.Add(new JObject { ["viewport_id"] = port.Id.Value.ToString(), ["shifted_mm"] = Math.Round(shift, 3), ["restored"] = restored, ["error"] = restoreError, ["code"] = "FMC-NORTH-VIEWPORT-SHIFT" });
                }
                done.Add(new JObject
                {
                    ["view_id"] = view.Id.Value.ToString(),
                    ["name"] = view.Name,
                    ["before_deg"] = before == null ? JValue.CreateNull() : Math.Round(before.Value, 6),
                    ["after_deg"] = after == null ? JValue.CreateNull() : Math.Round(after.Value, 6),
                    ["delta_deg"] = delta,
                    ["crop_activated"] = activated,
                    ["crop_id"] = crop.Id.Value.ToString(),
                    ["viewports"] = shifts,
                });
            }
        }

        private void Arrows(Document doc, JArray done, JArray skipped)
        {
            foreach (JObject op in (Parameters["ops"] as JArray ?? new JArray()).OfType<JObject>())
            {
                if (!long.TryParse(op.Value<string>("arrow_id"), out long id)) { skipped.Add(new JObject { ["code"] = "FMC-NORTH-ARROW-UNMATCHED" }); continue; }
                if (doc.GetElement(new ElementId(id)) is not FamilyInstance fi)
                {
                    skipped.Add(new JObject { ["id"] = id.ToString(), ["code"] = "FMC-NORTH-ARROW-UNMATCHED" });
                    continue;
                }
                if (fi.Pinned) { skipped.Add(new JObject { ["id"] = id.ToString(), ["code"] = "FMC-NORTH-PINNED" }); continue; }
                if (doc.GetElement(fi.OwnerViewId) is not ViewSheet) { skipped.Add(new JObject { ["id"] = id.ToString(), ["code"] = "FMC-NORTH-ARROW-IN-VIEW" }); continue; }
                if (fi.Location is not LocationPoint lp)
                {
                    skipped.Add(new JObject { ["id"] = id.ToString(), ["code"] = "FMC-NORTH-ARROW-UNMATCHED", ["fix"] = "The arrow has no point location, so it was not rotated." });
                    continue;
                }
                if (!Hold(doc, fi.Id, skipped)) continue;
                double before = lp.Rotation * 180 / Math.PI;
                double target = op.Value<double?>("target_deg") ?? before;
                double delta = target - before;
                while (delta > 180) delta -= 360;
                while (delta <= -180) delta += 360;
                if (Math.Abs(delta) > 1e-6)
                    ElementTransformUtils.RotateElement(doc, fi.Id, Line.CreateBound(lp.Point, lp.Point + XYZ.BasisZ), delta * Math.PI / 180.0);
                double after = (fi.Location as LocationPoint)?.Rotation * 180 / Math.PI ?? target;
                done.Add(new JObject { ["id"] = id.ToString(), ["before_deg"] = Math.Round(before, 6), ["after_deg"] = Math.Round(after, 6), ["target_deg"] = target });
            }
        }

        private static bool Hold(Document doc, ElementId id, JArray skipped)
        {
            var kept = new List<ElementId>();
            var held = new JArray();
            FmcCheckout.Partition(doc, new List<ElementId> { id }, kept, held);
            foreach (JToken row in held) skipped.Add(row);
            return kept.Count == 1;
        }

        private static ViewPlan FindPlan(Document doc, string id)
        {
            if (!long.TryParse(id, out long value)) return null;
            return doc.GetElement(new ElementId(value)) as ViewPlan;
        }

        private static Element FindScope(Document doc, string key)
        {
            if (string.IsNullOrWhiteSpace(key)) return null;
            foreach (Element element in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_VolumeOfInterest).WhereElementIsNotElementType())
            {
                if (element.Id.Value.ToString() == key || string.Equals(element.Name, key, StringComparison.OrdinalIgnoreCase)) return element;
            }
            return null;
        }

        /// <summary>
        /// There is no public crop-region class. Dependents in OST_CropBoundary, then a collector on the view, then a type name containing Crop.
        /// </summary>
        internal static Element CropElement(Document doc, View view)
        {
            try
            {
                foreach (ElementId id in view.GetDependentElements(new ElementCategoryFilter(BuiltInCategory.OST_CropBoundary)))
                {
                    Element element = doc.GetElement(id);
                    if (element != null) return element;
                }
            }
            catch { /* the category filter is not valid on every view */ }
            try
            {
                Element found = new FilteredElementCollector(doc, view.Id).OfCategory(BuiltInCategory.OST_CropBoundary).WhereElementIsNotElementType().FirstElement();
                if (found != null) return found;
            }
            catch { /* a view with no crop keeps looking */ }
            try
            {
                foreach (ElementId id in view.GetDependentElements(null))
                {
                    Element element = doc.GetElement(id);
                    if (element == null || element.Id == view.Id) continue;
                    string name = element.GetType().Name ?? "";
                    if (name.IndexOf("Crop", StringComparison.OrdinalIgnoreCase) >= 0) return element;
                    if ((element.Category?.Name ?? "").IndexOf("Crop", StringComparison.OrdinalIgnoreCase) >= 0) return element;
                }
            }
            catch { /* dependents can throw on a corrupt view */ }
            return null;
        }

        private static double? Basis(View view)
        {
            try
            {
                BoundingBoxXYZ box = view.CropBox;
                if (box?.Transform == null) return null;
                XYZ x = box.Transform.BasisX;
                if (x.GetLength() < 1e-9) return null;
                return Math.Atan2(x.Y, x.X) * 180 / Math.PI;
            }
            catch { return null; }
        }

        private static Dictionary<ElementId, XYZ> Ports(Document doc, ElementId viewId)
        {
            var map = new Dictionary<ElementId, XYZ>();
            foreach (Viewport port in new FilteredElementCollector(doc).OfClass(typeof(Viewport)).Cast<Viewport>())
                if (port.ViewId == viewId) map[port.Id] = port.GetBoxCenter();
            return map;
        }
    }

    /// <summary>The shared position of the internal origin, so a write can prove it did not move project north.</summary>
    internal sealed class NorthLock
    {
        private readonly double _angle;
        private readonly double _east;
        private readonly double _north;
        private readonly double _elev;
        private NorthLock(double angle, double east, double north, double elev)
        {
            _angle = angle; _east = east; _north = north; _elev = elev;
        }

        internal static NorthLock Read(Document doc)
        {
            ProjectPosition origin = doc.ActiveProjectLocation.GetProjectPosition(XYZ.Zero);
            return new NorthLock(origin.Angle, origin.EastWest, origin.NorthSouth, origin.Elevation);
        }

        internal bool Moved(Document doc)
        {
            ProjectPosition now = doc.ActiveProjectLocation.GetProjectPosition(XYZ.Zero);
            if (Math.Abs(now.EastWest - _east) > 1e-7) return true;
            if (Math.Abs(now.NorthSouth - _north) > 1e-7) return true;
            if (Math.Abs(now.Elevation - _elev) > 1e-7) return true;
            double d = now.Angle - _angle;
            while (d > Math.PI) d -= 2 * Math.PI;
            while (d < -Math.PI) d += 2 * Math.PI;
            return Math.Abs(d) > 1e-8;
        }
    }
}
