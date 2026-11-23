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
                        ["rooms"] = Rooms(doc, view),
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

        private static JArray Rooms(Document doc, View view)
        {
            var rows = new JArray();
            var options = new SpatialElementBoundaryOptions { SpatialElementBoundaryLocation = SpatialElementBoundaryLocation.Finish };
            foreach (SpatialElement room in new FilteredElementCollector(doc, view.Id).OfCategory(BuiltInCategory.OST_Rooms).WhereElementIsNotElementType().Cast<SpatialElement>())
            {
                if (room.Area <= 0) continue;
                try
                {
                XYZ loc = (room.Location as LocationPoint)?.Point ?? XYZ.Zero;
                var bounds = new JArray();
                IList<IList<BoundarySegment>> loops = room.GetBoundarySegments(options);
                BoundarySegment left = null, right = null, bottom = null, top = null;
                double leftX = double.MaxValue, rightX = double.MinValue, bottomY = double.MaxValue, topY = double.MinValue;
                if (loops != null)
                {
                    foreach (IList<BoundarySegment> loop in loops)
                    {
                        foreach (BoundarySegment seg in loop)
                        {
                            Curve curve = seg.GetCurve();
                            if (curve == null) continue;
                            XYZ a = curve.GetEndPoint(0), b = curve.GetEndPoint(1), mid = curve.Evaluate(0.5, true);
                            if (Math.Abs(b.Y - a.Y) >= Math.Abs(b.X - a.X))
                            {
                                if (mid.X < leftX) { leftX = mid.X; left = seg; }
                                if (mid.X > rightX) { rightX = mid.X; right = seg; }
                            }
                            else
                            {
                                if (mid.Y < bottomY) { bottomY = mid.Y; bottom = seg; }
                                if (mid.Y > topY) { topY = mid.Y; top = seg; }
                            }
                        }
                    }
                }
                AddBound(bounds, left, "left", loc);
                AddBound(bounds, right, "right", loc);
                AddBound(bounds, bottom, "bottom", loc);
                AddBound(bounds, top, "top", loc);
                rows.Add(new JObject
                {
                    ["id"] = room.Id.Value.ToString(),
                    ["name"] = room.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString() ?? "",
                    ["x"] = Mm(loc.X),
                    ["y"] = Mm(loc.Y),
                    ["bounds"] = bounds,
                });
                }
                catch (Exception) { /* a room with no boundary is omitted from this read */ }
            }
            return rows;
        }

        private static void AddBound(JArray bounds, BoundarySegment seg, string side, XYZ room)
        {
            if (seg == null || seg.ElementId == null || seg.ElementId == ElementId.InvalidElementId) return;
            Curve curve = seg.GetCurve();
            if (curve == null) return;
            XYZ mid = curve.Evaluate(0.5, true);
            XYZ toward = new XYZ(room.X - mid.X, room.Y - mid.Y, 0);
            if (toward.GetLength() < 1e-9) toward = XYZ.BasisX;
            toward = toward.Normalize();
            bounds.Add(new JObject
            {
                ["wall_id"] = seg.ElementId.Value.ToString(),
                ["side"] = side,
                ["x"] = Mm(mid.X),
                ["y"] = Mm(mid.Y),
                ["nx"] = Math.Round(toward.X, 4),
                ["ny"] = Math.Round(toward.Y, 4),
            });
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
            if (element is Wall sideWall && (role == "wall_side" || role == "room_side"))
            {
                Reference face = SideFace(sideWall, view, item.Value<double?>("nx") ?? 0, item.Value<double?>("ny") ?? 0);
                if (face != null) list.Add(face);
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

        /// <summary>A long face (normal across the wall) whose normal best matches the requested direction.</summary>
        private static Reference SideFace(Wall wall, View view, double nx, double ny)
        {
            XYZ want = new XYZ(nx, ny, 0);
            if (want.GetLength() < 1e-6) want = wall.Orientation ?? XYZ.BasisX;
            want = want.Normalize();
            XYZ dir = ((wall.Location as LocationCurve)?.Curve as Line)?.Direction ?? XYZ.BasisX;
            PlanarFace best = null;
            double score = -2;
            var options = new Options { ComputeReferences = true, View = view, IncludeNonVisibleObjects = true };
            foreach (Solid solid in Solids(wall.get_Geometry(options)))
            {
                foreach (Face face in solid.Faces)
                {
                    if (face is not PlanarFace planar || planar.Reference == null) continue;
                    if (Math.Abs(planar.FaceNormal.DotProduct(dir)) > 0.3) continue;
                    double dot = planar.FaceNormal.DotProduct(want);
                    if (dot > score) { score = dot; best = planar; }
                }
            }
            return best?.Reference;
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
