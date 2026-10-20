using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using Rhino.FileIO;
using Rhino.Geometry;

namespace Formcraft.Rhino
{
    /// <summary>
    /// The bridge's named operations. A family's parts live in the bridge's memory (one set per family) and go to disk
    /// only as files under a _Rhino staging folder; the server decides every path and checks it against the write rules
    /// before it asks, and the bridge refuses any other path as a second lock.
    /// </summary>
    public static class RhinoCommands
    {
        private static readonly Dictionary<string, Dictionary<string, Part>> Docs = new Dictionary<string, Dictionary<string, Part>>(StringComparer.OrdinalIgnoreCase);
        private const string Key = "fmc.";

        public static JObject Run(string method, JObject p)
        {
            switch (method)
            {
                case "rhino_status": return Status();
                case "rhino_describe": return Describe(p);
                case "rhino_new_doc": return NewDoc(p);
                case "rhino_open": return Open(p);
                case "rhino_save": return Save(p);
                case "rhino_part": return PartOp(p);
                case "rhino_remove": return Remove(p);
                case "rhino_facts": return FactsOf(p);
                case "rhino_render": return Render(p);
                case "rhino_export_parts": return ExportParts(p);
                // X1, one selection: RhinoSelection.cs (the open drawing's selection and view, on Rhino's window thread)
                case "rhino_select": return RhinoSelection.Select(p);
                case "rhino_selection": return RhinoSelection.Selection(p);
                default: throw new ArgumentException("Unknown method " + method);
            }
        }

        static JObject Status()
        {
            bool licensed = false; string expires = "";
            try { licensed = global::Rhino.RhinoApp.IsLicenseValidated; expires = global::Rhino.RhinoApp.LicenseExpires ? "expires" : "doesn't expire"; } catch (Exception) { /* older Rhino */ }
            return new JObject
            {
                ["rhino"] = global::Rhino.RhinoApp.Version.ToString(),
                ["bridge"] = typeof(RhinoCommands).Assembly.GetName().Version.ToString(),
                ["licence_validated"] = licensed,
                ["licence"] = expires,
                ["note"] = "The bridge builds in its own memory, never in the open drawing, and writes files with openNURBS",
                ["families"] = new JArray(Docs.Select(d => new JObject { ["family"] = d.Key, ["parts"] = d.Value.Count })),
                ["operations"] = new JArray(RhinoParts.Ops),
            };
        }

        static Dictionary<string, Part> Doc(JObject p, bool create = false)
        {
            string fam = p.Value<string>("family") ?? throw new ArgumentException("family is required");
            if (Docs.TryGetValue(fam, out var d)) return d;
            if (!create) throw new ArgumentException($"No parts for {fam} in this Rhino: new_doc or open it first");
            return Docs[fam] = new Dictionary<string, Part>(StringComparer.Ordinal);
        }

        static JObject Describe(JObject p)
        {
            var d = Doc(p);
            return new JObject { ["family"] = p["family"], ["parts"] = new JArray(d.Values.Select(x => new JObject { ["name"] = x.Name, ["op"] = x.Op, ["subcategory"] = x.Subcategory, ["material"] = x.Material, ["visibility"] = x.Visibility, ["spec"] = x.Spec })) };
        }

        static JObject NewDoc(JObject p)
        {
            string fam = p.Value<string>("family") ?? throw new ArgumentException("family is required");
            if (Docs.TryGetValue(fam, out var had) && had.Count > 0 && p.Value<bool?>("replace") != true)
                throw new ArgumentException($"{fam} already has {had.Count} parts in this Rhino: save it, or pass replace");
            Docs[fam] = new Dictionary<string, Part>(StringComparer.Ordinal);
            return new JObject { ["family"] = fam, ["parts"] = 0, ["units"] = "millimetres", ["tolerance_mm"] = RhinoParts.Tol };
        }

        /// <summary>Builds the parts in order, all or none: one bad part leaves the family as it was.</summary>
        static JObject PartOp(JObject p)
        {
            var d = Doc(p, create: true);
            var specs = p["parts"] as JArray ?? throw new ArgumentException("parts is required: [{ name, op, … }]");
            var work = new Dictionary<string, Part>(d, StringComparer.Ordinal);
            var built = new JArray();
            foreach (JObject s in specs)
            {
                var consumed = new List<string>();
                Part part = RhinoParts.Build(s, work, consumed);
                foreach (string c in consumed) work.Remove(c);
                work[part.Name] = part;
                built.Add(new JObject { ["name"] = part.Name, ["op"] = part.Op, ["replaces"] = new JArray(consumed.Where(c => c != part.Name)) });
            }
            d.Clear();
            foreach (var kv in work) d[kv.Key] = kv.Value;
            return new JObject { ["family"] = p["family"], ["built"] = built, ["facts"] = new JArray(d.Values.Select(Facts)) };
        }

