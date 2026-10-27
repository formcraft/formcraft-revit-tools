using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// A 3D view as OBJ + MTL through Revit's CustomExporter (owner 27 Oct: Revit's FBX reaches Blender with no
    /// materials). Every face keeps its Revit material (usemtl, by a safe name that scene.json maps back to the Revit
    /// name, colour, transparency and class); one OBJ object per element ("Category_id"); metres, Z up, Revit's
    /// internal coordinates. detail 0-15 is Revit's tessellation (lower = fewer triangles). Self-contained (RevitAPI and
    /// Newtonsoft only) so a test can load it on its own.
    /// </summary>
    public static class FmcSceneObj
    {
        public static JObject Export(Document doc, View3D view, string folder, string name, int? detail)
        {
            Directory.CreateDirectory(folder);
            string obj = Path.Combine(folder, name + ".obj"), mtl = Path.Combine(folder, name + ".mtl");
            var t0 = DateTime.Now;
            JObject facts;
            using (var w = new StreamWriter(obj, false, new UTF8Encoding(false), 1 << 20))
            {
                w.WriteLine("# Formcraft scene export: " + doc.Title + " / " + view.Name);
                w.WriteLine("mtllib " + name + ".mtl");
                var ctx = new Context(doc, w, detail);
                var ex = new CustomExporter(doc, ctx) { IncludeGeometricObjects = false, ShouldStopOnError = false };
                ex.Export(view);
                facts = ctx.Facts();
                using (var m = new StreamWriter(mtl, false, new UTF8Encoding(false)))
                    foreach (var kv in ctx.Materials)
                    {
                        var c = kv.Value;
                        m.WriteLine("newmtl " + kv.Key);
                        m.WriteLine(string.Format(CultureInfo.InvariantCulture, "Kd {0:0.###} {1:0.###} {2:0.###}", c.R / 255.0, c.G / 255.0, c.B / 255.0));
                        m.WriteLine(string.Format(CultureInfo.InvariantCulture, "d {0:0.###}", 1 - c.Transparency));
                        m.WriteLine(string.Format(CultureInfo.InvariantCulture, "Ns {0:0}", c.Gloss * 1000));
                        m.WriteLine();
                    }
            }

            // the building's extent (walls, floors, roofs, columns, stairs) or the view's section box, for the camera
            XYZ lo, hi;
            if (view.IsSectionBoxActive) { var b = view.GetSectionBox(); lo = b.Transform.OfPoint(b.Min); hi = b.Transform.OfPoint(b.Max); }
            else
            {
                var cats = new[] { BuiltInCategory.OST_Walls, BuiltInCategory.OST_Floors, BuiltInCategory.OST_Roofs, BuiltInCategory.OST_Columns, BuiltInCategory.OST_StructuralColumns, BuiltInCategory.OST_Stairs };
                double x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
                foreach (Element e in new FilteredElementCollector(doc, view.Id).WhereElementIsNotElementType().WherePasses(new ElementMulticategoryFilter(cats)))
                {
                    var b = e.get_BoundingBox(null); if (b == null) continue;
                    x0 = Math.Min(x0, b.Min.X); y0 = Math.Min(y0, b.Min.Y); z0 = Math.Min(z0, b.Min.Z);
                    x1 = Math.Max(x1, b.Max.X); y1 = Math.Max(y1, b.Max.Y); z1 = Math.Max(z1, b.Max.Z);
                }
                if (x0 > x1) { x0 = y0 = z0 = 0; x1 = y1 = z1 = 30; }
                lo = new XYZ(x0, y0, z0); hi = new XYZ(x1, y1, z1);
            }
            JArray Mm(XYZ p) => new JArray(Math.Round(p.X * 304.8, 1), Math.Round(p.Y * 304.8, 1), Math.Round(p.Z * 304.8, 1));
            ViewOrientation3D o = view.GetOrientation();
            facts["model"] = doc.Title; facts["view"] = view.Name; facts["format"] = "obj"; facts["obj"] = obj;
            facts["export_s"] = Math.Round((DateTime.Now - t0).TotalSeconds, 1);
            facts["obj_mb"] = Math.Round(new FileInfo(obj).Length / 1048576.0, 1);
            facts["extent_mm"] = new JObject { ["min"] = Mm(new XYZ(Math.Min(lo.X, hi.X), Math.Min(lo.Y, hi.Y), Math.Min(lo.Z, hi.Z))), ["max"] = Mm(new XYZ(Math.Max(lo.X, hi.X), Math.Max(lo.Y, hi.Y), Math.Max(lo.Z, hi.Z))) };
            facts["section_box"] = view.IsSectionBoxActive;
            facts["camera"] = new JObject { ["eye_mm"] = Mm(o.EyePosition), ["forward"] = new JArray(o.ForwardDirection.X, o.ForwardDirection.Y, o.ForwardDirection.Z), ["up"] = new JArray(o.UpDirection.X, o.UpDirection.Y, o.UpDirection.Z), ["perspective"] = view.IsPerspective };
            File.WriteAllText(Path.Combine(folder, name + ".json"), facts.ToString());
            return facts;
        }

        internal sealed class Mat { public string Revit; public int R, G, B; public double Transparency, Gloss; public string Class, Category; }

        private sealed class Context : IExportContext
        {
            private readonly Document _doc;
            private readonly StreamWriter _w;
            private readonly int? _detail;
            private readonly Stack<Transform> _t = new Stack<Transform>();
            private readonly Stack<Document> _docs = new Stack<Document>();
            public readonly Dictionary<string, Mat> Materials = new Dictionary<string, Mat>();
            private string _mat = "", _written = "";
            private ElementId _element = ElementId.InvalidElementId;
            private bool _objectOpen;
            private long _vertices, _faces, _elements;
            private readonly CultureInfo _inv = CultureInfo.InvariantCulture;

            public Context(Document doc, StreamWriter w, int? detail) { _doc = doc; _w = w; _detail = detail; _t.Push(Transform.Identity); _docs.Push(doc); }

            public JObject Facts() => new JObject
            {
                ["elements"] = _elements, ["vertices"] = _vertices, ["triangles"] = _faces,
                ["materials"] = new JArray(Materials.Select(kv => new JObject
                {
                    ["obj_name"] = kv.Key, ["name"] = kv.Value.Revit, ["class"] = kv.Value.Class, ["category"] = kv.Value.Category,
                    ["color"] = new JArray(kv.Value.R, kv.Value.G, kv.Value.B), ["transparency"] = Math.Round(kv.Value.Transparency * 100), ["smoothness"] = Math.Round(kv.Value.Gloss * 100),
                })),
            };

            public bool Start() => true;
            public void Finish() { }
            public bool IsCanceled() => false;
            public RenderNodeAction OnViewBegin(ViewNode node) { if (_detail.HasValue) node.LevelOfDetail = Math.Max(0, Math.Min(15, _detail.Value)); return RenderNodeAction.Proceed; }
            public void OnViewEnd(ElementId elementId) { }
            public RenderNodeAction OnElementBegin(ElementId elementId) { _element = elementId; _objectOpen = false; return RenderNodeAction.Proceed; }
            public void OnElementEnd(ElementId elementId) { }
            public RenderNodeAction OnInstanceBegin(InstanceNode node) { _t.Push(_t.Peek().Multiply(node.GetTransform())); return RenderNodeAction.Proceed; }
            public void OnInstanceEnd(InstanceNode node) { _t.Pop(); }
            public RenderNodeAction OnLinkBegin(LinkNode node) { _t.Push(_t.Peek().Multiply(node.GetTransform())); _docs.Push(node.GetDocument() ?? _docs.Peek()); return RenderNodeAction.Proceed; }
            public void OnLinkEnd(LinkNode node) { _t.Pop(); _docs.Pop(); }
            public RenderNodeAction OnFaceBegin(FaceNode node) => RenderNodeAction.Proceed;
            public void OnFaceEnd(FaceNode node) { }
            public void OnRPC(RPCNode node) { }
            public void OnLight(LightNode node) { }

            private static string Safe(string s)
            {
                var b = new StringBuilder(s.Length);
                foreach (char c in s) b.Append(char.IsLetterOrDigit(c) || c == '-' ? c : '_');
                return b.ToString();
            }

            public void OnMaterial(MaterialNode node)
            {
                var m = _docs.Peek().GetElement(node.MaterialId) as Material;
                string revit = m?.Name ?? string.Format("Colour {0} {1} {2}", node.Color.Red, node.Color.Green, node.Color.Blue);
                string key = Safe(revit);
                if (!Materials.ContainsKey(key))
                    Materials[key] = new Mat
                    {
                        Revit = revit, R = node.Color.IsValid ? node.Color.Red : 200, G = node.Color.IsValid ? node.Color.Green : 200, B = node.Color.IsValid ? node.Color.Blue : 200,
                        Transparency = node.Transparency, Gloss = node.Smoothness / 100.0, Class = m?.MaterialClass ?? "", Category = m?.MaterialCategory ?? "",
                    };
                _mat = key;
            }

            public void OnPolymesh(PolymeshTopology node)
            {
                if (!_objectOpen)
                {
                    Element e = _docs.Peek().GetElement(_element);
                    _w.Write("o "); _w.Write(Safe((e?.Category?.Name ?? "Element") + "_" + _element.Value)); _w.Write('\n');
                    _objectOpen = true; _written = ""; _elements++;
                }
                if (_mat.Length == 0)
                {
                    _mat = "Default";
                    if (!Materials.ContainsKey(_mat)) Materials[_mat] = new Mat { Revit = "Default", R = 200, G = 200, B = 200, Class = "", Category = "" };
                }
                if (_mat != _written) { _w.Write("usemtl "); _w.Write(_mat); _w.Write('\n'); _written = _mat; }
                Transform t = _t.Peek();
                long first = _vertices + 1;
                foreach (XYZ p0 in node.GetPoints())
                {
                    XYZ p = t.OfPoint(p0);
                    _w.Write(string.Format(_inv, "v {0:0.####} {1:0.####} {2:0.####}\n", p.X * 0.3048, p.Y * 0.3048, p.Z * 0.3048));
                    _vertices++;
                }
                foreach (PolymeshFacet f in node.GetFacets())
                {
                    _w.Write(string.Format(_inv, "f {0} {1} {2}\n", first + f.V1, first + f.V2, first + f.V3));
                    _faces++;
                }
            }
        }
    }
}
