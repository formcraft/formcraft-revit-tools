using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>Grids, walls and openings in one plan. No transaction. Coordinates are millimetres.</summary>
    public class FmcDimsHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft dimensions";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_dims needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    View view = FindView(doc, Parameters.Value<string>("view"));
                    if (view == null) throw new InvalidOperationException("[FMC-DIMS-VIEW] That view was not found.");
                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["title"] = doc.Title ?? "",
                        ["path"] = doc.PathName ?? "",
                        ["is_central"] = FmcPhaseIds.IsCentral(doc),
                        ["view"] = view.Name ?? "",
                        ["view_id"] = view.Id.Value.ToString(),
                        ["grids"] = Grids(doc, view),
                        ["walls"] = Walls(doc, view),
                        ["openings"] = Openings(doc, view),
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static JArray Grids(Document doc, View view)
        {
            var rows = new JArray();
            foreach (Grid grid in new FilteredElementCollector(doc, view.Id).OfClass(typeof(Grid)).Cast<Grid>())
            {
                if (grid.Curve is not Line line) continue;
                rows.Add(CurveRow(grid.Id.Value.ToString(), grid.Name, line.GetEndPoint(0), line.GetEndPoint(1), ""));
            }
            return rows;
        }

        private static JArray Walls(Document doc, View view)
        {
            var rows = new JArray();
            foreach (Wall wall in new FilteredElementCollector(doc, view.Id).OfClass(typeof(Wall)).Cast<Wall>())
            {
                if ((wall.Location as LocationCurve)?.Curve is not Line line) continue;
                rows.Add(CurveRow(wall.Id.Value.ToString(), wall.Name, line.GetEndPoint(0), line.GetEndPoint(1), wall.WallType?.Function.ToString() ?? ""));
            }
            return rows;
        }

        private static JArray Openings(Document doc, View view)
        {
            var rows = new JArray();
            foreach (FamilyInstance inst in new FilteredElementCollector(doc, view.Id).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>())
            {
                long cat = inst.Category?.Id.Value ?? 0;
                if (cat != (long)BuiltInCategory.OST_Doors && cat != (long)BuiltInCategory.OST_Windows) continue;
                XYZ point = (inst.Location as LocationPoint)?.Point ?? XYZ.Zero;
                rows.Add(new JObject
                {
                    ["id"] = inst.Id.Value.ToString(),
                    ["host_id"] = inst.Host?.Id.Value.ToString() ?? "",
                    ["x"] = Mm(point.X),
                    ["y"] = Mm(point.Y),
                    ["width_mm"] = Width(inst),
                });
            }
            return rows;
        }

        private static JObject CurveRow(string id, string name, XYZ a, XYZ b, string function) => new JObject
        {
            ["id"] = id,
            ["name"] = name ?? "",
            ["x0"] = Mm(a.X),
            ["y0"] = Mm(a.Y),
            ["x1"] = Mm(b.X),
            ["y1"] = Mm(b.Y),
            ["function"] = function,
        };

        private static double Width(FamilyInstance inst)
        {
            Parameter parameter = inst.Symbol?.get_Parameter(BuiltInParameter.DOOR_WIDTH) ?? inst.Symbol?.get_Parameter(BuiltInParameter.WINDOW_WIDTH) ?? inst.Symbol?.get_Parameter(BuiltInParameter.FAMILY_WIDTH_PARAM);
            return parameter == null ? 0 : Math.Round(parameter.AsDouble() * 304.8, 1);
        }

        internal static View FindView(Document doc, string key)
        {
            if (string.IsNullOrWhiteSpace(key)) return null;
            if (long.TryParse(key, out long id) && doc.GetElement(new ElementId(id)) is View byId) return byId;
            return new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().FirstOrDefault(view => !view.IsTemplate && string.Equals(view.Name, key, StringComparison.OrdinalIgnoreCase));
        }

        private static double Mm(double feet) => Math.Round(feet * 304.8, 1);
    }

    /// <summary>One transaction. One subtransaction per dimension string. A missing reference is not created.</summary>
    public class FmcDimsApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft dimensions apply";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_dims_apply needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    Refuse(doc);
                    View view = FmcDimsHandler.FindView(doc, Parameters.Value<string>("view"));
                    if (view == null) throw new InvalidOperationException("[FMC-DIMS-VIEW] That view was not found.");
                    var done = new JArray();
                    var skipped = new JArray();
                    using (var transaction = new Transaction(doc, "Formcraft dimensions"))
                    {
                        transaction.Start();
                        try
                        {
                            foreach (JObject row in (Parameters["strings"] as JArray ?? new JArray()).OfType<JObject>())
                                Place(doc, view, row, done, skipped);
                            transaction.Commit();
                        }
                        catch
                        {
                            if (transaction.HasStarted() && !transaction.HasEnded()) transaction.RollBack();
                            throw;
                        }
                    }
                    Result = new JObject { ["ok"] = true, ["applied"] = done, ["skipped"] = skipped, ["saved"] = false, ["synced"] = false, ["resolved_document"] = FmcTarget.Resolved(doc) };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private void Refuse(Document doc)
        {
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (Regex.IsMatch(blob, "hebert hostels", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("HEBERT HOSTELS is not written by fmc_dims.");
            if (FmcPhaseIds.IsCentral(doc)) throw new InvalidOperationException("A central model is not written by fmc_dims.");
            if (FmcTarget.IsProtected(doc.PathName ?? "", FmcTarget.Roots(Parameters)))
                throw new InvalidOperationException("The document is under a protected path.");
        }

        private static void Place(Document doc, View view, JObject row, JArray done, JArray skipped)
        {
            using (var sub = new SubTransaction(doc))
            {
                sub.Start();
                try
                {
                    var references = new ReferenceArray();
                    var missing = new JArray();
                    foreach (JObject item in (row["references"] as JArray ?? new JArray()).OfType<JObject>())
                    {
                        var found = ReferencesFor(doc, view, item);
                        if (found.Count == 0) missing.Add(item.Value<string>("id"));
                        foreach (Reference reference in found) references.Append(reference);
                    }
                    JObject line = row["line"] as JObject ?? new JObject();
                    XYZ a = new XYZ(Feet(line.Value<double?>("x0") ?? 0), Feet(line.Value<double?>("y0") ?? 0), 0);
                    XYZ b = new XYZ(Feet(line.Value<double?>("x1") ?? 0), Feet(line.Value<double?>("y1") ?? 0), 0);
                    if (references.Size < 2 || a.DistanceTo(b) < 1e-6 || missing.Count > 0)
                    {
                        sub.RollBack();
                        skipped.Add(new JObject { ["code"] = missing.Count > 0 ? "FMC-DIMS-NO-REFERENCE" : "FMC-DIMS-NEED-PAIR", ["missing"] = missing, ["kind"] = row.Value<string>("kind") });
                        return;
                    }
                    Dimension dimension = doc.Create.NewDimension(view, Line.CreateBound(a, b), references);
                    if (dimension == null) throw new InvalidOperationException("NewDimension returned nothing.");
                    sub.Commit();
                    done.Add(new JObject { ["id"] = dimension.Id.Value.ToString(), ["kind"] = row.Value<string>("kind"), ["references"] = references.Size });
                }
                catch (Exception ex)
                {
                    try { if (sub.HasStarted()) sub.RollBack(); } catch (Exception) { }
                    skipped.Add(new JObject { ["code"] = "FMC-DIMS-NO-REFERENCE", ["reason"] = ex.Message, ["kind"] = row.Value<string>("kind") });
                }
            }
        }

        private static List<Reference> ReferencesFor(Document doc, View view, JObject item)
        {
            var list = new List<Reference>();
            if (!long.TryParse(item.Value<string>("id"), out long id)) return list;
            Element element = doc.GetElement(new ElementId(id));
            string role = item.Value<string>("role") ?? "";
            if (element is Grid grid)
            {
                if (grid.Curve?.Reference != null) list.Add(grid.Curve.Reference);
                else list.Add(new Reference(grid));
                return list;
            }
            if (element is Wall wall && (role == "wall_start" || role == "wall_end"))
            {
                List<PlanarFace> faces = EndFaces(wall, view);
                PlanarFace face = role == "wall_start" ? faces.FirstOrDefault() : faces.LastOrDefault();
                if (face?.Reference != null) list.Add(face.Reference);
                return list;
            }
            if (element is FamilyInstance inst && role == "opening")
            {
                IList<Reference> refs = inst.GetReferences(FamilyInstanceReferenceType.CenterLeftRight);
                if (refs == null || refs.Count < 2) refs = inst.GetReferences(FamilyInstanceReferenceType.CenterFrontBack);
                if (refs != null) list.AddRange(refs.Where(reference => reference != null));
            }
            return list;
        }

        private static List<PlanarFace> EndFaces(Wall wall, View view)
        {
            var faces = new List<PlanarFace>();
            XYZ dir = ((wall.Location as LocationCurve)?.Curve as Line)?.Direction ?? XYZ.BasisX;
            var options = new Options { ComputeReferences = true, View = view, IncludeNonVisibleObjects = true };
            foreach (Solid solid in Solids(wall.get_Geometry(options)))
                foreach (Face face in solid.Faces)
                    if (face is PlanarFace planar && planar.Reference != null && Math.Abs(planar.FaceNormal.DotProduct(dir)) > 0.9)
                        faces.Add(planar);
            faces.Sort((a, b) => a.Origin.DotProduct(dir).CompareTo(b.Origin.DotProduct(dir)));
            return faces;
        }

        private static IEnumerable<Solid> Solids(GeometryElement geometry)
        {
            if (geometry == null) yield break;
            foreach (GeometryObject item in geometry)
            {
                if (item is Solid solid && solid.Faces.Size > 0) yield return solid;
                else if (item is GeometryInstance instance)
                    foreach (Solid nested in Solids(instance.GetInstanceGeometry())) yield return nested;
            }
        }

        private static double Feet(double mm) => mm / 304.8;
    }
}