        static JObject Remove(JObject p)
        {
            var d = Doc(p);
            var names = (p["names"] as JArray ?? new JArray()).Select(t => (string)t).ToList();
            var missing = names.Where(n => !d.ContainsKey(n)).ToList();
            if (missing.Count > 0) throw new ArgumentException("No parts named " + string.Join(", ", missing));
            foreach (string n in names) d.Remove(n);
            return new JObject { ["family"] = p["family"], ["removed"] = new JArray(names), ["parts"] = d.Count };
        }

        static JObject FactsOf(JObject p)
        {
            var d = Doc(p);
            return new JObject { ["family"] = p["family"], ["facts"] = new JArray(d.Values.Select(Facts)) };
        }

        /// <summary>What the server's check rules read: closed, manifold, valid, the shortest edge, the size, the weight.</summary>
        public static JObject Facts(Part x)
        {
            Brep b = x.Brep;
            double minEdge = double.MaxValue;
            foreach (BrepEdge e in b.Edges) { double l = e.GetLength(); if (l < minEdge) minEdge = l; }
            BoundingBox bb = b.GetBoundingBox(true);
            int meshFaces = 0;
            try { foreach (Mesh m in Mesh.CreateFromBrep(b, MeshingParameters.Default) ?? new Mesh[0]) meshFaces += m.Faces.Count; } catch (Exception) { /* reported as 0 */ }
            double volume = 0;
            try { if (b.IsSolid) volume = b.GetVolume(); } catch (Exception) { /* reported as 0 */ }
            return new JObject
            {
                ["name"] = x.Name, ["op"] = x.Op, ["subcategory"] = x.Subcategory, ["material"] = x.Material, ["visibility"] = x.Visibility,
                ["closed"] = b.IsSolid, ["manifold"] = b.IsManifold, ["valid"] = b.IsValid,
                ["faces"] = b.Faces.Count, ["edges"] = b.Edges.Count,
                ["min_edge_mm"] = b.Edges.Count == 0 ? 0 : Math.Round(minEdge, 3),
                ["bbox_min"] = new JArray(R(bb.Min.X), R(bb.Min.Y), R(bb.Min.Z)), ["bbox_max"] = new JArray(R(bb.Max.X), R(bb.Max.Y), R(bb.Max.Z)),
                ["volume_mm3"] = Math.Round(volume, 1), ["mesh_faces"] = meshFaces,
            };
        }

        static double R(double v) => Math.Round(v, 2);

        // ---- files: openNURBS only, under _Rhino --------------------------------------------------------------------------

