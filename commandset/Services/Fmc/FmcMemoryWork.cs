using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Memory status, closing spare documents, and a PerformanceAdviser purge.
    /// There is no Revit 2025 API that clears the undo stack.
    /// </summary>
    public class FmcMemoryHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return RevitMCPCommandSet.FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft memory";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string action = (Parameters.Value<string>("action") ?? "status").Trim().ToLowerInvariant();
                if (action == "free") Result = Free(app);
                else if (action == "purge_unused") Result = Purge(app);
                else Result = Status(app);
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static JObject Status(UIApplication app)
        {
            var docs = new JArray();
            Document active = app.ActiveUIDocument?.Document;
            foreach (Document doc in app.Application.Documents)
            {
                if (doc.IsLinked) continue;
                docs.Add(new JObject
                {
                    ["title"] = doc.Title ?? "",
                    ["path"] = doc.PathName ?? "",
                    ["family"] = doc.IsFamilyDocument,
                    ["workshared"] = doc.IsWorkshared,
                    ["active"] = active != null && doc.Equals(active),
                    ["modified"] = doc.IsModified,
                });
            }
            long bytes = Process.GetCurrentProcess().WorkingSet64;
            return new JObject
            {
                ["read_only"] = true,
                ["revit_working_set_mb"] = Math.Round(bytes / 1048576.0, 1),
                ["documents"] = docs,
                ["api_limits"] = new JArray("Revit 2025 has no API to clear the undo stack."),
            };
        }

        private JObject Free(UIApplication app)
        {
            var wanted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (JToken token in Parameters["close"] as JArray ?? new JArray()) wanted.Add(token.ToString());
            var closed = new JArray();
            var kept = new JArray();
            var open = new List<Document>();
            foreach (Document doc in app.Application.Documents) if (!doc.IsLinked) open.Add(doc);
            Document active = app.ActiveUIDocument?.Document;
            int left = open.Count;
            foreach (Document doc in open.ToList())
            {
                string key = string.IsNullOrEmpty(doc.PathName) ? (doc.Title ?? "") : doc.PathName;
                string title = doc.Title ?? "";
                if (wanted.Count > 0 && !wanted.Contains(key) && !wanted.Contains(title)) { kept.Add(title + ": not in the plan"); continue; }
                if (doc.IsModified) { kept.Add(title + ": modified"); continue; }
                if (active != null && doc.Equals(active)) { kept.Add(title + ": active"); continue; }
                if (!doc.IsFamilyDocument && doc.IsWorkshared) { kept.Add(title + ": workshared"); continue; }
                if (left <= 1) { kept.Add(title + ": last document"); break; }
                doc.Close(false);
                closed.Add(title);
                left -= 1;
            }
            GC.Collect();
            GC.WaitForPendingFinalizers();
            long bytes = Process.GetCurrentProcess().WorkingSet64;
            return new JObject
            {
                ["closed"] = closed,
                ["kept"] = kept,
                ["revit_working_set_mb"] = Math.Round(bytes / 1048576.0, 1),
                ["api_limits"] = new JArray("Revit 2025 has no API to clear the undo stack. GC.Collect ran. The model was not saved."),
                ["saved"] = false,
            };
        }

        private JObject Purge(UIApplication app)
        {
            using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
            {
                Document doc = target.Doc;
                var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (JToken token in Parameters["categories"] as JArray ?? new JArray())
                {
                    string name = token?.ToString()?.Trim() ?? "";
                    if (name.Length > 0) names.Add(name);
                }
                PerformanceAdviser adviser = PerformanceAdviser.GetPerformanceAdviser();
                var rules = adviser.GetAllRuleIds().Where(id =>
                {
                    string name = adviser.GetRuleName(id) ?? "";
                    return name.IndexOf("unused", StringComparison.OrdinalIgnoreCase) >= 0
                        || name.IndexOf("purge", StringComparison.OrdinalIgnoreCase) >= 0;
                }).ToList();
                if (rules.Count == 0)
                {
                    return new JObject
                    {
                        ["purged"] = 0,
                        ["api_limits"] = new JArray("PerformanceAdviser has no unused or purge rule in this Revit session. Nothing was deleted."),
                        ["saved"] = false,
                    };
                }
                IList<FailureMessage> messages = adviser.ExecuteRules(doc, rules);
                var ids = new List<ElementId>();
                var seen = new HashSet<long>();
                foreach (FailureMessage message in messages)
                {
                    ICollection<ElementId> failing = message.GetFailingElements();
                    if (failing == null) continue;
                    foreach (ElementId id in failing)
                    {
                        if (!seen.Add(id.Value)) continue;
                        Element element = doc.GetElement(id);
                        if (element == null) continue;
                        string category = element.Category?.Name ?? "";
                        if (names.Count > 0 && !names.Contains(category)) continue;
                        ids.Add(id);
                    }
                }
                int deleted = 0;
                if (ids.Count > 0)
                {
                    using (var transaction = new Transaction(doc, "Formcraft purge unused"))
                    {
                        transaction.Start();
                        try
                        {
                            ICollection<ElementId> gone = doc.Delete(ids);
                            deleted = gone?.Count ?? 0;
                            transaction.Commit();
                        }
                        catch (Exception ex)
                        {
                            try { transaction.RollBack(); } catch (Exception) { /* already closed */ }
                            throw new InvalidOperationException("Purge did not finish: " + ex.Message);
                        }
                    }
                }
                return new JObject
                {
                    ["purged"] = deleted,
                    ["candidates"] = ids.Count,
                    ["rules"] = rules.Count,
                    ["saved"] = false,
                    ["api_limits"] = new JArray("Purge uses PerformanceAdviser rules named unused or purge. Elements the rule does not list are left. The undo stack is not cleared."),
                };
            }
        }
    }
}
