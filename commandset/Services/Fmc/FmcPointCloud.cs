using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_pointcloud_read (point cloud against model, L011-F25): each element of the named categories as a triangle
    /// mesh in metres, in shared or internal coordinates, plus the point clouds already linked in the model. Read-only:
    /// no transaction, nothing saved. The server reads the E57 or LAS file and measures the deviation.
    /// </summary>
    public class FmcPointCloudHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double M = 0.3048;
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft point cloud read";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_pointcloud needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    bool shared = !string.Equals(Parameters.Value<string>("coordinates") ?? "shared", "internal", StringComparison.OrdinalIgnoreCase);
                    Transform toOut = shared ? SharedTransform(doc) : Transform.Identity;
                    List<string> categories = FmcPhaseIds.Strings(Parameters["categories"] as JArray);
                    List<long> ids = FmcPhaseIds.Longs(Parameters["element_ids"] as JArray);
                    int maxTris = Math.Max(1000, Math.Min(2000000, Parameters.Value<int?>("max_triangles") ?? 300000));
                    int perElement = Math.Max(12, Math.Min(200000, Parameters.Value<int?>("max_triangles_per_element") ?? 20000));
                    var unknown = new JArray();
                    var elements = new JArray();
                    int total = 0;
                    bool truncated = false;
                    var skipped = new JObject();
                    foreach (Element e in Collect(doc, categories, ids, unknown))
                    {
                        if (total >= maxTris) { truncated = true; break; }
                        JObject row = MeshOf(doc, e, toOut, Math.Min(perElement, maxTris - total), out int tris, out bool cut);
                        if (row == null) { string c = e.Category?.Name ?? "?"; skipped[c] = (skipped.Value<int?>(c) ?? 0) + 1; continue; }
                        if (cut) row["mesh_cut"] = true;
                        total += tris;
                        elements.Add(row);
                    }
                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["title"] = doc.Title ?? "",
                        ["path"] = doc.PathName ?? "",
                        ["units"] = "m",
                        ["coordinates"] = shared ? "shared" : "internal",
                        ["shared_transform"] = shared ? TransformJson(toOut) : null,
                        ["elements"] = elements,
                        ["triangles"] = total,
                        ["truncated"] = truncated,
                        ["no_geometry"] = skipped,
                        ["unknown_categories"] = unknown,
                        ["point_clouds"] = LinkedClouds(doc, toOut),
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        /// <summary>
        /// Internal (feet) to shared (feet), built from GetProjectPosition at the origin and at the three unit points
        /// (GetProjectPosition gives a point's shared E/N/elevation, as fmc_north reads it), so the direction of
        /// ProjectLocation.GetTotalTransform is never guessed.
        /// </summary>
        private static Transform SharedTransform(Document doc)
        {
            ProjectLocation loc = doc.ActiveProjectLocation;
            if (loc == null) return Transform.Identity;
            XYZ At(XYZ p)
            {
                ProjectPosition pos = loc.GetProjectPosition(p);
                return new XYZ(pos.EastWest, pos.NorthSouth, pos.Elevation);
            }
            XYZ o = At(XYZ.Zero);
            const double L = 100.0;
            Transform t = Transform.Identity;
            t.Origin = o;
            t.BasisX = (At(new XYZ(L, 0, 0)) - o) / L;
            t.BasisY = (At(new XYZ(0, L, 0)) - o) / L;
            t.BasisZ = (At(new XYZ(0, 0, L)) - o) / L;
            return t;
        }

        private static JObject TransformJson(Transform t)
        {
            JArray V(XYZ p, double s) => new JArray(Math.Round(p.X * s, 6), Math.Round(p.Y * s, 6), Math.Round(p.Z * s, 6));
            return new JObject { ["origin_m"] = V(t.Origin, M), ["basis_x"] = V(t.BasisX, 1), ["basis_y"] = V(t.BasisY, 1), ["basis_z"] = V(t.BasisZ, 1) };
        }

        private static IEnumerable<Element> Collect(Document doc, List<string> categories, List<long> ids, JArray unknown)
        {
            if (ids.Count > 0)
            {
                foreach (long id in ids)
                {
                    Element e = doc.GetElement(new ElementId(id));
                    if (e != null && !(e is ElementType)) yield return e;
                }
                yield break;
            }
            foreach (string name in categories)
            {
                if (!Enum.TryParse(name, true, out BuiltInCategory bic)) { unknown.Add(name); continue; }
                IList<Element> found;
                try { found = new FilteredElementCollector(doc).OfCategory(bic).WhereElementIsNotElementType().ToElements(); }
                catch (Exception) { unknown.Add(name); continue; }
                foreach (Element e in found) if (e != null && !e.ViewSpecific) yield return e;
            }
        }

        private static JObject MeshOf(Document doc, Element e, Transform toOut, int budget, out int tris, out bool cut)
        {
            tris = 0;
            cut = false;
            GeometryElement geo;
            try { geo = e.get_Geometry(new Options { DetailLevel = ViewDetailLevel.Medium, ComputeReferences = false, IncludeNonVisibleObjects = false }); }
            catch (Exception) { return null; }
            if (geo == null) return null;
            var verts = new JArray();
            var idx = new JArray();
            var map = new Dictionary<string, int>();
            int count = 0;
            bool full = false;
            void AddMesh(Mesh mesh)
            {
                if (mesh == null || full) return;
                for (int i = 0; i < mesh.NumTriangles; i++)
                {
                    if (count >= budget) { full = true; return; }
                    MeshTriangle tri = mesh.get_Triangle(i);
                    for (int k = 0; k < 3; k++) idx.Add(Vertex(tri.get_Vertex(k)));
                    count++;
                }
            }
            int Vertex(XYZ p)
            {
                XYZ q = toOut.OfPoint(p);
                double x = Math.Round(q.X * M, 4), y = Math.Round(q.Y * M, 4), z = Math.Round(q.Z * M, 4);
                string k = x + "," + y + "," + z;
                if (map.TryGetValue(k, out int at)) return at;
                at = verts.Count / 3;
                verts.Add(x); verts.Add(y); verts.Add(z);
                map[k] = at;
                return at;
            }
            void Walk(GeometryElement g)
            {
                foreach (GeometryObject obj in g)
                {
                    if (full) return;
                    switch (obj)
                    {
                        case Solid s when s.Volume > 1e-9 || s.Faces.Size > 0:
                            foreach (Face f in s.Faces)
                            {
                                if (full) return;
                                Mesh m;
                                try { m = f.Triangulate(0.3); } catch (Exception) { continue; }
                                AddMesh(m);
                            }
                            break;
                        case Mesh m:
                            AddMesh(m);
                            break;
                        case GeometryInstance gi:
                            GeometryElement inner = gi.GetInstanceGeometry();
                            if (inner != null) Walk(inner);
                            break;
                    }
                }
            }
            Walk(geo);
            cut = full;
            if (count == 0) return null;
            tris = count;
            Element type = doc.GetElement(e.GetTypeId());
            string level = "";
            if (e.LevelId != null && e.LevelId != ElementId.InvalidElementId) level = doc.GetElement(e.LevelId)?.Name ?? "";
            return new JObject
            {
                ["id"] = e.Id.Value.ToString(),
                ["unique_id"] = e.UniqueId ?? "",
                ["category"] = e.Category?.Name ?? "",
                ["name"] = ((type as ElementType)?.FamilyName ?? "") + (type != null ? ": " + type.Name : ""),
                ["level"] = level,
                ["v"] = verts,
                ["t"] = idx,
            };
        }

        private static JArray LinkedClouds(Document doc, Transform toOut)
        {
            var rows = new JArray();
            foreach (PointCloudInstance pc in new FilteredElementCollector(doc).OfClass(typeof(PointCloudInstance)).Cast<PointCloudInstance>())
            {
                var type = doc.GetElement(pc.GetTypeId()) as PointCloudType;
                Transform t = toOut.Multiply(pc.GetTransform());
                rows.Add(new JObject
                {
                    ["id"] = pc.Id.Value.ToString(),
                    ["name"] = pc.Name ?? "",
                    ["type"] = type?.Name ?? "",
                    ["transform"] = TransformJson(t),
                });
            }
            return rows;
        }
    }
}