        static string PathIn(JObject p, string key, params string[] ext)
        {
            string path = p.Value<string>(key) ?? throw new ArgumentException(key + " is required");
            string full = Path.GetFullPath(path);
            if (full.IndexOf(@"\_Rhino\", StringComparison.OrdinalIgnoreCase) < 0)
                throw new ArgumentException($"The bridge reads and writes only under a _Rhino staging folder, not {full}");
            if (ext.Length > 0 && !ext.Any(e => full.EndsWith(e, StringComparison.OrdinalIgnoreCase)))
                throw new ArgumentException($"{full} must be a {string.Join(" or ", ext)} file");
            return full;
        }

        static File3dm NewFile()
        {
            var f = new File3dm();
            f.Settings.ModelUnitSystem = global::Rhino.UnitSystem.Millimeters;
            f.Settings.ModelAbsoluteTolerance = RhinoParts.Tol;
            f.Settings.ModelAngleToleranceRadians = RhinoParts.AngTol;
            return f;
        }

        static void AddPart(File3dm f, Part x, string family)
        {
            int layer = f.AllLayers.AddLayer(x.Name, RhinoRender.ColourOf(x.Material));
            var l = f.AllLayers.FindIndex(layer);
            l.SetUserString(Key + "subcategory", x.Subcategory);
            l.SetUserString(Key + "material", x.Material);
            l.SetUserString(Key + "visibility", x.Visibility);
            l.SetUserString(Key + "op", x.Op);
            l.SetUserString(Key + "family", family);
            l.SetUserString(Key + "spec", x.Spec?.ToString(Newtonsoft.Json.Formatting.None) ?? "");
            var a = new global::Rhino.DocObjects.ObjectAttributes { LayerIndex = layer, Name = x.Name };
            f.Objects.AddBrep(x.Brep, a);
        }

        static void Write(File3dm f, string path)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            string tmp = path + ".tmp";
            if (!f.Write(tmp, 8)) throw new IOException("openNURBS couldn't write " + path);
            if (File.Exists(path)) File.Delete(path);
            File.Move(tmp, path);
        }

        static JObject Save(JObject p)
        {
            var d = Doc(p);
            string path = PathIn(p, "path", ".3dm");
            var f = NewFile();
            foreach (Part x in d.Values) AddPart(f, x, p.Value<string>("family"));
            Write(f, path);
            return new JObject { ["family"] = p["family"], ["saved"] = path, ["parts"] = d.Count, ["bytes"] = new FileInfo(path).Length };
        }

        static JObject Open(JObject p)
        {
            string path = PathIn(p, "path", ".3dm");
            if (!File.Exists(path)) throw new FileNotFoundException("No file at " + path);
            string fam = p.Value<string>("family") ?? Path.GetFileNameWithoutExtension(path);
            var d = new Dictionary<string, Part>(StringComparer.Ordinal);
            File3dm f = File3dm.Read(path) ?? throw new IOException("openNURBS couldn't read " + path);
            var skipped = new JArray();
            foreach (File3dmObject o in f.Objects)
            {
                Brep b = o.Geometry as Brep ?? (o.Geometry as Extrusion)?.ToBrep();
                var layer = f.AllLayers.FindIndex(o.Attributes.LayerIndex);
                string name = string.IsNullOrEmpty(o.Attributes.Name) ? layer?.Name : o.Attributes.Name;
                if (b == null || string.IsNullOrEmpty(name)) { skipped.Add(o.Attributes.Name ?? o.Geometry?.ObjectType.ToString()); continue; }
                string spec = layer?.GetUserString(Key + "spec");
                d[name] = new Part
                {
                    Name = name, Brep = b,
                    Op = layer?.GetUserString(Key + "op") ?? "imported",
                    Subcategory = layer?.GetUserString(Key + "subcategory") ?? "",
                    Material = layer?.GetUserString(Key + "material") ?? "",
                    Visibility = layer?.GetUserString(Key + "visibility") is string v && v.Length > 0 ? v : "fine",
                    Spec = string.IsNullOrEmpty(spec) ? null : JObject.Parse(spec),
                };
            }
            if (Docs.TryGetValue(fam, out var had) && had.Count > 0 && p.Value<bool?>("replace") != true)
                throw new ArgumentException($"{fam} already has {had.Count} parts in this Rhino: pass replace to read the file over them");
            Docs[fam] = d;
            return new JObject { ["family"] = fam, ["opened"] = path, ["parts"] = d.Count, ["skipped"] = skipped };
        }

        /// <summary>Each part as its own .3dm (one layer, one closed solid, its user text): what Revit's ShapeImporter reads.</summary>
        static JObject ExportParts(JObject p)
        {
            var d = Doc(p);
            string folder = p.Value<string>("folder") ?? throw new ArgumentException("folder is required");
            if (Path.GetFullPath(folder).IndexOf(@"\_Rhino\", StringComparison.OrdinalIgnoreCase) < 0)
                throw new ArgumentException("The bridge writes only under a _Rhino staging folder");
            var only = (p["parts"] as JArray)?.Select(t => (string)t).ToList();
            var outList = new JArray();
            foreach (Part x in d.Values.Where(v => only == null || only.Contains(v.Name)))
            {
                string path = Path.Combine(Path.GetFullPath(folder), x.Name + ".3dm");
                var f = NewFile();
                AddPart(f, x, p.Value<string>("family"));
                Write(f, path);
                JObject facts = Facts(x);
                facts["file"] = path;
                facts["bytes"] = new FileInfo(path).Length;
                outList.Add(facts);
            }
            return new JObject { ["family"] = p["family"], ["folder"] = Path.GetFullPath(folder), ["parts"] = outList };
        }

        static JObject Render(JObject p)
        {
            var d = Doc(p);
            string path = PathIn(p, "path", ".png");
            var only = (p["parts"] as JArray)?.Select(t => (string)t).ToList();
            var parts = d.Values.Where(v => only == null || only.Contains(v.Name)).ToList();
            if (parts.Count == 0) throw new ArgumentException("Nothing to render");
            int w = p.Value<int?>("width") ?? 1600, h = p.Value<int?>("height") ?? 1200;
            string view = p.Value<string>("view") ?? "iso";
            // owner 20 Oct: "camera" matches a reference photo's viewpoint (the likeness check): the direction from the
            // product towards the camera, [x, y, z] (e.g. [-0.55, -1, 0.25] low from the front left)
            Vector3d? eye = null;
            if (p["camera"] is JArray c)
            {
                if (c.Count != 3) throw new ArgumentException("camera is [x, y, z]: the direction from the product towards the camera");
                eye = new Vector3d((double)c[0], (double)c[1], (double)c[2]);
                view = "camera";
            }
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            RhinoRender.ToPng(parts, path, w, h, view, eye);
            return new JObject { ["family"] = p["family"], ["rendered"] = path, ["parts"] = parts.Count, ["width"] = w, ["height"] = h, ["view"] = view, ["bytes"] = new FileInfo(path).Length };
        }
    }
}
