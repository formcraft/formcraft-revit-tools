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
    /// Workshare (U20) on the Revit main thread. facts reads whether the model is workshared, its central model (and
    /// whether a file-based central is reachable), the user worksets with their owners, the user and the warnings count;
    /// create makes user worksets. Neither synchronises nor saves: a person syncs in Revit (CLAUDE.md rule 6).
    /// </summary>
    public class FmcWorkshareEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public string Action { get; set; } = "";
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return FmcBusy.Wait(_resetEvent, timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using var target = FmcTarget.Resolve(app, Parameters, mayOpen: Action == "facts");
                Document doc = target.Doc;
                if (doc.IsFamilyDocument) throw new InvalidOperationException("Worksharing is for project models.");
                switch (Action)
                {
                    case "facts": Result = Facts(app, doc); break;
                    case "create": Result = Create(doc); break;
                    default: Error = $"Unknown FMC workshare action '{Action}'"; break;
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

        public string GetName() => "FMC workshare";

        private static JObject Facts(UIApplication app, Document doc)
        {
            string central = "";
            bool cloud = false;
            bool? reachable = null;
            var worksets = new JArray();
            if (doc.IsWorkshared)
            {
                try
                {
                    ModelPath path = doc.GetWorksharingCentralModelPath();
                    cloud = path != null && path.CloudPath;
                    central = path == null ? "" : ModelPathUtils.ConvertModelPathToUserVisiblePath(path);
                    if (!cloud && central.Length > 0) reachable = File.Exists(central);
                }
                catch (Exception) { /* no central path: the preflight says so */ }
                foreach (Workset w in new FilteredWorksetCollector(doc).OfKind(WorksetKind.UserWorkset))
                    worksets.Add(new JObject
                    {
                        ["id"] = w.Id.IntegerValue, ["name"] = w.Name, ["owner"] = w.Owner ?? "", ["open"] = w.IsOpen,
                        ["editable"] = w.IsEditable, ["default_visible"] = w.IsVisibleByDefault,
                    });
            }
            string title = doc.Title.EndsWith(".rvt", StringComparison.OrdinalIgnoreCase) ? doc.Title : doc.Title + ".rvt";
            return new JObject
            {
                ["model"] = title, ["workshared"] = doc.IsWorkshared, ["central"] = central, ["cloud"] = cloud,
                ["central_reachable"] = reachable.HasValue ? (JToken)reachable.Value : JValue.CreateNull(),
                ["user"] = app.Application.Username ?? "", ["warnings"] = doc.GetWarnings().Count, ["worksets"] = worksets,
            };
        }

        private JObject Create(Document doc)
        {
            if (!doc.IsWorkshared) throw new InvalidOperationException("This model isn't workshared.");
            var existing = new HashSet<string>(new FilteredWorksetCollector(doc).OfKind(WorksetKind.UserWorkset).Select(w => w.Name), StringComparer.OrdinalIgnoreCase);
            var done = new JArray();
            using (var t = new Transaction(doc, "Formcraft: worksets"))
            {
                t.Start();
                foreach (JToken n in Parameters["names"] as JArray ?? new JArray())
                {
                    string name = n.ToString();
                    if (existing.Contains(name)) { done.Add(new JObject { ["name"] = name, ["result"] = "exists" }); continue; }
                    if (!WorksetTable.IsWorksetNameUnique(doc, name)) { done.Add(new JObject { ["name"] = name, ["result"] = "name in use" }); continue; }
                    Workset.Create(doc, name);
                    existing.Add(name);
                    done.Add(new JObject { ["name"] = name, ["result"] = "created" });
                }
                t.Commit();
            }
            return new JObject { ["worksets"] = done };
        }
    }
}
