using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_warnings: every warning Revit holds for the document, one row each, with the failure definition id (a GUID, the
    /// same for the same kind of warning in every model), the severity, the sentence, and for the failing elements their
    /// level, workset and owner (the person who has the element checked out; the creator too when include_creator is true).
    /// READ ONLY: no transaction, nothing is changed, no warning is ever deleted. The triage and the trend
    /// by failure id, level, workset and owner are done in the server (server/src/fmc/warnings.ts) so they can be tested
    /// without Revit. Anything that could not be read is counted in read_problems, never dropped silently.
    /// </summary>
    public class FmcWarningsHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft warnings";

        private const int ElementsPerWarning = 25;

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                    Result = Read(target.Doc);
            }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        private JObject Read(Document doc)
        {
            int maxRows = Math.Max(1, Math.Min(Parameters.Value<int?>("max_rows") ?? 10000, 50000));
            bool creator = Parameters.Value<bool?>("include_creator") ?? false;
            bool shared = doc.IsWorkshared;
            IList<FailureMessage> all = doc.GetWarnings();
            var levelNames = new Dictionary<long, string>();
            var worksetNames = new Dictionary<int, string>();
            var info = new Dictionary<long, JObject>();
            int unreadElements = 0, noFailureId = 0;

            string LevelName(Element e)
            {
                ElementId id = e.LevelId;
                if (id == null || id == ElementId.InvalidElementId)
                    id = e.get_Parameter(BuiltInParameter.FAMILY_LEVEL_PARAM)?.AsElementId() ?? e.get_Parameter(BuiltInParameter.SCHEDULE_LEVEL_PARAM)?.AsElementId();
                if (id == null || id == ElementId.InvalidElementId) return "";
                if (!levelNames.TryGetValue(id.Value, out string name))
                    levelNames[id.Value] = name = (doc.GetElement(id) as Level)?.Name ?? "";
                return name;
            }

            string WorksetName(Element e)
            {
                if (!shared || e.WorksetId == WorksetId.InvalidWorksetId) return "";
                if (!worksetNames.TryGetValue(e.WorksetId.IntegerValue, out string name))
                    worksetNames[e.WorksetId.IntegerValue] = name = doc.GetWorksetTable().GetWorkset(e.WorksetId)?.Name ?? "";
                return name;
            }

            JObject Describe(ElementId id, string role)
            {
                long key = id.Value;
                if (!info.TryGetValue(key, out JObject row))
                {
                    row = new JObject { ["id"] = key };
                    try
                    {
                        Element e = doc.GetElement(id);
                        if (e == null) { row["missing"] = true; unreadElements++; }
                        else
                        {
                            row["category"] = e.Category?.Name ?? "";
                            row["level"] = LevelName(e);
                            row["workset"] = WorksetName(e);
                            row["owner"] = shared ? (e.get_Parameter(BuiltInParameter.EDITED_BY)?.AsString() ?? "") : "";
                            if (creator && shared)
                            {
                                try { row["creator"] = WorksharingUtils.GetWorksharingTooltipInfo(doc, id)?.Creator ?? ""; }
                                catch (Exception) { row["creator"] = ""; unreadElements++; }
                            }
                        }
                    }
                    catch (Exception) { row["unread"] = true; unreadElements++; }
                    info[key] = row;
                }
                var copy = (JObject)row.DeepClone();
                copy["role"] = role;
                return copy;
            }

            var rows = new JArray();
            foreach (FailureMessage w in all.Take(maxRows))
            {
                string failureId;
                try { failureId = w.GetFailureDefinitionId().Guid.ToString(); }
                catch (Exception) { failureId = "unknown"; noFailureId++; }
                var failing = w.GetFailingElements() ?? new List<ElementId>();
                var extra = (w.GetAdditionalElements() ?? new List<ElementId>()).Where(x => !failing.Contains(x)).ToList();
                var elements = new JArray(failing.Take(ElementsPerWarning).Select(x => Describe(x, "failing")));
                foreach (ElementId x in extra.Take(Math.Max(0, ElementsPerWarning - failing.Count))) elements.Add(Describe(x, "additional"));
                string severity;
                try { severity = w.GetSeverity().ToString(); } catch (Exception) { severity = "Warning"; }
                rows.Add(new JObject
                {
                    ["failure_id"] = failureId, ["severity"] = severity, ["description"] = w.GetDescriptionText() ?? "",
                    ["element_count"] = failing.Count + extra.Count, ["elements"] = elements,
                });
            }
            return new JObject
            {
                ["title"] = doc.Title, ["path"] = doc.PathName ?? "", ["is_workshared"] = shared,
                ["read_only"] = true, ["total"] = all.Count, ["returned"] = rows.Count, ["truncated"] = all.Count > rows.Count,
                ["read_problems"] = new JObject { ["elements_unread"] = unreadElements, ["failure_id_missing"] = noFailureId },
                ["warnings"] = rows,
            };
        }
    }
}