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
    /// fmc_schedules_apply (F60, docs/SCHEDULES.md): a schedule set made or updated in the active template or WIP model.
    /// A new schedule gets every field, heading, hidden flag, total, filter, sort and group from the set. An existing one
    /// (same name) only gets the fields it lacks, so a person's own columns, filters and formatting stay. Nothing is
    /// deleted. One transaction; a dry run is rolled back and says what it would do. The server sends a real run through
    /// the live-model lock.
    /// </summary>
    public class FmcSchedulesHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft schedules";

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try { Result = Apply(app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("Open the template or WIP model first")); }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        private JObject Apply(Document doc)
        {
            if (doc.IsFamilyDocument) throw new InvalidOperationException("Schedules go in a template or project, not a family");
            bool dry = Parameters.Value<bool?>("dry_run") ?? true;
            var results = new JArray();
            int made = 0, updated = 0, same = 0;
            using (var t = new Transaction(doc, "FMC schedules"))
            {
                t.Start();
                var existing = new FilteredElementCollector(doc).OfClass(typeof(ViewSchedule)).Cast<ViewSchedule>().Where(v => !v.IsTemplate).ToList();
                foreach (JObject s in (Parameters["schedules"] as JArray ?? new JArray()).OfType<JObject>())
                {
                    string name = s.Value<string>("name");
                    var r = new JObject { ["name"] = name };
                    try
                    {
                        ViewSchedule vs = existing.FirstOrDefault(v => v.Name == name);
                        bool isNew = vs == null;
                        if (isNew)
                        {
                            vs = ViewSchedule.CreateSchedule(doc, Category(doc, s.Value<string>("category")));
                            vs.Name = name;
                        }
                        ScheduleDefinition def = vs.Definition;
                        var have = Enumerable.Range(0, def.GetFieldCount()).Select(i => def.GetField(i)).ToDictionary(f => f.GetName(), f => f, StringComparer.OrdinalIgnoreCase);
                        var schedulable = def.GetSchedulableFields();
                        var added = new JArray(); var missing = new JArray();
                        var ids = new Dictionary<string, ScheduleField>(StringComparer.OrdinalIgnoreCase);
                        foreach (JObject f in (s["fields"] as JArray ?? new JArray()).OfType<JObject>())
                        {
                            string fn = f.Value<string>("name");
                            if (have.TryGetValue(fn, out ScheduleField got)) { ids[fn] = got; continue; }
                            SchedulableField sf = schedulable.FirstOrDefault(x => string.Equals(x.GetName(doc), fn, StringComparison.OrdinalIgnoreCase));
                            if (sf == null) { missing.Add(fn); continue; }
                            ScheduleField nf = def.AddField(sf);
                            if (!string.IsNullOrEmpty(f.Value<string>("heading"))) nf.ColumnHeading = f.Value<string>("heading");
                            if (f.Value<bool?>("hidden") == true) nf.IsHidden = true;
                            if (f.Value<bool?>("total") == true && nf.CanTotal()) nf.DisplayType = ScheduleFieldDisplayType.Totals;
                            ids[fn] = nf;
                            added.Add(fn);
                        }
                        // rules only on a schedule this makes: an existing one keeps the filters and sorting people set
                        if (isNew)
                        {
                            foreach (JObject f in (s["filters"] as JArray ?? new JArray()).OfType<JObject>())
                            {
                                if (!ids.TryGetValue(f.Value<string>("field"), out ScheduleField sf)) continue;
                                ScheduleFilter flt = Filter(sf, f);
                                if (flt != null) def.AddFilter(flt); else r["note"] = $"filter on {sf.GetName()} not set (its type doesn't take that value)";
                            }
                            foreach (JObject o in (s["sort"] as JArray ?? new JArray()).OfType<JObject>())
                            {
                                if (!ids.TryGetValue(o.Value<string>("field"), out ScheduleField sf)) continue;
                                var g = new ScheduleSortGroupField(sf.FieldId, o.Value<bool?>("descending") == true ? ScheduleSortOrder.Descending : ScheduleSortOrder.Ascending);
                                if (o.Value<bool?>("group") == true) { g.ShowHeader = true; g.ShowFooter = o.Value<bool?>("totals") == true; }
                                def.AddSortGroupField(g);
                            }
                            def.IsItemized = s.Value<bool?>("itemized") ?? true;
                            if (s.Value<bool?>("grand_totals") == true) { def.ShowGrandTotal = true; def.ShowGrandTotalTitle = true; }
                        }
                        string folder = s.Value<string>("folder");
                        if (!string.IsNullOrEmpty(folder))
                        {
                            Parameter fp = vs.LookupParameter("FMC_Schedule_Folder");
                            if (fp != null && !fp.IsReadOnly) fp.Set(folder); else r["folder_note"] = "no FMC_Schedule_Folder on schedules here: the browser folder isn't set";
                        }
                        r["state"] = isNew ? "made" : added.Count > 0 ? "updated" : "same";
                        if (isNew) made++; else if (added.Count > 0) updated++; else same++;
                        r["added"] = added;
                        if (missing.Count > 0) r["missing"] = missing;
                        var extra = have.Keys.Where(k => !(s["fields"] as JArray ?? new JArray()).OfType<JObject>().Any(f => string.Equals(f.Value<string>("name"), k, StringComparison.OrdinalIgnoreCase))).ToList();
                        if (!isNew && extra.Count > 0) r["kept_extra"] = new JArray(extra);
                    }
                    catch (Exception e) { r["state"] = "error"; r["error"] = e.Message; }
                    results.Add(r);
                }
                if (dry) t.RollBack(); else t.Commit();
            }
            return new JObject { ["dry_run"] = dry, ["made"] = made, ["updated"] = updated, ["same"] = same, ["schedules"] = results };
        }

        private static ElementId Category(Document doc, string c)
        {
            if (c == "*") return ElementId.InvalidElementId;
            if (Enum.TryParse(c, out BuiltInCategory bic)) return new ElementId(bic);
            return doc.Settings.Categories.Cast<Category>().FirstOrDefault(x => x.Name == c)?.Id ?? throw new InvalidOperationException($"no category {c}");
        }

        private static ScheduleFilter Filter(ScheduleField f, JObject spec)
        {
            ScheduleFilterType type;
            switch (spec.Value<string>("op"))
            {
                case "equals": type = ScheduleFilterType.Equal; break;
                case "not_equals": type = ScheduleFilterType.NotEqual; break;
                case "contains": type = ScheduleFilterType.Contains; break;
                case "not_contains": type = ScheduleFilterType.NotContains; break;
                case "begins_with": type = ScheduleFilterType.BeginsWith; break;
                case "greater": type = ScheduleFilterType.GreaterThan; break;
                case "less": type = ScheduleFilterType.LessThan; break;
                case "has_value": return new ScheduleFilter(f.FieldId, ScheduleFilterType.HasValue);
                case "has_no_value": return new ScheduleFilter(f.FieldId, ScheduleFilterType.HasNoValue);
                default: return null;
            }
            JToken v = spec["value"];
            if (v == null) return null;
            try
            {
                if (v.Type == JTokenType.Integer) return new ScheduleFilter(f.FieldId, type, v.Value<int>());
                if (v.Type == JTokenType.Float) return new ScheduleFilter(f.FieldId, type, v.Value<double>());
                return new ScheduleFilter(f.FieldId, type, v.Value<string>());
            }
            catch (Exception) { return null; }
        }
    }
}
