using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// One read for fmc_north. No transaction. Project north and shared coordinates are only read.
    /// The active view is not switched.
    /// </summary>
    public class FmcNorthHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft north";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            string titleBefore = app.ActiveUIDocument?.Document?.Title ?? "";
            string viewBefore = app.ActiveUIDocument?.ActiveView?.UniqueId ?? "";
            try
            {
                RevitMCPCommandSet.Bridge.FmcAiJob.Enter(app, RevitMCPCommandSet.Bridge.FmcAiJob.JobOf(Parameters));
                var docs = FmcNorthRead.Choose(app, Parameters);
                var rows = new JArray();
                foreach (Document doc in docs) rows.Add(FmcNorthRead.Read(doc, Parameters));
                Result = new JObject
                {
                    ["read_only"] = true,
                    ["saved"] = false,
                    ["project_north_changed"] = false,
                    ["shared_coordinates_changed"] = false,
                    ["documents"] = rows,
                    ["images"] = new JArray(),
                };
                if (docs.Count == 1) Result["resolved_document"] = FmcTarget.Resolved(docs[0]);
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

    internal static class FmcNorthRead
    {
        private const double Mm = 304.8;

        internal static List<Document> Choose(UIApplication app, JObject parameters)
        {
            var open = new List<Document>();
            foreach (Document doc in app.Application.Documents)
                if (doc != null && !doc.IsLinked && !doc.IsFamilyDocument) open.Add(doc);
            string one = (parameters.Value<string>("document") ?? "").Trim();
            var named = Strings(parameters["documents"] as JArray);
            if (named.Count == 0 && one.Length > 0) named.Add(one);
            if (named.Count == 0)
            {
                if (parameters.Value<bool?>("all_open") == true) return open;
                throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_north needs document, documents, or all_open. Refusing to use the active document.");
            }
            var found = new List<Document>();
            foreach (string key in named)
            {
                var hits = open.Where(d => FmcTarget.Same(d, key)).ToList();
                if (hits.Count > 1)
                    throw new InvalidOperationException($"[FMC-DOC-AMBIGUOUS] \"{key}\" matches {hits.Count} open documents. Pass the full path.");
                if (hits.Count == 0)
                    throw new InvalidOperationException($"[FMC-DOC-NOT-FOUND] No open document has title or path \"{key}\".");
                found.Add(hits[0]);
            }
            return found;
        }

        internal static JObject Read(Document doc, JObject parameters)
        {
            var body = new JObject
            {
                ["title"] = doc.Title ?? "",
                ["path"] = doc.PathName ?? "",
                ["is_central"] = FmcPhaseIds.IsCentral(doc),
                ["workshared"] = doc.IsWorkshared,
                ["images"] = new JArray(),
            };
            try
            {
                ProjectLocation loc = doc.ActiveProjectLocation;
                ProjectPosition origin = loc.GetProjectPosition(XYZ.Zero);
                ProjectPosition east = loc.GetProjectPosition(new XYZ(1, 0, 0));
                body["site"] = loc.Name ?? "";
                body["angle_deg"] = Round(Deg(origin.Angle), 6);
                body["easting_mm"] = Round(origin.EastWest * Mm, 3);
                body["northing_mm"] = Round(origin.NorthSouth * Mm, 3);
                body["elevation_mm"] = Round(origin.Elevation * Mm, 3);
                double dx = east.EastWest - origin.EastWest;
                double dy = east.NorthSouth - origin.NorthSouth;
                body["shared_basis_x_deg"] = Math.Sqrt(dx * dx + dy * dy) < 1e-9 ? JValue.CreateNull() : Round(Math.Atan2(dy, dx) * 180 / Math.PI, 6);
                body["sites"] = Sites(doc);
                body["survey_point"] = Marker(doc, true);
                body["project_base_point"] = Marker(doc, false);
            }
            catch (Exception ex)
            {
                body["read_error"] = ex.Message;
            }
            body["grids"] = Grids(doc);
            body["views"] = Views(doc);
            body["viewports"] = Viewports(doc);
            if (parameters.Value<bool?>("include_links") == true) body["links"] = Links(doc);
            else body["links"] = new JArray();
            string family = (parameters.Value<string>("family") ?? "").Trim();
            body["arrows"] = family.Length == 0 ? new JArray() : Arrows(doc, family, parameters.Value<string>("type_name") ?? "", parameters.Value<string>("match_param") ?? "");
            return body;
        }

        private static JArray Sites(Document doc)
        {
            var rows = new JArray();
            string active = doc.ActiveProjectLocation?.Name ?? "";
            foreach (ProjectLocation site in doc.ProjectLocations)
                rows.Add(new JObject { ["name"] = site.Name ?? "", ["active"] = string.Equals(site.Name, active, StringComparison.Ordinal) });
            return rows;
        }

        private static JObject Marker(Document doc, bool survey)
        {
            BasePoint point = survey ? BasePoint.GetSurveyPoint(doc) : BasePoint.GetProjectBasePoint(doc);
            var row = new JObject
            {
                ["id"] = point.Id.Value.ToString(),
                ["pinned"] = point.Pinned,
                ["easting_mm"] = Round(Feet(point, BuiltInParameter.BASEPOINT_EASTWEST_PARAM) * Mm, 3),
                ["northing_mm"] = Round(Feet(point, BuiltInParameter.BASEPOINT_NORTHSOUTH_PARAM) * Mm, 3),
                ["elevation_mm"] = Round(Feet(point, BuiltInParameter.BASEPOINT_ELEVATION_PARAM) * Mm, 3),
                ["x_mm"] = Round(point.Position.X * Mm, 3),
                ["y_mm"] = Round(point.Position.Y * Mm, 3),
                ["z_mm"] = Round(point.Position.Z * Mm, 3),
            };
            Parameter ang = point.get_Parameter(BuiltInParameter.BASEPOINT_ANGLETON_PARAM);
            row["angle_deg"] = ang != null && ang.StorageType == StorageType.Double ? Round(Deg(ang.AsDouble()), 6) : 0;
            return row;
        }

        private static JArray Grids(Document doc)
        {
            var rows = new JArray();
            foreach (Grid grid in new FilteredElementCollector(doc).OfClass(typeof(Grid)).Cast<Grid>())
            {
                double? angle = null;
                bool curved = true;
                if (grid.Curve is Line line)
                {
                    curved = false;
                    XYZ d = line.Direction;
                    angle = Math.Atan2(d.Y, d.X) * 180 / Math.PI;
                }
                rows.Add(new JObject
                {
                    ["id"] = grid.Id.Value.ToString(),
                    ["name"] = grid.Name ?? "",
                    ["angle_deg"] = angle == null ? JValue.CreateNull() : Round(angle.Value, 6),
                    ["curved"] = curved,
                });
            }
            return rows;
        }

        private static JArray Views(Document doc)
        {
            var rows = new JArray();
            foreach (View view in new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>())
            {
                if (view.IsTemplate) continue;
                if (view.ViewType == ViewType.Internal || view.ViewType == ViewType.ProjectBrowser || view.ViewType == ViewType.SystemBrowser) continue;
                Orientation(view, out string setting, out string paramName);
                double? crop = CropBasis(view);
                string scopeId = "";
                string scopeName = "";
                try
                {
                    Parameter scope = view.get_Parameter(BuiltInParameter.VIEWER_VOLUME_OF_INTEREST);
                    if (scope != null && scope.StorageType == StorageType.ElementId && scope.AsElementId() != null && scope.AsElementId() != ElementId.InvalidElementId)
                    {
                        scopeId = scope.AsElementId().Value.ToString();
                        scopeName = doc.GetElement(scope.AsElementId())?.Name ?? "";
                    }
                }
                catch { /* a view without a scope box parameter keeps empty strings */ }
                rows.Add(new JObject
                {
                    ["id"] = view.Id.Value.ToString(),
                    ["unique_id"] = view.UniqueId ?? "",
                    ["name"] = view.Name ?? "",
                    ["view_type"] = view.ViewType.ToString(),
                    ["is_plan"] = view is ViewPlan,
                    ["orientation"] = setting,
                    ["orientation_param"] = paramName,
                    ["crop_basis_x_deg"] = crop == null ? JValue.CreateNull() : Round(crop.Value, 6),
                    ["crop_active"] = CropActive(view),
                    ["scope_box_id"] = scopeId,
                    ["scope_box"] = scopeName,
                });
            }
            return rows;
        }

        private static JArray Viewports(Document doc)
        {
            var rows = new JArray();
            foreach (Viewport port in new FilteredElementCollector(doc).OfClass(typeof(Viewport)).Cast<Viewport>())
            {
                ViewSheet sheet = doc.GetElement(port.SheetId) as ViewSheet;
                XYZ center = port.GetBoxCenter();
                var row = new JObject
                {
                    ["id"] = port.Id.Value.ToString(),
                    ["view_id"] = port.ViewId.Value.ToString(),
                    ["sheet_id"] = port.SheetId.Value.ToString(),
                    ["sheet_number"] = sheet?.SheetNumber ?? "",
                    ["sheet_name"] = sheet?.Name ?? "",
                    ["center_mm"] = new JObject { ["x"] = Round(center.X * Mm, 3), ["y"] = Round(center.Y * Mm, 3) },
                };
                try
                {
                    Outline box = port.GetBoxOutline();
                    row["outline_mm"] = new JObject
                    {
                        ["min"] = new JObject { ["x"] = Round(box.MinimumPoint.X * Mm, 3), ["y"] = Round(box.MinimumPoint.Y * Mm, 3) },
                        ["max"] = new JObject { ["x"] = Round(box.MaximumPoint.X * Mm, 3), ["y"] = Round(box.MaximumPoint.Y * Mm, 3) },
                    };
                }
                catch { /* outline is optional; the centre is enough for a distance */ }
                rows.Add(row);
            }
            return rows;
        }

        private static JArray Links(Document doc)
        {
            var rows = new JArray();
            foreach (RevitLinkInstance inst in new FilteredElementCollector(doc).OfClass(typeof(RevitLinkInstance)).Cast<RevitLinkInstance>())
            {
                Transform t = inst.GetTotalTransform();
                XYZ origin = t.Origin;
                var row = new JObject
                {
                    ["id"] = inst.Id.Value.ToString(),
                    ["name"] = inst.Name ?? "",
                    ["pinned"] = inst.Pinned,
                    ["basis_x_deg"] = Round(Math.Atan2(t.BasisX.Y, t.BasisX.X) * 180 / Math.PI, 6),
                    ["origin_mm"] = Xyz(origin),
                };
                Document link = null;
                try { link = inst.GetLinkDocument(); } catch { link = null; }
                row["loaded"] = link != null;
                try
                {
                    ProjectPosition at = doc.ActiveProjectLocation.GetProjectPosition(origin);
                    row["host_shared_mm"] = new JObject
                    {
                        ["x"] = Round(at.EastWest * Mm, 3),
                        ["y"] = Round(at.NorthSouth * Mm, 3),
                        ["z"] = Round(at.Elevation * Mm, 3),
                    };
                }
                catch (Exception ex) { row["host_shared_error"] = ex.Message; }
                if (link == null) row["link"] = JValue.CreateNull();
                else
                {
                    try
                    {
                        ProjectPosition o = link.ActiveProjectLocation.GetProjectPosition(XYZ.Zero);
                        row["link"] = new JObject
                        {
                            ["title"] = link.Title ?? "",
                            ["angle_deg"] = Round(Deg(o.Angle), 6),
                            ["easting_mm"] = Round(o.EastWest * Mm, 3),
                            ["northing_mm"] = Round(o.NorthSouth * Mm, 3),
                            ["elevation_mm"] = Round(o.Elevation * Mm, 3),
                            ["survey_point"] = Marker(link, true),
                        };
                        ProjectPosition x = link.ActiveProjectLocation.GetProjectPosition(new XYZ(1, 0, 0));
                        double dx = x.EastWest - o.EastWest;
                        double dy = x.NorthSouth - o.NorthSouth;
                        row["link"]["shared_basis_x_deg"] = Math.Sqrt(dx * dx + dy * dy) < 1e-9 ? JValue.CreateNull() : Round(Math.Atan2(dy, dx) * 180 / Math.PI, 6);
                    }
                    catch (Exception ex) { row["link"] = new JObject { ["title"] = link.Title ?? "", ["error"] = ex.Message }; }
                }
                rows.Add(row);
            }
            return rows;
        }

        private static JArray Arrows(Document doc, string family, string typeName, string paramName)
        {
            var rows = new JArray();
            foreach (FamilyInstance fi in new FilteredElementCollector(doc).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>())
            {
                FamilySymbol symbol = null;
                try { symbol = fi.Symbol; } catch { symbol = null; }
                if (symbol?.Family == null) continue;
                if (!string.Equals(symbol.Family.Name, family, StringComparison.OrdinalIgnoreCase)) continue;
                if (!string.IsNullOrWhiteSpace(typeName) && !string.Equals(symbol.Name, typeName, StringComparison.OrdinalIgnoreCase)) continue;
                View owner = doc.GetElement(fi.OwnerViewId) as View;
                bool onSheet = owner is ViewSheet;
                double? rotation = null;
                double x = 0, y = 0;
                if (fi.Location is LocationPoint lp)
                {
                    rotation = Deg(lp.Rotation);
                    x = lp.Point.X * Mm;
                    y = lp.Point.Y * Mm;
                }
                rows.Add(new JObject
                {
                    ["id"] = fi.Id.Value.ToString(),
                    ["family"] = symbol.Family.Name ?? "",
                    ["type_name"] = symbol.Name ?? "",
                    ["sheet_id"] = onSheet ? owner.Id.Value.ToString() : "",
                    ["on_sheet"] = onSheet,
                    ["x_mm"] = Round(x, 3),
                    ["y_mm"] = Round(y, 3),
                    ["rotation_deg"] = rotation == null ? JValue.CreateNull() : Round(rotation.Value, 6),
                    ["pinned"] = fi.Pinned,
                    ["param"] = ParamText(fi, paramName),
                });
            }
            return rows;
        }

        internal static string ParamText(Element element, string name)
        {
            if (string.IsNullOrWhiteSpace(name) || element == null) return "";
            Parameter p = element.LookupParameter(name);
            if (p == null) return "";
            if (p.StorageType == StorageType.String) return p.AsString() ?? "";
            if (p.StorageType == StorageType.Integer) return p.AsInteger().ToString();
            if (p.StorageType == StorageType.ElementId) return p.AsElementId()?.Value.ToString() ?? "";
            return p.AsValueString() ?? "";
        }

        private static void Orientation(View view, out string setting, out string paramName)
        {
            setting = "";
            paramName = "";
            Parameter p = null;
            try { p = view.get_Parameter(BuiltInParameter.PLAN_VIEW_NORTH); } catch { p = null; }
            if (p != null)
            {
                paramName = "PLAN_VIEW_NORTH";
                setting = Label(p);
                return;
            }
            if (Enum.TryParse("VIEWER_ORIENTATION", out BuiltInParameter viewer))
            {
                try { p = view.get_Parameter(viewer); } catch { p = null; }
                if (p != null)
                {
                    paramName = "VIEWER_ORIENTATION";
                    setting = Label(p);
                    return;
                }
            }
            Parameter named = view.LookupParameter("Orientation");
            if (named != null)
            {
                paramName = "Orientation";
                setting = Label(named);
            }
        }

        private static string Label(Parameter p)
        {
            string text = "";
            try { text = p.AsValueString() ?? ""; } catch { text = ""; }
            if (!string.IsNullOrWhiteSpace(text)) return text;
            if (p.StorageType == StorageType.Integer)
            {
                int n = p.AsInteger();
                if (n == 1) return "True North";
                if (n == 0) return "Project North";
                return n.ToString();
            }
            return "";
        }

        private static double? CropBasis(View view)
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

        private static bool CropActive(View view)
        {
            try { return view.CropBoxActive; } catch { return false; }
        }

        private static double Feet(Element element, BuiltInParameter bip)
        {
            Parameter p = element.get_Parameter(bip);
            return p != null && p.StorageType == StorageType.Double ? p.AsDouble() : 0;
        }

        internal static JObject Xyz(XYZ p) => new JObject { ["x"] = Round(p.X * Mm, 3), ["y"] = Round(p.Y * Mm, 3), ["z"] = Round(p.Z * Mm, 3) };

        internal static List<string> Strings(JArray array)
        {
            var list = new List<string>();
            if (array == null) return list;
            foreach (JToken token in array)
                if (!string.IsNullOrWhiteSpace(token.ToString())) list.Add(token.ToString().Trim());
            return list;
        }

        internal static double Deg(double rad) => rad * 180.0 / Math.PI;
        internal static double Round(double n, int digits) => Math.Round(n, digits);
    }
}
