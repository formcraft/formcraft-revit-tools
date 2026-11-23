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
    /// <summary>Sheet-list schedule fields and filters. No transaction.</summary>
    public class FmcRegisterReadHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft drawing register";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    string name = (Parameters.Value<string>("schedule") ?? "G100").Trim();
                    ViewSchedule schedule = new FilteredElementCollector(doc).OfClass(typeof(ViewSchedule)).Cast<ViewSchedule>()
                        .FirstOrDefault(view => !view.IsTemplate && string.Equals(view.Name, name, StringComparison.OrdinalIgnoreCase));
                    string status = StatusParameter(doc);
                    var sheets = new JArray();
                    foreach (ViewSheet sheet in new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>())
                    {
                        string value = status == null ? "" : sheet.LookupParameter(status)?.AsString() ?? "";
                        string revision = sheet.get_Parameter(BuiltInParameter.SHEET_CURRENT_REVISION)?.AsString() ?? "";
                        sheets.Add(new JObject
                        {
                            ["number"] = sheet.SheetNumber ?? "",
                            ["name"] = sheet.Name ?? "",
                            ["revision"] = revision,
                            ["status"] = value,
                            ["parked"] = string.Equals(value.Trim(), "PARKED", StringComparison.OrdinalIgnoreCase),
                        });
                    }
                    var fields = new JArray();
                    var filters = new JArray();
                    if (schedule != null)
                    {
                        ScheduleDefinition def = schedule.Definition;
                        for (int i = 0; i < def.GetFieldCount(); i++) fields.Add(def.GetField(i).GetName());
                        for (int i = 0; i < def.GetFilterCount(); i++)
                        {
                            ScheduleFilter filter = def.GetFilter(i);
                            string fieldName = "";
                            for (int f = 0; f < def.GetFieldCount(); f++)
                                if (def.GetField(f).FieldId == filter.FieldId) fieldName = def.GetField(f).GetName();
                            filters.Add(new JObject { ["field"] = fieldName, ["type"] = filter.FilterType.ToString(), ["value"] = filter.GetStringValue() ?? "" });
                        }
                    }
                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["exists"] = schedule != null,
                        ["schedule"] = new JObject
                        {
                            ["name"] = schedule?.Name ?? name,
                            ["exists"] = schedule != null,
                            ["fields"] = fields,
                            ["filters"] = filters,
                            ["status_parameter"] = status,
                        },
                        ["sheets"] = sheets,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        internal static string StatusParameter(Document doc)
        {
            ViewSheet sample = new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>().FirstOrDefault();
            if (sample == null) return null;
            foreach (Parameter parameter in sample.Parameters)
            {
                string name = parameter.Definition?.Name ?? "";
                if (name.IndexOf("browser", StringComparison.OrdinalIgnoreCase) >= 0 && parameter.StorageType == StorageType.String) return name;
            }
            if (sample.LookupParameter("FMC_Sheet_Status") != null) return "FMC_Sheet_Status";
            return null;
        }
    }

    /// <summary>One transaction. Creates the sheet list when it is missing, adds fields, and filters PARKED.</summary>
    public class FmcRegisterApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft drawing register apply";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    string name = (Parameters.Value<string>("schedule") ?? "G100").Trim();
                    string status = FmcRegisterReadHandler.StatusParameter(doc);
                    if (string.IsNullOrEmpty(status))
                        throw new InvalidOperationException("[FMC-REGISTER-STATUS] No browser parameter and no FMC_Sheet_Status parameter. Nothing was changed.");
                    using (var transaction = new Transaction(doc, "Formcraft drawing register"))
                    {
                        transaction.Start();
                        ViewSchedule schedule = new FilteredElementCollector(doc).OfClass(typeof(ViewSchedule)).Cast<ViewSchedule>()
                            .FirstOrDefault(view => !view.IsTemplate && string.Equals(view.Name, name, StringComparison.OrdinalIgnoreCase));
                        bool created = false;
                        if (schedule == null)
                        {
                            schedule = ViewSchedule.CreateSheetList(doc);
                            schedule.Name = name;
                            created = true;
                        }
                        ScheduleDefinition def = schedule.Definition;
                        var added = new JArray();
                        AddBuiltIn(doc, def, BuiltInParameter.SHEET_NUMBER, "Sheet Number", added);
                        AddBuiltIn(doc, def, BuiltInParameter.SHEET_NAME, "Sheet Name", added);
                        AddBuiltIn(doc, def, BuiltInParameter.SHEET_CURRENT_REVISION, "Current Revision", added);
                        ElementId statusId = ParameterId(doc, status);
                        if (statusId == ElementId.InvalidElementId)
                            throw new InvalidOperationException("[FMC-REGISTER-STATUS] " + status + " is not a schedulable parameter.");
                        if (!HasField(def, status))
                        {
                            def.AddField(ScheduleFieldType.Instance, statusId);
                            added.Add(status);
                        }
                        ScheduleField statusField = null;
                        for (int i = 0; i < def.GetFieldCount(); i++)
                            if (string.Equals(def.GetField(i).GetName(), status, StringComparison.OrdinalIgnoreCase)) statusField = def.GetField(i);
                        if (statusField == null) throw new InvalidOperationException("[FMC-REGISTER-FIELD] The status field was not added.");
                        foreach (string value in new[] { "PARKED", "Parked" })
                        {
                            if (HasFilter(def, statusField.FieldId, value)) continue;
                            def.AddFilter(new ScheduleFilter(statusField.FieldId, ScheduleFilterType.NotEqual, value));
                        }
                        transaction.Commit();
                        Result = new JObject { ["ok"] = true, ["created"] = created, ["schedule"] = schedule.Name, ["added_fields"] = added, ["saved"] = false, ["synced"] = false };
                    }
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static void AddBuiltIn(Document doc, ScheduleDefinition def, BuiltInParameter bip, string label, JArray added)
        {
            if (HasField(def, label)) return;
            def.AddField(ScheduleFieldType.Instance, new ElementId(bip));
            added.Add(label);
        }

        private static bool HasField(ScheduleDefinition def, string name)
        {
            for (int i = 0; i < def.GetFieldCount(); i++)
                if (string.Equals(def.GetField(i).GetName(), name, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        private static bool HasFilter(ScheduleDefinition def, ScheduleFieldId field, string value)
        {
            for (int i = 0; i < def.GetFilterCount(); i++)
            {
                ScheduleFilter filter = def.GetFilter(i);
                if (filter.FieldId == field && filter.FilterType == ScheduleFilterType.NotEqual && string.Equals(filter.GetStringValue(), value, StringComparison.Ordinal))
                    return true;
            }
            return false;
        }

        private static ElementId ParameterId(Document doc, string name)
        {
            foreach (ParameterElement element in new FilteredElementCollector(doc).OfClass(typeof(ParameterElement)).Cast<ParameterElement>())
                if (string.Equals(element.GetDefinition()?.Name, name, StringComparison.OrdinalIgnoreCase)) return element.Id;
            return ElementId.InvalidElementId;
        }
    }
}
