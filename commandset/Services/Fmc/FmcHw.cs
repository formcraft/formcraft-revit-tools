using System.IO;
using System.Reflection;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Reads graphics settings and a short memory summary, and closes spare views.
    /// Nothing here puts the model, a regeneration, or a transaction on the GPU.
    /// </summary>
    public class FmcHwHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        private static readonly List<byte[]> ImageBuffers = new List<byte[]>();

        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _done.Reset();
            return RevitMCPCommandSet.FmcBusy.Wait(_done, timeoutMilliseconds);
        }

        public string GetName() => "Formcraft hardware";

        /// <summary>Plugin-side image bytes. ExportImage does not keep a bitmap here. The PNG on disk is left alone.</summary>
        internal static void HoldImage(byte[] bytes)
        {
            if (bytes != null) ImageBuffers.Add(bytes);
        }

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string action = (Parameters.Value<string>("action") ?? "graphics").Trim().ToLowerInvariant();
                if (action == "free") Result = Free(app);
                else if (action == "sample") Result = Sample();
                else Result = Report(app, action);
            }
            catch (Exception ex)
            {
                Error = ex.Message;
            }
            finally
            {
                _done.Set();
            }
        }

        private JObject Report(UIApplication app, string action)
        {
            var root = new JObject
            {
                ["action"] = action,
                ["graphics"] = Graphics(app),
                ["api_graphics"] = ApiGraphics(app),
                ["honesty"] = Honesty(),
            };
            if (action == "memory" || action == "scan" || action == "graphics") root["documents"] = Documents(app);
            return root;
        }

        private static JArray Honesty()
        {
            return new JArray(
                "Revit's model database stays in system RAM.",
                "Regeneration, transactions and the Revit API run on the CPU.",
                "Video memory holds drawn views. It cannot replace system RAM.");
        }

        private static JObject Graphics(UIApplication app)
        {
            string version = app?.Application?.VersionNumber ?? "2025";
            string ini = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Autodesk", "Revit", "Autodesk Revit " + version, "Revit.ini");
            var reading = new JObject
            {
                ["source"] = ini,
                ["found"] = File.Exists(ini),
                ["use_hardware_acceleration"] = null,
                ["antialiasing"] = null,
                ["optimize_view_navigation"] = null,
                ["disable_optimized_view_navigation"] = null,
                ["view_hardware_note"] = "View drawing follows UseHardwareAcceleration. This add-in does not invent a separate view key and does not write Revit.ini.",
            };
            if (!File.Exists(ini)) return reading;
            string section = "";
            foreach (string raw in File.ReadAllLines(ini))
            {
                string line = raw.Trim();
                if (line.StartsWith("[") && line.EndsWith("]")) { section = line.Substring(1, line.Length - 2); continue; }
                int eq = line.IndexOf('=');
                if (eq <= 0 || section.Length == 0) continue;
                string key = line.Substring(0, eq).Trim();
                string value = line.Substring(eq + 1).Trim();
                if (key.Equals("UseHardwareAcceleration", StringComparison.OrdinalIgnoreCase)) reading["use_hardware_acceleration"] = value;
                else if (key.Equals("Antialiasing", StringComparison.OrdinalIgnoreCase)) reading["antialiasing"] = value;
                else if (key.Equals("OptimizeViewNavigation", StringComparison.OrdinalIgnoreCase)) reading["optimize_view_navigation"] = value;
                else if (key.Equals("DisableOptimizedViewNavigation", StringComparison.OrdinalIgnoreCase)) reading["disable_optimized_view_navigation"] = value;
            }
            return reading;
        }

        private static JArray ApiGraphics(UIApplication app)
        {
            var found = new JArray();
            if (app?.Application == null) return found;
            foreach (PropertyInfo property in app.Application.GetType().GetProperties())
            {
                string name = property.Name ?? "";
                if (name.IndexOf("Hardware", StringComparison.OrdinalIgnoreCase) < 0 && name.IndexOf("Graphics", StringComparison.OrdinalIgnoreCase) < 0) continue;
                string value = "";
                try { value = Convert.ToString(property.GetValue(app.Application)) ?? ""; }
                catch (Exception ex) { value = ex.GetType().Name; }
                found.Add(new JObject { ["name"] = name, ["value"] = value });
            }
            if (found.Count == 0) found.Add(new JObject { ["name"] = "", ["value"] = "The Revit API exposes no hardware-acceleration property on Application. Revit.ini is the source." });
            return found;
        }

        private static JArray Documents(UIApplication app)
        {
            var rows = new JArray();
            Document active = app.ActiveUIDocument?.Document;
            foreach (Document doc in app.Application.Documents)
            {
                if (doc == null || doc.IsLinked) continue;
                var views = new JArray();
                try
                {
                    UIDocument ui = active != null && doc.Equals(active) ? app.ActiveUIDocument : new UIDocument(doc);
                    foreach (UIView open in ui.GetOpenUIViews())
                    {
                        View view = doc.GetElement(open.ViewId) as View;
                        bool isActive = false;
                        try { isActive = doc.ActiveView != null && doc.ActiveView.Id.Equals(open.ViewId); } catch (Exception) { isActive = false; }
                        views.Add(new JObject
                        {
                            ["id"] = open.ViewId.Value.ToString(),
                            ["name"] = view?.Name ?? "",
                            ["active"] = isActive,
                            ["pinned"] = view != null && view.Pinned,
                        });
                    }
                }
                catch (Exception ex)
                {
                    views.Add(new JObject { ["id"] = "", ["name"] = "", ["active"] = false, ["pinned"] = false, ["error"] = ex.Message });
                }
                int elements = 0;
                int links = 0;
                int images = 0;
                try { elements = new FilteredElementCollector(doc).WhereElementIsNotElementType().GetElementCount(); } catch (Exception) { elements = 0; }
                try { links = new FilteredElementCollector(doc).OfClass(typeof(RevitLinkInstance)).GetElementCount(); } catch (Exception) { links = 0; }
                try { images = new FilteredElementCollector(doc).OfClass(typeof(ImageType)).GetElementCount(); } catch (Exception) { images = 0; }
                rows.Add(new JObject
                {
                    ["title"] = doc.Title ?? "",
                    ["path"] = doc.PathName ?? "",
                    ["active"] = active != null && doc.Equals(active),
                    ["person_working"] = active != null && doc.Equals(active),
                    ["family"] = doc.IsFamilyDocument,
                    ["workshared"] = doc.IsWorkshared,
                    ["read_only"] = doc.IsReadOnly,
                    ["elements"] = elements,
                    ["links"] = links,
                    ["images"] = images,
                    ["undo_depth"] = null,
                    ["undo_note"] = "The Revit API does not expose undo depth.",
                    ["open_views"] = views,
                });
            }
            return rows;
        }

        private JObject Free(UIApplication app)
        {
            bool dry = Parameters.Value<bool?>("dry_run") != false;
            bool pause = Parameters.Value<bool?>("memory_pause") == true;
            var wanted = new HashSet<string>(StringComparer.Ordinal);
            if (Parameters["close"] is JArray close)
            {
                foreach (JToken row in close)
                {
                    string id = row.Value<string>("view_id") ?? row.Value<string>("id") ?? "";
                    if (id.Length > 0) wanted.Add(id);
                }
            }
            var closed = new JArray();
            var skipped = new JArray();
            Document active = app.ActiveUIDocument?.Document;
            foreach (Document doc in app.Application.Documents)
            {
                if (doc == null || doc.IsLinked) continue;
                bool person = active != null && doc.Equals(active);
                if (person && !pause)
                {
                    skipped.Add(new JObject { ["document"] = doc.Title ?? "", ["reason"] = "A person is working in this document. Views stay open unless the memory pause is active." });
                    continue;
                }
                UIDocument ui;
                IList<UIView> open;
                try
                {
                    ui = person ? app.ActiveUIDocument : new UIDocument(doc);
                    open = ui.GetOpenUIViews();
                }
                catch (Exception ex)
                {
                    skipped.Add(new JObject { ["document"] = doc.Title ?? "", ["reason"] = ex.Message });
                    continue;
                }
                var closing = new List<UIView>();
                foreach (UIView view in open)
                {
                    string id = view.ViewId.Value.ToString();
                    if (!wanted.Contains(id)) continue;
                    View element = doc.GetElement(view.ViewId) as View;
                    bool isActive = false;
                    try { isActive = doc.ActiveView != null && doc.ActiveView.Id.Equals(view.ViewId); } catch (Exception) { isActive = false; }
                    if (isActive || (element != null && element.Pinned))
                    {
                        skipped.Add(new JObject { ["document"] = doc.Title ?? "", ["view"] = id, ["reason"] = "Active and pinned views stay open." });
                        continue;
                    }
                    closing.Add(view);
                }
                int left = open.Count;
                foreach (UIView view in closing)
                {
                    if (left <= 1)
                    {
                        skipped.Add(new JObject { ["document"] = doc.Title ?? "", ["reason"] = "The last open view is never closed." });
                        break;
                    }
                    if (!dry)
                    {
                        try { view.Close(); left--; closed.Add(new JObject { ["document"] = doc.Title ?? "", ["view_id"] = view.ViewId.Value.ToString() }); }
                        catch (Exception ex) { skipped.Add(new JObject { ["document"] = doc.Title ?? "", ["reason"] = ex.Message }); }
                    }
                    else
                    {
                        left--;
                        closed.Add(new JObject { ["document"] = doc.Title ?? "", ["view_id"] = view.ViewId.Value.ToString(), ["dry_run"] = true });
                    }
                }
            }
            int caches = 0;
            var saved = new JArray();
            if (!dry)
            {
                caches = ImageBuffers.Count;
                ImageBuffers.Clear();
                var allow = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                if (Parameters["saves"] is JArray saves)
                {
                    foreach (JToken token in saves) if (token.Type == JTokenType.String) allow.Add(token.Value<string>());
                }
                foreach (Document doc in app.Application.Documents)
                {
                    if (doc == null || doc.IsLinked || doc.IsReadOnly || string.IsNullOrEmpty(doc.PathName)) continue;
                    if (!allow.Contains(doc.PathName) && !allow.Contains(doc.Title ?? "")) continue;
                    try
                    {
                        doc.Save();
                        saved.Add(new JObject
                        {
                            ["document"] = doc.PathName,
                            ["undo_cleared"] = false,
                            ["note"] = "Revit keeps the undo list after a local save. This save was already due under the existing autosave. It was not an extra save, and it did not purge undo.",
                        });
                    }
                    catch (Exception ex)
                    {
                        skipped.Add(new JObject { ["document"] = doc.Title ?? "", ["reason"] = ex.Message });
                    }
                }
            }
            return new JObject
            {
                ["action"] = "free",
                ["dry_run"] = dry,
                ["closed"] = closed,
                ["skipped"] = skipped,
                ["plugin_caches_released"] = caches,
                ["image_caches_released"] = caches,
                ["image_note"] = "Exported PNGs in the image folder are kept. ExportImage does not leave a bitmap cache in this add-in.",
                ["saved"] = saved,
                ["honesty"] = Honesty(),
            };
        }

        private JObject Sample()
        {
            JArray boxes = Parameters["boxes"] as JArray ?? new JArray();
            JArray rays = Parameters["rays"] as JArray ?? new JArray();
            JArray clash = FmcHwKernels.Clash(boxes);
            int hits = FmcHwKernels.RayHits(rays, boxes);
            var payload = new JObject { ["boxes"] = boxes, ["rays"] = rays };
            return new JObject
            {
                ["clash"] = FmcHwGpuHost.Try("trace_clash", payload, clash),
                ["pressure_test"] = FmcHwGpuHost.Try("pressure_test", payload, hits),
                ["note"] = "fmc_joins pressure_test is not a Revit command. This sample did not read the open model. Element collection for fmc_trace stays on the API.",
                ["honesty"] = Honesty(),
            };
        }
    }
}
