using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Links (U20) on the Revit main thread. facts reads the shared position of the project origin, the site, FMC_CRS,
    /// every Revit link and the worksets; add links models by shared coordinates (never moving coordinates); pin pins
    /// links. The server checks paths (02_Shared only) and sends add and pin through the live-model lock.
    /// </summary>
    public class FmcLinkEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double FeetToMm = 304.8;
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public string Action { get; set; } = "";
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                Document doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("Open a model first.");
                if (doc.IsFamilyDocument) throw new InvalidOperationException("Links live in a project model.");
                switch (Action)
                {
                    case "facts": Result = Facts(doc); break;
                    case "add": Result = Add(doc); break;
                    case "pin": Result = Pin(doc); break;
                    default: Error = $"Unknown FMC link action '{Action}'"; break;
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

        public string GetName() => "FMC links";

        private static JObject Facts(Document doc)
        {
            ProjectLocation loc = doc.ActiveProjectLocation;
            ProjectPosition pos = loc.GetProjectPosition(XYZ.Zero);
            var coords = new JObject
            {
                ["site"] = loc.Name,
                ["easting_mm"] = Math.Round(pos.EastWest * FeetToMm),
                ["northing_mm"] = Math.Round(pos.NorthSouth * FeetToMm),
                ["elevation_mm"] = Math.Round(pos.Elevation * FeetToMm),
                ["angle_deg"] = Math.Round(pos.Angle * 180 / Math.PI, 2),
                ["crs"] = doc.ProjectInformation?.LookupParameter("FMC_CRS")?.AsString() ?? "",
            };
            var worksets = doc.IsWorkshared
                ? new FilteredWorksetCollector(doc).OfKind(WorksetKind.UserWorkset).Select(w => w.Name).ToList()
                : new List<string>();
            var links = new JArray();
            foreach (RevitLinkInstance inst in new FilteredElementCollector(doc).OfClass(typeof(RevitLinkInstance)).Cast<RevitLinkInstance>())
            {
                var type = doc.GetElement(inst.GetTypeId()) as RevitLinkType;
                string path = "", pathType = "";
                try
                {
                    ExternalFileReference r = type?.GetExternalFileReference();
                    if (r != null)
                    {
                        path = ModelPathUtils.ConvertModelPathToUserVisiblePath(r.GetAbsolutePath());
                        pathType = r.PathType.ToString();
                    }
                }
                catch { /* a link without a file reference keeps empty values */ }
                links.Add(new JObject
                {
                    ["id"] = inst.Id.Value, ["name"] = type?.Name ?? inst.Name, ["path"] = path, ["path_type"] = pathType,
                    ["attachment"] = type?.AttachmentType.ToString() ?? "", ["loaded"] = type != null && RevitLinkType.IsLoaded(doc, type.Id),
                    ["pinned"] = inst.Pinned,
                    ["workset"] = doc.IsWorkshared ? doc.GetWorksetTable().GetWorkset(inst.WorksetId)?.Name ?? "" : "",
                });
            }
            return new JObject { ["model"] = doc.Title + (doc.Title.EndsWith(".rvt", StringComparison.OrdinalIgnoreCase) ? "" : ".rvt"),
                ["workshared"] = doc.IsWorkshared, ["coordinates"] = coords, ["links"] = links, ["worksets"] = new JArray(worksets) };
        }

        private JObject Add(Document doc)
        {
            bool pin = Parameters.Value<bool?>("pin") != false;
            var worksets = doc.IsWorkshared ? new FilteredWorksetCollector(doc).OfKind(WorksetKind.UserWorkset).ToDictionary(w => w.Name, w => w.Id) : new Dictionary<string, WorksetId>();
            var done = new JArray();
            foreach (JObject m in (Parameters["models"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string path = m.Value<string>("path") ?? "", wanted = m.Value<string>("workset") ?? "";
                var result = new JObject { ["name"] = Path.GetFileName(path) };
                using (var t = new Transaction(doc, "Formcraft: link " + Path.GetFileName(path)))
                {
                    t.Start();
                    try
                    {
                        LinkLoadResult load = RevitLinkType.Create(doc, ModelPathUtils.ConvertUserVisiblePathToModelPath(path), new RevitLinkOptions(true));
                        if (load.ElementId == ElementId.InvalidElementId) throw new InvalidOperationException(load.LoadResult.ToString());
                        var type = (RevitLinkType)doc.GetElement(load.ElementId);
                        type.AttachmentType = AttachmentType.Overlay;
                        RevitLinkInstance inst = RevitLinkInstance.Create(doc, load.ElementId, ImportPlacement.Shared);
                        string ws = "";
                        if (worksets.TryGetValue(wanted, out WorksetId id))
                        {
                            inst.get_Parameter(BuiltInParameter.ELEM_PARTITION_PARAM)?.Set(id.IntegerValue);
                            ws = wanted;
                        }
                        if (pin) inst.Pinned = true;
                        t.Commit();
                        result["result"] = "linked by shared coordinates" + (pin ? ", pinned" : "") + (ws.Length > 0 ? ", on " + ws : doc.IsWorkshared ? ", workset " + wanted + " missing" : "");
                    }
                    catch (Exception e)
                    {
                        if (t.HasStarted() && !t.HasEnded()) t.RollBack();
                        result["result"] = "not linked: " + e.Message + (e.Message.IndexOf("shared", StringComparison.OrdinalIgnoreCase) >= 0 ? "" : " (the models may not share coordinates yet)");
                    }
                }
                done.Add(result);
            }
            return new JObject { ["models"] = done };
        }

        private JObject Pin(Document doc)
        {
            int pinned = 0;
            using (var t = new Transaction(doc, "Formcraft: pin links"))
            {
                t.Start();
                foreach (JToken id in Parameters["element_ids"] as JArray ?? new JArray())
                    if (doc.GetElement(new ElementId(id.Value<long>())) is RevitLinkInstance inst && !inst.Pinned) { inst.Pinned = true; pinned++; }
                t.Commit();
            }
            return new JObject { ["pinned"] = pinned };
        }
    }
}
