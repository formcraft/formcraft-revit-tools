using System;
using System.IO;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_scene_export (owner 27 Oct: Revit → Blender for renders): a 3D view as FBX (Revit's own exporter) plus
    /// &lt;name&gt;.json with what Blender needs: the materials (colour, transparency, shininess, class), the building's
    /// extent and the view's camera, in mm. folder is checked by the server (WIP only); the model is not changed.
    /// view: a 3D view's name or id; default {3D}, else the active 3D view. detail 0-15: fewer triangles when lower.
    /// </summary>
    public class FmcSceneExportHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft scene export";

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try { Result = Export(app.ActiveUIDocument ?? throw new InvalidOperationException("No model is open")); }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        private static JArray Mm(XYZ p) => new JArray(Math.Round(p.X * 304.8, 1), Math.Round(p.Y * 304.8, 1), Math.Round(p.Z * 304.8, 1));

        private JObject Export(UIDocument uidoc)
        {
            Document doc = uidoc.Document;
            string folder = Parameters.Value<string>("folder") ?? throw new InvalidOperationException("folder is needed");
            string name = Parameters.Value<string>("name") ?? "scene";
            if (!Path.IsPathRooted(folder)) throw new InvalidOperationException("folder must be absolute");
            string v = Parameters.Value<string>("view");
            View3D view = (v != null ? FmcViewImageHandler.ViewOf(doc, v) : null) as View3D
                ?? new FilteredElementCollector(doc).OfClass(typeof(View3D)).Cast<View3D>().FirstOrDefault(x => !x.IsTemplate && x.Name == "{3D}")
                ?? uidoc.ActiveView as View3D
                ?? throw new InvalidOperationException(v != null ? $"no 3D view {v}" : "no {3D} view: name a 3D view");
            if (view.IsTemplate) throw new InvalidOperationException($"{view.Name} is a template");

            Directory.CreateDirectory(folder);
            int? lod = Parameters["detail"] != null ? Parameters.Value<int>("detail") : (int?)null;
            // owner 27 Oct: OBJ by default; Revit's FBX reaches Blender with no materials (kept as format: "fbx")
            if ((Parameters.Value<string>("format") ?? "obj") == "obj")
            {
                JObject facts = FmcSceneObj.Export(doc, view, folder, name, lod);
                facts.Remove("materials");
                return facts;
            }
            var set = new ViewSet(); set.Insert(view);
            var t0 = DateTime.Now;
            // detail 0-15: Revit's FBX levels of detail (lower = fewer triangles; an aerial view needs far fewer than a close-up)
            var opt = new FBXExportOptions { WithoutBoundaryEdges = true, StopOnError = false };
            if (Parameters["detail"] != null) { opt.UseLevelsOfDetail = true; opt.LevelsOfDetailValue = Math.Max(0, Math.Min(15, Parameters.Value<int>("detail"))); }
            if (!doc.Export(folder, name, set, opt))
                throw new InvalidOperationException("Revit's FBX export failed");
            string fbx = Path.Combine(folder, name + ".fbx");

            BoundingBoxXYZ box = view.IsSectionBoxActive ? view.GetSectionBox() : FmcBox.Building(doc);
            XYZ lo = box.Transform.OfPoint(box.Min), hi = box.Transform.OfPoint(box.Max);
            ViewOrientation3D o = view.GetOrientation();
            var mats = new JArray(new FilteredElementCollector(doc).OfClass(typeof(Material)).Cast<Material>().Select(m => new JObject
            {
                ["name"] = m.Name, ["class"] = m.MaterialClass, ["category"] = m.MaterialCategory,
                ["color"] = m.Color.IsValid ? new JArray(m.Color.Red, m.Color.Green, m.Color.Blue) : null,
                ["transparency"] = m.Transparency, ["shininess"] = m.Shininess, ["smoothness"] = m.Smoothness,
            }));
            var info = new JObject
            {
                ["model"] = doc.Title, ["view"] = view.Name, ["fbx"] = fbx, ["export_s"] = Math.Round((DateTime.Now - t0).TotalSeconds, 1),
                ["extent_mm"] = new JObject { ["min"] = Mm(new XYZ(Math.Min(lo.X, hi.X), Math.Min(lo.Y, hi.Y), Math.Min(lo.Z, hi.Z))), ["max"] = Mm(new XYZ(Math.Max(lo.X, hi.X), Math.Max(lo.Y, hi.Y), Math.Max(lo.Z, hi.Z))) },
                ["section_box"] = view.IsSectionBoxActive,
                ["camera"] = new JObject { ["eye_mm"] = Mm(o.EyePosition), ["forward"] = new JArray(o.ForwardDirection.X, o.ForwardDirection.Y, o.ForwardDirection.Z), ["up"] = new JArray(o.UpDirection.X, o.UpDirection.Y, o.UpDirection.Z), ["perspective"] = view.IsPerspective },
                ["materials"] = mats,
            };
            File.WriteAllText(Path.Combine(folder, name + ".json"), info.ToString());
            info.Remove("materials");
            info["materials"] = mats.Count;
            info["fbx_mb"] = File.Exists(fbx) ? Math.Round(new FileInfo(fbx).Length / 1048576.0, 1) : 0;
            return info;
        }
    }
}
