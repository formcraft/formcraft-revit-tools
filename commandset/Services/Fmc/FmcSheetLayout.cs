using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>Sheet outline, title block, view sizes and sheet parameters. No transaction.</summary>
    public class FmcSheetLayoutHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft sheet layout";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_sheets_layout needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    if (string.Equals(Parameters.Value<string>("action"), "pack", StringComparison.OrdinalIgnoreCase))
                    {
                        Result = FmcSheetLayoutApplyHandler.ReadPack(doc, Parameters);
                        return;
                    }
                    var wanted = new HashSet<string>(String.Equals(Parameters.Value<string>("action"), "park", StringComparison.OrdinalIgnoreCase)
                        ? Strings(Parameters["sheets"] as JArray)
                        : new[] { Parameters.Value<string>("sheet") ?? "" }, StringComparer.OrdinalIgnoreCase);
                    var placedOn = new Dictionary<long, string>();
                    foreach (ViewSheet sheet in new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>())
                        foreach (ElementId id in sheet.GetAllPlacedViews())
                            placedOn[id.Value] = sheet.SheetNumber ?? "";
                    var sheets = new JArray();
                    foreach (ViewSheet sheet in new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>())
                    {
                        if (wanted.Count > 0 && !wanted.Contains(sheet.SheetNumber) && !wanted.Contains(sheet.Name) && !wanted.Contains(sheet.Id.Value.ToString())) continue;
                        sheets.Add(ReadSheet(doc, sheet, placedOn));
                    }
                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["title"] = doc.Title ?? "",
                        ["path"] = doc.PathName ?? "",
                        ["is_central"] = FmcPhaseIds.IsCentral(doc),
                        ["sheets"] = sheets,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static JObject ReadSheet(Document doc, ViewSheet sheet, Dictionary<long, string> placedOn)
        {
            BoundingBoxUV outline = sheet.Outline;
            var row = new JObject
            {
                ["id"] = sheet.Id.Value.ToString(),
                ["number"] = sheet.SheetNumber ?? "",
                ["name"] = sheet.Name ?? "",
                ["outline_mm"] = Box(outline.Min.U, outline.Min.V, outline.Max.U, outline.Max.V),
                ["parameters"] = Params(sheet),
            };
            Element title = new FilteredElementCollector(doc, sheet.Id).OfCategory(BuiltInCategory.OST_TitleBlocks).WhereElementIsNotElementType().FirstElement();
            BoundingBoxXYZ titleBox = title?.get_BoundingBox(sheet);
            if (titleBox != null) row["titleblock_mm"] = Box(titleBox.Min.X, titleBox.Min.Y, titleBox.Max.X, titleBox.Max.Y);
            var placed = new JArray();
            foreach (ElementId id in sheet.GetAllViewports())
            {
                if (doc.GetElement(id) is not Viewport viewport) continue;
                if (doc.GetElement(viewport.ViewId) is not View view) continue;
                Outline box = viewport.GetBoxOutline();
                placed.Add(new JObject
                {
                    ["id"] = view.Id.Value.ToString(),
                    ["name"] = view.Name ?? "",
                    ["width_mm"] = Math.Round(Math.Abs(box.MaximumPoint.X - box.MinimumPoint.X) * 304.8, 1),
                    ["height_mm"] = Math.Round(Math.Abs(box.MaximumPoint.Y - box.MinimumPoint.Y) * 304.8, 1),
                    ["on_sheet"] = sheet.SheetNumber ?? "",
                });
            }
            row["placed"] = placed;
            var views = new JArray();
            foreach (View view in new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(view => !view.IsTemplate && view.ViewType != ViewType.DrawingSheet && view.ViewType != ViewType.ProjectBrowser && view.ViewType != ViewType.SystemBrowser))
            {
                string other = placedOn.TryGetValue(view.Id.Value, out string number) ? number : "";
                var size = PaperSize(view);
                views.Add(new JObject
                {
                    ["id"] = view.Id.Value.ToString(),
                    ["name"] = view.Name ?? "",
                    ["width_mm"] = size.w,
                    ["height_mm"] = size.h,
                    ["on_sheet"] = other,
                });
            }
            row["views"] = views;
            return row;
        }

        private static (double w, double h) PaperSize(View view)
        {
            try
            {
                BoundingBoxXYZ crop = view.CropBox;
                if (crop == null) return (200, 150);
                double scale = Math.Max(view.Scale, 1);
                return (Math.Round(Math.Abs(crop.Max.X - crop.Min.X) * 304.8 / scale, 1), Math.Round(Math.Abs(crop.Max.Y - crop.Min.Y) * 304.8 / scale, 1));
            }
            catch (Exception) { return (200, 150); }
        }

        private static JObject Box(double minX, double minY, double maxX, double maxY) => new JObject
        {
            ["min_x"] = Math.Round(minX * 304.8, 1),
            ["min_y"] = Math.Round(minY * 304.8, 1),
            ["max_x"] = Math.Round(maxX * 304.8, 1),
            ["max_y"] = Math.Round(maxY * 304.8, 1),
        };

        private static JObject Params(ViewSheet sheet)
        {
            var row = new JObject();
            foreach (Parameter parameter in sheet.Parameters.Cast<Parameter>().Where(parameter => parameter.StorageType == StorageType.String && parameter.Definition != null).Take(40))
                row[parameter.Definition.Name] = parameter.AsString() ?? "";
            return row;
        }

        private static IEnumerable<string> Strings(JArray array) => (array ?? new JArray()).Select(token => token.ToString()).Where(text => text.Trim().Length > 0);
    }

    /// <summary>One transaction. Places or moves viewports, or sets the park parameter.</summary>
    public class FmcSheetLayoutApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft sheet layout apply";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_sheets_layout_apply needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    Refuse(doc);
                    string action = (Parameters.Value<string>("action") ?? "").Trim();
                    var done = new JArray();
                    var skipped = new JArray();
                    using (var transaction = new Transaction(doc, "Formcraft sheets"))
                    {
                        transaction.Start();
                        try
                        {
                            if (action == "park") Park(doc, done, skipped);
                            else Place(doc, done, skipped);
                            transaction.Commit();
                        }
                        catch
                        {
                            if (transaction.HasStarted() && !transaction.HasEnded()) transaction.RollBack();
                            throw;
                        }
                    }
                    Result = new JObject { ["ok"] = true, ["action"] = action, ["applied"] = done, ["skipped"] = skipped, ["saved"] = false, ["synced"] = false, ["resolved_document"] = FmcTarget.Resolved(doc) };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private void Refuse(Document doc)
        {
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (Regex.IsMatch(blob, "hebert hostels", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("HEBERT HOSTELS is not written by fmc_sheets.");
            if (FmcPhaseIds.IsCentral(doc)) throw new InvalidOperationException("A central model is not written by fmc_sheets.");
            if (FmcTarget.IsProtected(doc.PathName ?? "", FmcTarget.Roots(Parameters)))
                throw new InvalidOperationException("The document is under a protected path.");
        }

        /// <summary>Read-only pack data. Static so the read handler can call it without a transaction.</summary>
        internal static JObject ReadPack(Document doc, JObject parameters)
        {
            ViewSheet sheet = FindSheet(doc, parameters?.Value<string>("sheet"));
            if (sheet == null) throw new InvalidOperationException("[FMC-SHEETS-SHEET] That sheet was not found.");
            Element title = new FilteredElementCollector(doc, sheet.Id).OfCategory(BuiltInCategory.OST_TitleBlocks).WhereElementIsNotElementType().FirstElement();
            FamilyInstance instance = title as FamilyInstance;
            string family = instance?.Symbol?.FamilyName ?? "";
            var pars = new JObject();
            foreach (string name in new[] { "FMC_Drawing_Width", "Drawing Width", "Drawing Area Width", "FMC_Drawing_Height", "Drawing Height", "Drawing Area Height", "FMC_Drawing_Left", "Drawing Origin X", "FMC_Drawing_Bottom", "Drawing Origin Y" })
            {
                Parameter parameter = title?.LookupParameter(name);
                if (parameter != null && parameter.HasValue && parameter.StorageType == StorageType.Double)
                    pars[name] = Math.Round(parameter.AsDouble() * 304.8, 1);
            }
            var onSheet = new JArray();
            var others = new JArray();
            foreach (Viewport viewport in new FilteredElementCollector(doc).OfClass(typeof(Viewport)).Cast<Viewport>())
            {
                if (doc.GetElement(viewport.ViewId) is not View view) continue;
                string number = doc.GetElement(viewport.OwnerViewId) is ViewSheet host ? host.SheetNumber ?? "" : "";
                double titleMm = 12;
                try
                {
                    Outline label = viewport.GetLabelOutline();
                    if (label != null) titleMm = Math.Max(0, Math.Round((label.MaximumPoint.Y - label.MinimumPoint.Y) * 304.8, 1));
                }
                catch (Exception) { titleMm = 12; }
                double modelW = 200 * Math.Max(view.Scale, 1);
                double modelH = 150 * Math.Max(view.Scale, 1);
                try
                {
                    BoundingBoxXYZ crop = view.CropBox;
                    if (crop != null)
                    {
                        modelW = Math.Round(Math.Abs(crop.Max.X - crop.Min.X) * 304.8, 1);
                        modelH = Math.Round(Math.Abs(crop.Max.Y - crop.Min.Y) * 304.8, 1);
                    }
                }
                catch (Exception) { }
                var row = new JObject
                {
                    ["id"] = view.Id.Value.ToString(),
                    ["name"] = view.Name ?? "",
                    ["sheet"] = number,
                    ["model_width_mm"] = modelW,
                    ["model_height_mm"] = modelH,
                    ["scale"] = view.Scale,
                    ["title_mm"] = titleMm,
                };
                if (string.Equals(number, sheet.SheetNumber, StringComparison.OrdinalIgnoreCase)) onSheet.Add(row);
                else others.Add(row);
            }
            return new JObject
            {
                ["read_only"] = true,
                ["title"] = doc.Title ?? "",
                ["path"] = doc.PathName ?? "",
                ["is_central"] = FmcPhaseIds.IsCentral(doc),
                ["family"] = family,
                ["params"] = pars,
                ["sheet"] = sheet.SheetNumber ?? "",
                ["views"] = onSheet,
                ["others"] = others,
                ["resolved_document"] = FmcTarget.Resolved(doc),
            };
        }

        private void Place(Document doc, JArray done, JArray skipped)
        {
            ViewSheet sheet = FindSheet(doc, Parameters.Value<string>("sheet"));
            if (sheet == null) throw new InvalidOperationException("[FMC-SHEETS-SHEET] That sheet was not found.");
            foreach (JObject op in (Parameters["ops"] as JArray ?? new JArray()).OfType<JObject>())
            {
                View view = FindView(doc, op.Value<string>("view_id"));
                if (view == null)
                {
                    skipped.Add(new JObject { ["view_id"] = op.Value<string>("view_id"), ["code"] = "FMC-SHEETS-VIEW" });
                    continue;
                }
                XYZ at = new XYZ(Mm(op.Value<double?>("center_x_mm") ?? 0), Mm(op.Value<double?>("center_y_mm") ?? 0), 0);
                using (var sub = new SubTransaction(doc))
                {
                    sub.Start();
                    try
                    {
                        int scale = op.Value<int?>("scale") ?? 0;
                        if (scale > 0 && view.Scale != scale)
                        {
                            try { view.Scale = scale; }
                            catch (Exception ex)
                            {
                                sub.RollBack();
                                skipped.Add(new JObject { ["view_id"] = view.Id.Value.ToString(), ["code"] = "FMC-SHEETS-SCALE", ["reason"] = ex.Message });
                                continue;
                            }
                        }
                        Viewport taken = new FilteredElementCollector(doc).OfClass(typeof(Viewport)).Cast<Viewport>().FirstOrDefault(item => item.ViewId == view.Id);
                        if (taken != null && taken.OwnerViewId != sheet.Id)
                        {
                            if (op.Value<bool?>("from_other_sheet") == true)
                            {
                                doc.Delete(taken.Id);
                                doc.Regenerate();
                                taken = null;
                            }
                            else
                            {
                                sub.RollBack();
                                skipped.Add(new JObject { ["view_id"] = view.Id.Value.ToString(), ["code"] = "FMC-SHEETS-VIEW-TAKEN", ["reason"] = "The view is already on another sheet." });
                                continue;
                            }
                        }
                        Viewport viewport = taken ?? new FilteredElementCollector(doc, sheet.Id).OfClass(typeof(Viewport)).Cast<Viewport>().FirstOrDefault(item => item.ViewId == view.Id);
                        if (viewport != null)
                        {
                            doc.Regenerate();
                            viewport.SetBoxCenter(at);
                            sub.Commit();
                            done.Add(new JObject { ["view_id"] = view.Id.Value.ToString(), ["moved"] = true, ["scale"] = view.Scale });
                            continue;
                        }
                        if (view is ViewSchedule schedule)
                        {
                            ScheduleSheetInstance.Create(doc, sheet.Id, schedule.Id, at);
                            sub.Commit();
                            done.Add(new JObject { ["view_id"] = view.Id.Value.ToString(), ["placed"] = true });
                            continue;
                        }
                        if (!Viewport.CanAddViewToSheet(doc, sheet.Id, view.Id))
                        {
                            sub.RollBack();
                            skipped.Add(new JObject { ["view_id"] = view.Id.Value.ToString(), ["code"] = "FMC-SHEETS-VIEW-TAKEN", ["reason"] = "The view is already on another sheet, or it cannot be placed." });
                            continue;
                        }
                        Viewport.Create(doc, sheet.Id, view.Id, at);
                        sub.Commit();
                        done.Add(new JObject { ["view_id"] = view.Id.Value.ToString(), ["placed"] = true });
                    }
                    catch (Exception ex)
                    {
                        try { if (sub.HasStarted()) sub.RollBack(); } catch (Exception) { }
                        skipped.Add(new JObject { ["view_id"] = view.Id.Value.ToString(), ["code"] = "FMC-SHEETS-NO-FIT", ["reason"] = ex.Message });
                    }
                }
            }
        }

        private void Park(Document doc, JArray done, JArray skipped)
        {
            foreach (JObject op in (Parameters["ops"] as JArray ?? new JArray()).OfType<JObject>())
            {
                ViewSheet sheet = FindSheet(doc, op.Value<string>("sheet_id") ?? op.Value<string>("number"));
                if (sheet == null)
                {
                    skipped.Add(new JObject { ["sheet"] = op.Value<string>("number"), ["code"] = "FMC-SHEETS-SHEET" });
                    continue;
                }
                string name = op.Value<string>("parameter") ?? "FMC_Sheet_Status";
                Parameter parameter = sheet.LookupParameter(name);
                if (parameter == null || parameter.IsReadOnly || parameter.StorageType != StorageType.String || !parameter.Set(op.Value<string>("value") ?? "Parked"))
                {
                    skipped.Add(new JObject { ["sheet"] = sheet.SheetNumber, ["code"] = "FMC-SHEETS-PARK-PARAM", ["reason"] = "No writable sheet parameter named " + name + ". BrowserOrganization itself is not set per sheet by the API." });
                    continue;
                }
                done.Add(new JObject { ["sheet"] = sheet.SheetNumber, ["parameter"] = name, ["value"] = op.Value<string>("value") ?? "Parked" });
            }
        }

        private static ViewSheet FindSheet(Document doc, string key)
        {
            if (string.IsNullOrWhiteSpace(key)) return null;
            if (long.TryParse(key, out long id))
            {
                if (doc.GetElement(new ElementId(id)) is ViewSheet byId) return byId;
            }
            return new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>()
                .FirstOrDefault(sheet => string.Equals(sheet.SheetNumber, key, StringComparison.OrdinalIgnoreCase) || string.Equals(sheet.Name, key, StringComparison.OrdinalIgnoreCase));
        }

        private static View FindView(Document doc, string key)
        {
            if (string.IsNullOrWhiteSpace(key) || !long.TryParse(key, out long id)) return null;
            return doc.GetElement(new ElementId(id)) as View;
        }

        private static double Mm(double mm) => mm / 304.8;
    }
}
