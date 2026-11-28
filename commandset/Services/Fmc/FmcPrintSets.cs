using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;
using RevitMCPCommandSet.Utils;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>GAP-18 fmc_print_sets_read: sheets and the view and sheet sets in the named document. No transaction.</summary>
    public class FmcPrintSetsReadHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft print sets (read)";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    var sheets = new JArray();
                    foreach (ViewSheet sheet in new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>())
                    {
                        if (sheet.IsTemplate || sheet.IsPlaceholder) continue;
                        sheets.Add(new JObject { ["id"] = sheet.Id.GetValue().ToString(), ["number"] = sheet.SheetNumber ?? "", ["name"] = sheet.Name ?? "" });
                    }
                    var sets = new JArray();
                    foreach (ViewSheetSet set in new FilteredElementCollector(doc).OfClass(typeof(ViewSheetSet)).Cast<ViewSheetSet>())
                    {
                        var ids = new JArray();
                        foreach (View view in set.Views) ids.Add(view.Id.GetValue().ToString());
                        sets.Add(new JObject { ["id"] = set.Id.GetValue().ToString(), ["name"] = set.Name ?? "", ["view_ids"] = ids });
                    }
                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["title"] = doc.Title ?? "",
                        ["path"] = doc.PathName ?? "",
                        ["is_central"] = FmcPhaseIds.IsCentral(doc),
                        ["sheets"] = sheets,
                        ["sets"] = sets,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }
    }

    /// <summary>
    /// GAP-18 fmc_print_sets_apply: one transaction. Creates a named view and sheet set, or replaces the sheets of the
    /// set the dry run named (existing_id). Never deletes a set. The print range the document had is put back.
    /// </summary>
    public class FmcPrintSetsApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft print sets (apply)";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    if (FmcPhaseIds.IsCentral(doc)) throw new InvalidOperationException("[FMC-PRINTSETS-GUARD] A central model is not written by fmc_print_sets. Nothing was changed.");
                    var ops = Parameters["ops"] as JArray ?? new JArray();
                    if (ops.Count == 0) throw new InvalidOperationException("[FMC-PRINTSETS-NOTHING] No sets to write. Nothing was changed.");
                    var done = new JArray();
                    using (var transaction = new Transaction(doc, "Formcraft print sets"))
                    {
                        transaction.Start();
                        PrintManager pm = doc.PrintManager;
                        PrintRange range = pm.PrintRange;
                        pm.PrintRange = PrintRange.Select;
                        ViewSheetSetting vss = pm.ViewSheetSetting;
                        foreach (JObject op in ops.OfType<JObject>())
                        {
                            string name = (op.Value<string>("name") ?? "").Trim();
                            string action = op.Value<string>("action") ?? "";
                            var views = new ViewSet();
                            foreach (JToken id in op["sheet_ids"] as JArray ?? new JArray())
                            {
                                if (!long.TryParse(id.ToString(), out long value)) throw new InvalidOperationException("[FMC-PRINTSETS-ID] Bad sheet id " + id + ". Nothing was changed.");
                                if (!(doc.GetElement(new ElementId(value)) is ViewSheet sheet)) throw new InvalidOperationException("[FMC-PRINTSETS-ID] " + id + " is not a sheet in " + doc.Title + ". Nothing was changed.");
                                views.Insert(sheet);
                            }
                            if (name.Length == 0 || views.IsEmpty) throw new InvalidOperationException("[FMC-PRINTSETS-EMPTY] A set needs a name and sheets. Nothing was changed.");
                            ViewSheetSet same = new FilteredElementCollector(doc).OfClass(typeof(ViewSheetSet)).Cast<ViewSheetSet>()
                                .FirstOrDefault(s => string.Equals(s.Name, name, StringComparison.OrdinalIgnoreCase));
                            if (action == "update")
                            {
                                string wanted = op.Value<string>("existing_id") ?? "";
                                if (same == null || same.Id.GetValue().ToString() != wanted)
                                    throw new InvalidOperationException("[FMC-PRINTSETS-STALE] The set " + name + " is not the one the dry run read. Nothing was changed.");
                                vss.CurrentViewSheetSet = same;
                                vss.CurrentViewSheetSet.Views = views;
                                vss.Save();
                            }
                            else
                            {
                                if (same != null) throw new InvalidOperationException("[FMC-PRINTSETS-EXISTS] " + name + " already exists. Nothing was changed.");
                                vss.CurrentViewSheetSet = vss.InSession;
                                vss.CurrentViewSheetSet.Views = views;
                                vss.SaveAs(name);
                            }
                            done.Add(new JObject { ["name"] = name, ["action"] = action == "update" ? "update" : "create", ["sheets"] = views.Size });
                        }
                        try { pm.PrintRange = range; } catch (Exception) { /* the sets are written; the range is a print setting */ }
                        transaction.Commit();
                    }
                    Result = new JObject
                    {
                        ["read_only"] = false,
                        ["saved"] = false,
                        ["sets"] = done,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }
    }
}
