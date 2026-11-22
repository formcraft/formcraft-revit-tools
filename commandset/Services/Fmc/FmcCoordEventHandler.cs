using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_coord_apply. One call reads a coordination snapshot, or moves the survey relationship, the project base
    /// point, or elements, or places a family or a reference point. It never calls AcquireCoordinates or
    /// PublishCoordinates. Pinned elements and elements another person owns are reported and left alone.
    /// A missing document is FMC-DOC-REQUIRED. The active document is not a fallback.
    /// </summary>
    public class FmcCoordEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double FtToMm = 304.8;
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return FmcBusy.Wait(_resetEvent, timeoutMilliseconds);
        }

        public string GetName() => "FMC coordination";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                if (Parameters.Value<bool?>("acquire") == true)
                    throw new InvalidOperationException("[FMC-COORD-NO-ACQUIRE] Coordinates are not acquired from a link. Publish a record and align to it.");
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_coord_apply needs document: a title or a full path. Refusing to use the active document.");
                string action = (Parameters.Value<string>("action") ?? "snapshot").Trim().ToLowerInvariant();
                if (action == "publish" || action == "check" || action == "read") action = "snapshot";
                bool write = Parameters.Value<bool?>("dry_run") == false && (action == "align" || action == "place");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    if (action == "align") Result = Align(doc, write);
                    else if (action == "place") Result = Place(doc, write);
                    else Result = Snapshot(doc);
                    string otherKey = (Parameters.Value<string>("other") ?? "").Trim();
                    if (action == "snapshot" && otherKey.Length > 0)
                        Result["other"] = Snapshot(Other(app, otherKey));
                    Result["document"] = FmcTarget.Resolved(doc);
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                    Result["dry_run"] = !write;
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

        private static Document Other(UIApplication app, string key)
        {
            var found = new List<Document>();
            foreach (Document doc in app.Application.Documents)
                if (!doc.IsLinked && FmcTarget.Same(doc, key)) found.Add(doc);
            if (found.Count > 1)
                throw new InvalidOperationException($"[FMC-DOC-AMBIGUOUS] \"{key}\" matches {found.Count} open documents ({string.Join("; ", found.Select(d => string.IsNullOrEmpty(d.PathName) ? d.Title : d.PathName))}). Pass the full path. Refusing to use the active document.");
            if (found.Count == 0)
                throw new InvalidOperationException($"[FMC-DOC-NOT-FOUND] No open document has title or path \"{key}\". Refusing to use the active document.");
            return found[0];
        }

        private JObject Snapshot(Document doc)
        {
            string level = (Parameters.Value<string>("level") ?? "model").Trim().ToLowerInvariant();
            Transform shared = SharedOf(doc);
            var points = new JArray();
            var objects = new JArray();
            var families = new JArray();
            var notes = new JArray();
            JObject model = null;
            if (level == "model" || level == "all" || level.Length == 0)
            {
                model = ModelOf(doc, shared);
                Grids(doc, shared, points);
            }
            if (level == "family" || level == "all") FamilyOf(doc, families, notes);
            if (level == "object" || level == "all") ObjectsOf(doc, shared, objects, notes);
            foreach (JObject row in (Parameters["point_ids"] as JArray ?? new JArray()).OfType<JObject>())
            {
                Element e = Find(doc, row.Value<string>("id"));
                if (e == null) { notes.Add("No element " + row.Value<string>("id")); continue; }
                XYZ at = SharedPoint(shared, PointOf(e));
                points.Add(PointEntry(row.Value<string>("name") ?? e.Name, row.Value<string>("kind") ?? "user", at, 0, e.Id.Value.ToString()));
            }
            var ids = new JArray();
            foreach (JObject row in objects.OfType<JObject>()) ids.Add(row.Value<string>("stable_id") ?? row["id"]?.ToString());
            foreach (JObject row in points.OfType<JObject>()) ids.Add(row.Value<string>("id") ?? row.Value<string>("name"));
            return new JObject
            {
                ["model"] = model, ["control_points"] = points, ["objects"] = objects, ["families"] = families,
                ["summary"] = new JObject { ["control_points"] = points.Count, ["objects"] = objects.Count, ["families"] = families.Count, ["ids"] = ids },
                ["note"] = notes.Count == 0 ? "" : string.Join(" ", notes.Select(n => n.ToString())),
            };
        }

        private JObject Align(Document doc, bool write)
        {
            string level = (Parameters.Value<string>("level") ?? "model").Trim().ToLowerInvariant();
            var would = new JArray();
            var skipped = new JArray();
            var applied = new JArray();
            using (Transaction t = write ? new Transaction(doc, "Formcraft: coord align") : null)
            {
                if (t != null) t.Start();
                try
                {
                    if (level != "object") AlignModel(doc, write, would, skipped, applied);
                    if (level == "object" || level == "all") AlignObjects(doc, write, would, skipped, applied);
                    if (t != null) t.Commit();
                }
                catch
                {
                    if (t != null && t.HasStarted() && !t.HasEnded()) t.RollBack();
                    throw;
                }
            }
            return new JObject { ["ok"] = true, ["would"] = would, ["skipped"] = skipped, ["applied"] = applied };
        }

        private void AlignModel(Document doc, bool write, JArray would, JArray skipped, JArray applied)
        {
            if (!TryMatrix(Parameters["transform"], out double[,] matrix))
                throw new InvalidOperationException("[FMC-COORD-MATRIX] align needs a 4x4 transform.");
            string which = (Parameters.Value<string>("target") ?? "survey").Trim().ToLowerInvariant();
            double angle = Parameters.Value<double?>("angle_deg") ?? Math.Atan2(matrix[1, 0], matrix[0, 0]) * 180 / Math.PI;
            if (which == "base")
            {
                BasePoint bp = BasePoint.GetProjectBasePoint(doc);
                HoldBack(doc, bp, "project base", skipped, out bool blocked);
                if (blocked) return;
                Transform shared = SharedOf(doc);
                XYZ target = shared.Inverse.OfPoint(new XYZ(Ft(matrix[0, 3]), Ft(matrix[1, 3]), Ft(matrix[2, 3])));
                XYZ move = target - bp.Position;
                bool clipped = bp.LookupParameter("Clipped")?.AsInteger() == 1;
                would.Add(new JObject { ["target"] = "base", ["delta_mm"] = Math.Round(move.GetLength() * FtToMm, 3), ["clipped"] = clipped, ["id"] = bp.Id.Value });
                if (!write) return;
                if (move.GetLength() > 1e-9) ElementTransformUtils.MoveElement(doc, bp.Id, move);
                applied.Add(new JObject { ["target"] = "base", ["id"] = bp.Id.Value, ["clipped"] = clipped });
                return;
            }
            BasePoint survey = BasePoint.GetSurveyPoint(doc);
            HoldBack(doc, survey, "survey", skipped, out bool held);
            if (held) return;
            ProjectPosition now = doc.ActiveProjectLocation.GetProjectPosition(XYZ.Zero);
            double dx = matrix[0, 3] - now.EastWest * FtToMm;
            double dy = matrix[1, 3] - now.NorthSouth * FtToMm;
            double dz = matrix[2, 3] - now.Elevation * FtToMm;
            double dAng = angle - now.Angle * 180 / Math.PI;
            while (dAng > 180) dAng -= 360;
            while (dAng <= -180) dAng += 360;
            would.Add(new JObject { ["target"] = "survey", ["delta_mm"] = Math.Round(Math.Sqrt(dx * dx + dy * dy + dz * dz), 3), ["delta_deg"] = Math.Round(Math.Abs(dAng), 6), ["id"] = survey.Id.Value });
            if (!write) return;
            // The shared position of the internal origin. Not AcquireCoordinates.
            doc.ActiveProjectLocation.SetProjectPosition(XYZ.Zero, new ProjectPosition(Ft(matrix[0, 3]), Ft(matrix[1, 3]), Ft(matrix[2, 3]), angle * Math.PI / 180));
            applied.Add(new JObject { ["target"] = "survey", ["id"] = survey.Id.Value });
        }

        private void AlignObjects(Document doc, bool write, JArray would, JArray skipped, JArray applied)
        {
            Transform shared = SharedOf(doc);
            foreach (JObject row in (Parameters["elements"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string key = row.Value<string>("stable_id") ?? row.Value<string>("id") ?? "";
                Element e = Find(doc, row.Value<string>("id") ?? "") ?? Find(doc, key);
                if (e == null) { skipped.Add(new JObject { ["id"] = key, ["code"] = "FMC-COORD-MISSING" }); continue; }
                HoldBack(doc, e, e.Name, skipped, out bool blocked);
                if (blocked) continue;
                if (!TryMatrix(row["transform"], out double[,] matrix)) { skipped.Add(new JObject { ["id"] = e.Id.Value, ["code"] = "FMC-COORD-MATRIX" }); continue; }
                Transform current = LocalOf(e);
                Transform target = shared.Inverse.Multiply(FromMatrix(matrix));
                XYZ move = target.Origin - current.Origin;
                double dAng = AngleOf(target) - AngleOf(current);
                while (dAng > Math.PI) dAng -= 2 * Math.PI;
                while (dAng < -Math.PI) dAng += 2 * Math.PI;
                var item = new JObject { ["id"] = e.Id.Value, ["stable_id"] = key, ["delta_mm"] = Math.Round(move.GetLength() * FtToMm, 3), ["delta_deg"] = Math.Round(Math.Abs(dAng) * 180 / Math.PI, 6) };
                would.Add(item);
                if (!write) continue;
                try
                {
                    if (move.GetLength() > 1e-9) ElementTransformUtils.MoveElement(doc, e.Id, move);
                    if (Math.Abs(dAng) > 1e-9)
                    {
                        XYZ at = target.Origin;
                        ElementTransformUtils.RotateElement(doc, e.Id, Line.CreateBound(at, at + XYZ.BasisZ), dAng);
                    }
                    applied.Add(new JObject { ["id"] = e.Id.Value, ["stable_id"] = key });
                }
                catch (Exception ex)
                {
                    skipped.Add(new JObject { ["id"] = e.Id.Value, ["code"] = "FMC-COORD-MOVE", ["error"] = ex.Message });
                }
            }
        }

        private JObject Place(Document doc, bool write)
        {
            if (!TryMatrix(Parameters["transform"], out double[,] matrix))
                throw new InvalidOperationException("[FMC-COORD-MATRIX] place needs a 4x4 transform.");
            bool reference = Parameters.Value<bool?>("reference_point") == true;
            Transform shared = SharedOf(doc);
            Transform target = shared.Inverse.Multiply(FromMatrix(matrix));
            XYZ at = target.Origin;
            double ang = AngleOf(target);
            if (reference)
            {
                if (!doc.IsFamilyDocument)
                    return new JObject { ["ok"] = false, ["code"] = "FMC-COORD-REFPOINT", ["error"] = "A reference point is placed in a family or a mass, not in a project model." };
                if (!write) return new JObject { ["ok"] = true, ["would"] = new JArray { new JObject { ["reference_point"] = true, ["xyz_mm"] = new JArray { Mm(at.X), Mm(at.Y), Mm(at.Z) } } } };
                try
                {
                    using (var t = new Transaction(doc, "Formcraft: coord place"))
                    {
                        t.Start();
                        // FamilyItemFactory. NewReferencePoint exists for a conceptual mass. There is no project-document Create.
                        ReferencePoint point = doc.FamilyCreate.NewReferencePoint(target);
                        t.Commit();
                        return new JObject { ["ok"] = true, ["placed"] = new JArray { new JObject { ["id"] = point.Id.Value, ["unique_id"] = point.UniqueId, ["reference_point"] = true } } };
                    }
                }
                catch (Exception ex)
                {
                    return new JObject { ["ok"] = false, ["code"] = "FMC-COORD-REFPOINT", ["error"] = "A reference point needs a conceptual mass family. " + ex.Message };
                }
            }
            string family = Parameters.Value<string>("family") ?? "";
            string typeName = Parameters.Value<string>("type_name") ?? "";
            FamilySymbol sym = FindSymbol(doc, family, typeName, out string symbolError);
            if (sym == null) return new JObject { ["ok"] = false, ["code"] = "FMC-COORD-FAMILY", ["error"] = symbolError };
            Level storey = doc.IsFamilyDocument ? null : FindLevel(doc, Parameters.Value<string>("storey") ?? "");
            if (!doc.IsFamilyDocument && storey == null)
                return new JObject { ["ok"] = false, ["code"] = "FMC-COORD-LEVEL", ["error"] = "No level named '" + (Parameters.Value<string>("storey") ?? "") + "'." };
            if (!write)
                return new JObject { ["ok"] = true, ["would"] = new JArray { new JObject { ["family"] = sym.FamilyName, ["type"] = sym.Name, ["level"] = storey?.Name ?? "", ["angle_deg"] = Math.Round(ang * 180 / Math.PI, 6) } } };
            using (var t = new Transaction(doc, "Formcraft: coord place"))
            {
                t.Start();
                if (!sym.IsActive) sym.Activate();
                FamilyInstance fi = doc.IsFamilyDocument
                    ? doc.FamilyCreate.NewFamilyInstance(at, sym, StructuralType.NonStructural)
                    : doc.Create.NewFamilyInstance(at, sym, storey, StructuralType.NonStructural);
                doc.Regenerate();
                if (fi.Location is LocationPoint lp)
                {
                    XYZ delta = at - lp.Point;
                    if (delta.GetLength() > 1e-6) ElementTransformUtils.MoveElement(doc, fi.Id, delta);
                }
                if (Math.Abs(ang) > 1e-9) ElementTransformUtils.RotateElement(doc, fi.Id, Line.CreateBound(at, at + XYZ.BasisZ), ang);
                t.Commit();
                return new JObject { ["ok"] = true, ["placed"] = new JArray { new JObject { ["id"] = fi.Id.Value, ["unique_id"] = fi.UniqueId, ["family"] = sym.FamilyName, ["type"] = sym.Name } } };
            }
        }

        private static void HoldBack(Document doc, Element e, string name, JArray skipped, out bool blocked)
        {
            blocked = false;
            if (e == null) return;
            if (e.Pinned)
            {
                skipped.Add(new JObject { ["id"] = e.Id.Value, ["name"] = name, ["code"] = "FMC-COORD-PINNED" });
                blocked = true;
                return;
            }
            JObject hold = FmcCheckout.Hold(doc, e.Id);
            if (hold != null)
            {
                hold["name"] = name;
                skipped.Add(hold);
                blocked = true;
            }
        }

        private static JObject ModelOf(Document doc, Transform shared)
        {
            double trueNorth = 0;
            try { trueNorth = doc.ActiveProjectLocation.GetProjectPosition(XYZ.Zero).Angle * 180 / Math.PI; } catch { trueNorth = 0; }
            JObject survey = Marker(doc, true, "survey");
            JObject basis = Marker(doc, false, "project base");
            double datum = 0;
            try { datum = Mm(ParamFeet(BasePoint.GetSurveyPoint(doc), BuiltInParameter.BASEPOINT_ELEVATION_PARAM)); } catch { datum = 0; }
            return new JObject
            {
                ["internal_to_shared"] = MatrixMm(shared),
                ["angle_deg"] = Math.Round(trueNorth, 6),
                ["true_north_angle_deg"] = Math.Round(trueNorth, 6),
                ["elevation_datum_mm"] = datum,
                ["survey_point"] = survey,
                ["project_base_point"] = basis,
                ["shared_origin"] = PointEntry("shared origin", "survey", XYZ.Zero, 0, ""),
            };
        }

        private static JObject Marker(Document doc, bool survey, string name)
        {
            try
            {
                BasePoint bp = survey ? BasePoint.GetSurveyPoint(doc) : BasePoint.GetProjectBasePoint(doc);
                double east = ParamFeet(bp, BuiltInParameter.BASEPOINT_EASTWEST_PARAM);
                double north = ParamFeet(bp, BuiltInParameter.BASEPOINT_NORTHSOUTH_PARAM);
                double elev = ParamFeet(bp, BuiltInParameter.BASEPOINT_ELEVATION_PARAM);
                Parameter ang = bp.get_Parameter(BuiltInParameter.BASEPOINT_ANGLETON_PARAM);
                double deg = ang != null && ang.StorageType == StorageType.Double ? ang.AsDouble() * 180 / Math.PI : 0;
                JObject row = PointEntry(name, "survey", new XYZ(east, north, elev), deg, bp.Id.Value.ToString());
                row["pinned"] = bp.Pinned;
                return row;
            }
            catch (Exception ex)
            {
                JObject row = PointEntry(name, "survey", XYZ.Zero, 0, "");
                row["note"] = ex.Message;
                return row;
            }
        }

        private static void Grids(Document doc, Transform shared, JArray points)
        {
            List<Grid> grids;
            try { grids = new FilteredElementCollector(doc).OfClass(typeof(Grid)).Cast<Grid>().Where(g => g.Curve != null).Take(60).ToList(); }
            catch { return; }
            int count = 0;
            for (int i = 0; i < grids.Count; i++)
            {
                for (int j = i + 1; j < grids.Count && count < 400; j++)
                {
                    try
                    {
                        SetComparisonResult hit = grids[i].Curve.Intersect(grids[j].Curve, out IntersectionResultArray results);
                        if (hit != SetComparisonResult.Overlap || results == null || results.Size == 0) continue;
                        XYZ sharedPoint = shared.OfPoint(results.get_Item(0).XYZPoint);
                        points.Add(PointEntry(grids[i].Name + "/" + grids[j].Name, "grid", sharedPoint, 0, grids[i].Id.Value + "/" + grids[j].Id.Value));
                        count++;
                    }
                    catch { /* a grid without a usable curve is skipped */ }
                }
            }
        }

        private void ObjectsOf(Document doc, Transform shared, JArray objects, JArray notes)
        {
            var ids = (Parameters["ids"] as JArray ?? new JArray()).Select(t => t.ToString()).Where(s => s.Length > 0).ToList();
            string category = Parameters.Value<string>("category") ?? "";
            string filter = Parameters.Value<string>("filter") ?? "";
            if (ids.Count == 0 && category.Length == 0 && filter.Length == 0)
            {
                notes.Add("Pass ids, category or filter to publish objects.");
                return;
            }
            IEnumerable<Element> source;
            if (ids.Count > 0) source = ids.Select(id => Find(doc, id)).Where(e => e != null);
            else if (category.StartsWith("OST_", StringComparison.OrdinalIgnoreCase) && Enum.TryParse(category, true, out BuiltInCategory bic))
                source = new FilteredElementCollector(doc).OfCategory(bic).WhereElementIsNotElementType();
            else source = new FilteredElementCollector(doc).WhereElementIsNotElementType();
            int kept = 0;
            int seen = 0;
            bool truncated = false;
            foreach (Element e in source)
            {
                if (e?.Category == null) continue;
                seen++;
                if (seen > 20000) { truncated = true; break; }
                if (category.Length > 0 && !CategoryIs(e, category)) continue;
                if (!TextHit(e, filter)) continue;
                if (kept >= 200) { truncated = true; break; }
                objects.Add(ObjectOf(e, shared));
                kept++;
            }
            if (truncated) notes.Add("Object list truncated at 200 summaries.");
        }

        private static JObject ObjectOf(Element e, Transform shared)
        {
            string mark = e.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString() ?? "";
            string stable = string.IsNullOrEmpty(mark) ? e.UniqueId : e.UniqueId + "|" + mark;
            Transform local = LocalOf(e);
            Transform pose = shared.Multiply(local);
            double rotation = 0;
            string location = "none";
            if (e.Location is LocationPoint lp) { rotation = lp.Rotation * 180 / Math.PI; location = "point"; }
            else if (e.Location is LocationCurve) location = "curve";
            return new JObject
            {
                ["id"] = e.Id.Value, ["unique_id"] = e.UniqueId, ["stable_id"] = stable, ["mark"] = mark,
                ["name"] = e.Name ?? "", ["category"] = e.Category?.Name ?? "", ["location"] = location,
                ["pinned"] = e.Pinned, ["rotation_deg"] = Math.Round(rotation, 6), ["level_offset_mm"] = OffsetMm(e),
                ["transform"] = MatrixMm(pose), ["angle_deg"] = Math.Round(AngleOf(pose) * 180 / Math.PI, 6),
                ["xyz_mm"] = new JArray { Mm(pose.Origin.X), Mm(pose.Origin.Y), Mm(pose.Origin.Z) },
            };
        }

        private void FamilyOf(Document doc, JArray families, JArray notes)
        {
            if (doc.IsFamilyDocument)
            {
                var planes = new JArray();
                foreach (ReferencePlane plane in new FilteredElementCollector(doc).OfClass(typeof(ReferencePlane)).Cast<ReferencePlane>())
                {
                    XYZ mid = (plane.BubbleEnd + plane.FreeEnd) * 0.5;
                    planes.Add(new JObject
                    {
                        ["name"] = plane.Name ?? "",
                        ["origin_mm"] = new JArray { Mm(mid.X), Mm(mid.Y), Mm(mid.Z) },
                        ["normal"] = new JArray { plane.Normal.X, plane.Normal.Y, plane.Normal.Z },
                    });
                }
                families.Add(new JObject
                {
                    ["name"] = doc.Title, ["stable_id"] = doc.Title, ["id"] = doc.OwnerFamily?.Id.Value,
                    ["insertion_mm"] = new JArray { 0, 0, 0 }, ["origin_mm"] = new JArray { 0, 0, 0 },
                    ["transform"] = MatrixMm(Transform.Identity), ["angle_deg"] = 0, ["reference_planes"] = planes,
                });
                return;
            }
            string wanted = (Parameters.Value<string>("family") ?? "").Trim();
            if (wanted.Length == 0)
            {
                notes.Add("Open the family document to read its reference planes, or pass family.");
                return;
            }
            Family fam = new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>().FirstOrDefault(f => string.Equals(f.Name, wanted, StringComparison.OrdinalIgnoreCase));
            if (fam == null) { notes.Add("No family " + wanted); return; }
            families.Add(new JObject
            {
                ["name"] = fam.Name, ["stable_id"] = fam.UniqueId, ["id"] = fam.Id.Value,
                ["insertion_mm"] = new JArray { 0, 0, 0 }, ["origin_mm"] = new JArray { 0, 0, 0 },
                ["transform"] = MatrixMm(Transform.Identity), ["angle_deg"] = 0, ["reference_planes"] = new JArray(),
                ["note"] = "Reference planes are read when this family document is open.",
            });
        }

        private static FamilySymbol FindSymbol(Document doc, string family, string typeName, out string error)
        {
            var hits = new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>()
                .Where(s => (family.Length == 0 || string.Equals(s.FamilyName, family, StringComparison.OrdinalIgnoreCase))
                    && (typeName.Length == 0 || string.Equals(s.Name, typeName, StringComparison.OrdinalIgnoreCase)))
                .Take(8).ToList();
            if (hits.Count == 0) { error = "No loaded type for family '" + family + "'."; return null; }
            if (hits.Count > 1 && typeName.Length == 0)
            {
                error = "Family '" + family + "' has more than one type (" + string.Join(", ", hits.Select(s => s.Name)) + "). Pass type_name.";
                return null;
            }
            error = "";
            return hits[0];
        }

        private static Level FindLevel(Document doc, string name)
        {
            var levels = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => l.Elevation).ToList();
            if (levels.Count == 0) return null;
            if (!string.IsNullOrWhiteSpace(name)) return levels.FirstOrDefault(l => string.Equals(l.Name, name, StringComparison.OrdinalIgnoreCase));
            return levels[0];
        }

        private static bool CategoryIs(Element e, string category)
        {
            if (e?.Category == null) return false;
            if (string.Equals(e.Category.Name, category, StringComparison.OrdinalIgnoreCase)) return true;
            if (category.StartsWith("OST_", StringComparison.OrdinalIgnoreCase) && Enum.TryParse(category, true, out BuiltInCategory bic))
                return e.Category.Id.Value == (long)bic;
            return e.Category.Name.IndexOf(category, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static bool TextHit(Element e, string filter)
        {
            if (string.IsNullOrWhiteSpace(filter)) return true;
            string mark = e.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString() ?? "";
            return (e.Name ?? "").IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0
                || mark.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0
                || (e.UniqueId ?? "").IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static Element Find(Document doc, string key)
        {
            if (string.IsNullOrWhiteSpace(key)) return null;
            if (long.TryParse(key, out long id) && id != 0)
            {
                Element byId = doc.GetElement(new ElementId(id));
                if (byId != null) return byId;
            }
            try { return doc.GetElement(key); } catch { return null; }
        }

        private static XYZ PointOf(Element e)
        {
            if (e.Location is LocationPoint lp) return lp.Point;
            if (e.Location is LocationCurve lc && lc.Curve != null) return lc.Curve.GetEndPoint(0);
            BoundingBoxXYZ box = e.get_BoundingBox(null);
            return box == null ? XYZ.Zero : (box.Min + box.Max) * 0.5;
        }

        private static Transform LocalOf(Element e)
        {
            if (e is Instance inst)
            {
                try { return inst.GetTransform(); } catch (Exception) { /* a view-specific instance keeps the location below */ }
            }
            if (e.Location is LocationPoint lp)
            {
                Transform t = Transform.CreateRotation(XYZ.BasisZ, lp.Rotation);
                t.Origin = lp.Point;
                return t;
            }
            if (e.Location is LocationCurve lc && lc.Curve != null)
            {
                XYZ start = lc.Curve.GetEndPoint(0);
                XYZ dir = lc.Curve.GetEndPoint(1) - start;
                Transform t = Transform.CreateRotation(XYZ.BasisZ, Math.Atan2(dir.Y, dir.X));
                t.Origin = start;
                return t;
            }
            Transform idn = Transform.Identity;
            idn.Origin = PointOf(e);
            return idn;
        }

        private static Transform SharedOf(Document doc)
        {
            try
            {
                ProjectLocation loc = doc.ActiveProjectLocation;
                ProjectPosition o = loc.GetProjectPosition(XYZ.Zero);
                ProjectPosition x = loc.GetProjectPosition(new XYZ(1, 0, 0));
                ProjectPosition y = loc.GetProjectPosition(new XYZ(0, 1, 0));
                ProjectPosition z = loc.GetProjectPosition(new XYZ(0, 0, 1));
                Transform t = Transform.Identity;
                t.BasisX = new XYZ(x.EastWest - o.EastWest, x.NorthSouth - o.NorthSouth, x.Elevation - o.Elevation);
                t.BasisY = new XYZ(y.EastWest - o.EastWest, y.NorthSouth - o.NorthSouth, y.Elevation - o.Elevation);
                t.BasisZ = new XYZ(z.EastWest - o.EastWest, z.NorthSouth - o.NorthSouth, z.Elevation - o.Elevation);
                t.Origin = new XYZ(o.EastWest, o.NorthSouth, o.Elevation);
                return t;
            }
            catch { return Transform.Identity; }
        }

        private static XYZ SharedPoint(Transform shared, XYZ internalFeet) => shared.OfPoint(internalFeet);

        private static JArray MatrixMm(Transform t)
        {
            return new JArray
            {
                new JArray { Round9(t.BasisX.X), Round9(t.BasisY.X), Round9(t.BasisZ.X), Mm(t.Origin.X) },
                new JArray { Round9(t.BasisX.Y), Round9(t.BasisY.Y), Round9(t.BasisZ.Y), Mm(t.Origin.Y) },
                new JArray { Round9(t.BasisX.Z), Round9(t.BasisY.Z), Round9(t.BasisZ.Z), Mm(t.Origin.Z) },
                new JArray { 0d, 0d, 0d, 1d },
            };
        }

        private static JObject PointEntry(string name, string kind, XYZ sharedFeet, double angleDeg, string id)
        {
            Transform t = Transform.CreateRotation(XYZ.BasisZ, angleDeg * Math.PI / 180);
            t.Origin = sharedFeet;
            return new JObject
            {
                ["name"] = name ?? "", ["kind"] = kind, ["id"] = id ?? "",
                ["xyz_mm"] = new JArray { Mm(sharedFeet.X), Mm(sharedFeet.Y), Mm(sharedFeet.Z) },
                ["transform"] = MatrixMm(t), ["angle_deg"] = Math.Round(angleDeg, 6),
            };
        }

        private static Transform FromMatrix(double[,] m)
        {
            Transform t = Transform.Identity;
            t.BasisX = new XYZ(m[0, 0], m[1, 0], m[2, 0]);
            t.BasisY = new XYZ(m[0, 1], m[1, 1], m[2, 1]);
            t.BasisZ = new XYZ(m[0, 2], m[1, 2], m[2, 2]);
            t.Origin = new XYZ(Ft(m[0, 3]), Ft(m[1, 3]), Ft(m[2, 3]));
            return t;
        }

        private static bool TryMatrix(JToken token, out double[,] m)
        {
            m = new double[4, 4];
            if (token is not JArray rows || rows.Count != 4) return false;
            for (int r = 0; r < 4; r++)
            {
                if (rows[r] is not JArray cols || cols.Count != 4) return false;
                for (int c = 0; c < 4; c++)
                {
                    if (cols[c].Type == JTokenType.Null) return false;
                    m[r, c] = cols[c].Value<double>();
                }
            }
            return true;
        }

        private static double OffsetMm(Element e)
        {
            Parameter p = e.get_Parameter(BuiltInParameter.INSTANCE_FREE_HOST_OFFSET_PARAM) ?? e.get_Parameter(BuiltInParameter.INSTANCE_ELEVATION_PARAM);
            return p != null && p.StorageType == StorageType.Double ? Mm(p.AsDouble()) : 0;
        }

        private static double ParamFeet(Element e, BuiltInParameter p)
        {
            Parameter par = e?.get_Parameter(p);
            return par != null && par.StorageType == StorageType.Double ? par.AsDouble() : 0;
        }

        private static double AngleOf(Transform t) => Math.Atan2(t.BasisX.Y, t.BasisX.X);
        private static double Mm(double feet) => Math.Round(feet * FtToMm, 3);
        private static double Ft(double mm) => mm / FtToMm;
        private static double Round9(double n) => Math.Round(n, 9);
    }
}
