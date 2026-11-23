using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>Sheets, title-block legend parameters and whether the named keynote legend is already on the sheet. No transaction.</summary>
    public class FmcKeynoteLegendHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft keynote legend";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_keynote_legend needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    string name = (Parameters.Value<string>("name") ?? "FMC Keynotes").Trim();
                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["title"] = doc.Title ?? "",
                        ["path"] = doc.PathName ?? "",
                        ["is_central"] = FmcPhaseIds.IsCentral(doc),
                        ["sheets"] = Sheets(doc, name),
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static JArray Sheets(Document doc, string legendName)
        {
            ElementId legendId = new FilteredElementCollector(doc).OfClass(typeof(ViewSchedule)).Cast<ViewSchedule>()
                .FirstOrDefault(view => string.Equals(view.Name, legendName, StringComparison.OrdinalIgnoreCase))?.Id;
            var onSheet = new HashSet<long>();
            if (legendId != null)
            {
                foreach (ScheduleSheetInstance instance in new FilteredElementCollector(doc).OfClass(typeof(ScheduleSheetInstance)).Cast<ScheduleSheetInstance>())
                    if (instance.ScheduleId == legendId && instance.OwnerViewId != null) onSheet.Add(instance.OwnerViewId.Value);
            }
            var rows = new JArray();
            foreach (ViewSheet sheet in new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>())
            {
                bool plan = false;
                foreach (ElementId id in sheet.GetAllViewports())
                {
                    if (doc.GetElement(id) is Viewport viewport && doc.GetElement(viewport.ViewId) is View view && view.ViewType == ViewType.FloorPlan)
                        plan = true;
                }
                Element title = new FilteredElementCollector(doc, sheet.Id).OfCategory(BuiltInCategory.OST_TitleBlocks).WhereElementIsNotElementType().FirstElement();
                string role = title?.LookupParameter("FMC_Sheet_Role")?.AsString()
                    ?? title?.LookupParameter("Sheet Role")?.AsString()
                    ?? sheet.LookupParameter("FMC_Sheet_Role")?.AsString()
                    ?? "";
                if (string.IsNullOrWhiteSpace(role)) role = plan ? "plan" : "";
                var row = new JObject
                {
                    ["id"] = sheet.Id.Value.ToString(),
                    ["number"] = sheet.SheetNumber ?? "",
                    ["name"] = sheet.Name ?? "",
                    ["role"] = role,
                    ["has_legend"] = onSheet.Contains(sheet.Id.Value),
                };
                BoundingBoxXYZ box = title?.get_BoundingBox(sheet);
                if (box != null)
                {
                    row["titleblock_mm"] = new JObject
                    {
                        ["min_x"] = Mm(box.Min.X),
                        ["min_y"] = Mm(box.Min.Y),
                        ["max_x"] = Mm(box.Max.X),
                        ["max_y"] = Mm(box.Max.Y),
                    };
                }
                if (title != null && TryZone(title, out double x, out double y))
                {
                    row["legend_x_mm"] = x;
                    row["legend_y_mm"] = y;
                    row["legend_source"] = "param";
                }
                rows.Add(row);
            }
            return rows;
        }

        /// <summary>FMC_Legend_Zone is text "x,y" in millimetres. FMC_Legend_X and FMC_Legend_Y are length parameters (feet).</summary>
        private static bool TryZone(Element title, out double x, out double y)
        {
            x = 0;
            y = 0;
            Parameter text = title.LookupParameter("FMC_Legend_Zone") ?? title.LookupParameter("Legend Zone");
            if (text != null && text.StorageType == StorageType.String)
            {
                string[] parts = (text.AsString() ?? "").Split(',');
                if (parts.Length >= 2 && double.TryParse(parts[0].Trim(), out double px) && double.TryParse(parts[1].Trim(), out double py))
                {
                    x = px;
                    y = py;
                    return true;
                }
            }
            Parameter pxParam = title.LookupParameter("FMC_Legend_X");
            Parameter pyParam = title.LookupParameter("FMC_Legend_Y");
            if (pxParam != null && pyParam != null && pxParam.StorageType == StorageType.Double && pyParam.StorageType == StorageType.Double)
            {
                x = Mm(pxParam.AsDouble());
                y = Mm(pyParam.AsDouble());
                return true;
            }
            return false;
        }

        private static double Mm(double feet) => Math.Round(feet * 304.8, 1);
    }

    /// <summary>One transaction. One keynote legend, filtered by sheet, placed on each sheet. Returns the legend id and the viewport ids.</summary>
    public class FmcKeynoteLegendApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft keynote legend apply";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_keynote_legend_apply needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    Refuse(doc);
                    using (var transaction = new Transaction(doc, "Formcraft keynote legend"))
                    {
                        transaction.Start();
                        try
                        {
                            string name = (Parameters.Value<string>("name") ?? "FMC Keynotes").Trim();
                            bool filter = Parameters.Value<bool?>("filter_by_sheet") != false;
                            ViewSchedule legend = new FilteredElementCollector(doc).OfClass(typeof(ViewSchedule)).Cast<ViewSchedule>()
                                .FirstOrDefault(view => string.Equals(view.Name, name, StringComparison.OrdinalIgnoreCase));
                            bool created = false;
                            if (legend == null)
                            {
                                legend = ViewSchedule.CreateKeynoteLegend(doc);
                                legend.Name = name;
                                created = true;
                            }
                            if (filter)
                            {
                                if (!legend.Definition.IsValidCategoryForFilterBySheet())
                                {
                                    transaction.RollBack();
                                    Result = new JObject
                                    {
                                        ["ok"] = false,
                                        ["code"] = "FMC-KEYNOTE-LEGEND-FILTER",
                                        ["message"] = "IsValidCategoryForFilterBySheet is false. The legend was not kept and nothing was placed.",
                                        ["saved"] = false,
                                        ["synced"] = false,
                                    };
                                    return;
                                }
                                legend.Definition.IsFilteredBySheet = true;
                            }
                            var viewports = new JArray();
                            foreach (JObject place in (Parameters["placements"] as JArray ?? new JArray()).OfType<JObject>())
                            {
                                using (var sub = new SubTransaction(doc))
                                {
                                    sub.Start();
                                    try
                                    {
                                        if (!long.TryParse(place.Value<string>("sheet_id"), out long sheetId)) throw new InvalidOperationException("The sheet id is missing.");
                                        ViewSheet sheet = doc.GetElement(new ElementId(sheetId)) as ViewSheet ?? throw new InvalidOperationException("That sheet was not found.");
                                        XYZ at = new XYZ((place.Value<double?>("x") ?? 0) / 304.8, (place.Value<double?>("y") ?? 0) / 304.8, 0);
                                        ScheduleSheetInstance instance = ScheduleSheetInstance.Create(doc, sheet.Id, legend.Id, at);
                                        sub.Commit();
                                        viewports.Add(new JObject
                                        {
                                            ["sheet"] = sheet.SheetNumber ?? "",
                                            ["sheet_id"] = sheet.Id.Value.ToString(),
                                            ["viewport_id"] = instance.Id.Value.ToString(),
                                        });
                                    }
                                    catch (Exception ex)
                                    {
                                        try { if (sub.HasStarted()) sub.RollBack(); } catch (Exception) { }
                                        viewports.Add(new JObject { ["sheet_id"] = place.Value<string>("sheet_id"), ["code"] = "FMC-KEYNOTE-LEGEND-SHEET", ["reason"] = ex.Message });
                                    }
                                }
                            }
                            transaction.Commit();
                            Result = new JObject
                            {
                                ["ok"] = true,
                                ["legend_id"] = legend.Id.Value.ToString(),
                                ["created"] = created,
                                ["filter_by_sheet"] = legend.Definition.IsFilteredBySheet,
                                ["viewports"] = viewports,
                                ["saved"] = false,
                                ["synced"] = false,
                                ["resolved_document"] = FmcTarget.Resolved(doc),
                            };
                        }
                        catch
                        {
                            if (transaction.HasStarted() && !transaction.HasEnded()) transaction.RollBack();
                            throw;
                        }
                    }
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private void Refuse(Document doc)
        {
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (Regex.IsMatch(blob, "hebert hostels", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("HEBERT HOSTELS is not written by fmc_keynote_legend.");
            if (FmcPhaseIds.IsCentral(doc)) throw new InvalidOperationException("A central model is not written by fmc_keynote_legend.");
            if (FmcTarget.IsProtected(doc.PathName ?? "", FmcTarget.Roots(Parameters)))
                throw new InvalidOperationException("The document is under a protected path.");
        }
    }
}
