using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_revit_file (owner 26 Oct, tools group 8): what Revit does with files, outside any edit batch. action: save,
    /// save_as, open, close (a model that isn't the active one), export (dwg, dxf, dgn, sat, pdf, ifc, nwc, fbx, gbxml,
    /// image, dwf, schedule), link_cad, import_cad, link_image, import_image, link_pdf, link_revit, load_family,
    /// point_cloud, sync, reload_latest, relinquish.
    /// </summary>
    public class FmcRevitFileHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return _done.WaitOne(timeoutMilliseconds); }
        public string GetName() => "Formcraft file action";

        private static double Ft(double mm) => mm / 304.8;

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try { Result = Run(app, Parameters.Value<string>("action") ?? throw new InvalidOperationException("action is needed")); }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        private JObject Run(UIApplication app, string action)
        {
            Document doc = app.ActiveUIDocument?.Document;
            string path = Parameters.Value<string>("path");
            switch (action)
            {
                case "open":
                    app.OpenAndActivateDocument(path ?? throw new InvalidOperationException("open needs path"));
                    return new JObject { ["opened"] = path };
                case "open_ifc":
                {
                    Document ifc = app.Application.OpenIFCDocument(path ?? throw new InvalidOperationException("open_ifc needs path"));
                    return new JObject { ["opened"] = ifc.Title, ["note"] = "opened in the background; save_as it as a .rvt, then open that" };
                }
                case "close":
                {
                    string title = Parameters.Value<string>("title") ?? throw new InvalidOperationException("close needs title (a model that isn't the active one)");
                    Document d = app.Application.Documents.Cast<Document>().FirstOrDefault(x => string.Equals(x.Title, title, StringComparison.OrdinalIgnoreCase)) ?? throw new InvalidOperationException($"{title} isn't open");
                    if (d.Equals(doc)) throw new InvalidOperationException("Revit can't close the active model from a plugin: open another first, or the person closes it");
                    d.Close(Parameters.Value<bool?>("save") ?? false);
                    return new JObject { ["closed"] = title };
                }
            }
            if (doc == null) throw new InvalidOperationException("No model is open");
            switch (action)
            {
                case "save": doc.Save(); return new JObject { ["saved"] = doc.PathName };
                case "save_as":
                {
                    var o = new SaveAsOptions { OverwriteExistingFile = Parameters.Value<bool?>("overwrite") ?? false, MaximumBackups = 3 };
                    if (doc.IsWorkshared) o.SetWorksharingOptions(new WorksharingSaveAsOptions { SaveAsCentral = Parameters.Value<bool?>("as_central") ?? false });
                    doc.SaveAs(path ?? throw new InvalidOperationException("save_as needs path"), o);
                    return new JObject { ["saved_as"] = path };
                }
                case "export": return Export(doc);
                case "export_family":
                {
                    // Save a family out of the project (Save As Library Family)
                    string fname = Parameters.Value<string>("family") ?? throw new InvalidOperationException("export_family needs family");
                    Family f = new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>().FirstOrDefault(x => string.Equals(x.Name, fname, StringComparison.OrdinalIgnoreCase)) ?? throw new InvalidOperationException($"no family {fname}");
                    Document fd = doc.EditFamily(f);
                    string to = path ?? throw new InvalidOperationException("export_family needs path (.rfa)");
                    fd.SaveAs(to, new SaveAsOptions { OverwriteExistingFile = Parameters.Value<bool?>("overwrite") ?? false, MaximumBackups = 1 });
                    fd.Close(false);
                    return new JObject { ["family"] = fname, ["saved"] = to };
                }
                case "link_cad":
                case "import_cad":
                {
                    View v = ViewOf(doc) ?? doc.ActiveView;
                    var o = new DWGImportOptions { ThisViewOnly = Parameters.Value<bool?>("this_view_only") ?? false, Placement = ImportPlacement.Origin };
                    if (path == null) throw new InvalidOperationException($"{action} needs path");
                    return InTx(doc, () =>
                    {
                        ElementId id;
                        bool ok = action == "link_cad" ? doc.Link(path, o, v, out id) : doc.Import(path, o, v, out id);
                        if (!ok) throw new InvalidOperationException($"Revit couldn't {action.Replace("_", " ")} {path}");
                        return new JObject { [action] = id.Value };
                    });
                }
                case "link_image":
                case "import_image":
                case "link_pdf":
                {
                    View v = ViewOf(doc) ?? doc.ActiveView;
                    return InTx(doc, () =>
                    {
                        var o = new ImageTypeOptions(path ?? throw new InvalidOperationException($"{action} needs path"), false, action == "import_image" ? ImageTypeSource.Import : ImageTypeSource.Link);
                        if (action == "link_pdf") o.PageNumber = Parameters.Value<int?>("page") ?? 1;
                        ImageType t = ImageType.Create(doc, o);
                        var at = Parameters["point_mm"] is JArray p ? new XYZ(Ft(p[0].Value<double>()), Ft(p[1].Value<double>()), 0) : XYZ.Zero;
                        ImageInstance i = ImageInstance.Create(doc, v, t.Id, new ImagePlacementOptions(at, BoxPlacement.Center));
                        return new JObject { [action] = i.Id.Value };
                    });
                }
                case "link_revit":
                    return InTx(doc, () =>
                    {
                        var r = RevitLinkType.Create(doc, ModelPathUtils.ConvertUserVisiblePathToModelPath(path ?? throw new InvalidOperationException("link_revit needs path")), new RevitLinkOptions(false));
                        var inst = RevitLinkInstance.Create(doc, r.ElementId, (Parameters.Value<string>("placement") ?? "shared") == "origin" ? ImportPlacement.Origin : ImportPlacement.Shared);
                        return new JObject { ["link"] = inst.Id.Value };
                    });
                case "load_family":
                    return InTx(doc, () =>
                    {
                        if (!doc.LoadFamily(path ?? throw new InvalidOperationException("load_family needs path"), out Family f)) throw new InvalidOperationException($"{path} didn't load (already loaded and unchanged?)");
                        return new JObject { ["family"] = f.Name };
                    });
                case "point_cloud":
                    return InTx(doc, () =>
                    {
                        var t = PointCloudType.Create(doc, Parameters.Value<string>("engine") ?? "rcp", path ?? throw new InvalidOperationException("point_cloud needs path"));
                        var i = PointCloudInstance.Create(doc, t.Id, Transform.Identity);
                        return new JObject { ["point_cloud"] = i.Id.Value };
                    });
                case "sync":
                {
                    if (!doc.IsWorkshared) throw new InvalidOperationException("the model isn't workshared");
                    var o = new SynchronizeWithCentralOptions { Comment = Parameters.Value<string>("comment") ?? "", Compact = Parameters.Value<bool?>("compact") ?? false };
                    o.SetRelinquishOptions(new RelinquishOptions(Parameters.Value<bool?>("relinquish") ?? true));
                    doc.SynchronizeWithCentral(new TransactWithCentralOptions(), o);
                    return new JObject { ["synced"] = doc.Title };
                }
                case "reload_latest": doc.ReloadLatest(new ReloadLatestOptions()); return new JObject { ["reloaded"] = doc.Title };
                case "relinquish":
                    WorksharingUtils.RelinquishOwnership(doc, new RelinquishOptions(true), new TransactWithCentralOptions());
                    return new JObject { ["relinquished"] = doc.Title };
                default: throw new InvalidOperationException($"{action} isn't an action (save, save_as, open, close, export, link_cad, import_cad, link_image, import_image, link_pdf, link_revit, load_family, point_cloud, sync, reload_latest, relinquish)");
            }
        }

        private JObject Export(Document doc)
        {
            string format = (Parameters.Value<string>("format") ?? throw new InvalidOperationException("export needs format")).ToLowerInvariant();
            string folder = Parameters.Value<string>("folder") ?? throw new InvalidOperationException("export needs folder");
            string name = Parameters.Value<string>("name") ?? doc.Title;
            Directory.CreateDirectory(folder);
            var views = (Parameters["views"] as JArray ?? new JArray()).Select(t => ViewByName(doc, t.ToString()).Id).ToList();
            if (views.Count == 0 && format != "ifc" && format != "gbxml" && format != "nwc") views.Add(doc.ActiveView.Id);
            bool ok = true;
            switch (format)
            {
                case "dwg": ok = doc.Export(folder, name, views, new DWGExportOptions { MergedViews = true }); break;
                case "dxf": ok = doc.Export(folder, name, views, new DXFExportOptions()); break;
                case "dgn": ok = doc.Export(folder, name, views, new DGNExportOptions()); break;
                case "sat": ok = doc.Export(folder, name, views, new SATExportOptions()); break;
                case "pdf": ok = doc.Export(folder, views, new PDFExportOptions { FileName = name, Combine = Parameters.Value<bool?>("combine") ?? true }); break;
                case "ifc":
                    using (var t = new Transaction(doc, "FMC IFC export")) { t.Start(); ok = doc.Export(folder, name, new IFCExportOptions()); t.RollBack(); }
                    break;
                case "nwc":
                    if (!OptionalFunctionalityUtils.IsNavisworksExporterAvailable()) throw new InvalidOperationException("the Navisworks exporter isn't installed");
                    doc.Export(folder, name, new NavisworksExportOptions()); break;
                case "fbx":
                {
                    var set = new ViewSet(); foreach (ElementId v in views) set.Insert((View)doc.GetElement(v));
                    ok = doc.Export(folder, name, set, new FBXExportOptions()); break;
                }
                case "dwf":
                {
                    var set = new ViewSet(); foreach (ElementId v in views) set.Insert((View)doc.GetElement(v));
                    ok = doc.Export(folder, name, set, new DWFExportOptions()); break;
                }
                case "gbxml": ok = doc.Export(folder, name, new GBXMLExportOptions()); break;
                case "image":
                {
                    var o = new ImageExportOptions { FilePath = Path.Combine(folder, name), ExportRange = ExportRange.SetOfViews, HLRandWFViewsFileType = ImageFileType.PNG,
                        ShadowViewsFileType = ImageFileType.PNG, PixelSize = Parameters.Value<int?>("pixels") ?? 2400, ZoomType = ZoomFitType.FitToPage };
                    o.SetViewsAndSheets(views);
                    doc.ExportImage(o); break;
                }
                case "schedule":
                    foreach (ElementId v in views)
                    {
                        var vs = doc.GetElement(v) as ViewSchedule ?? throw new InvalidOperationException($"{doc.GetElement(v).Name} isn't a schedule");
                        vs.Export(folder, (views.Count == 1 ? name : vs.Name) + ".csv", new ViewScheduleExportOptions { FieldDelimiter = ",", TextQualifier = ExportTextQualifier.DoubleQuote });
                    }
                    break;
                default: throw new InvalidOperationException($"{format} isn't an export format (dwg, dxf, dgn, sat, pdf, ifc, nwc, fbx, dwf, gbxml, image, schedule)");
            }
            if (!ok) throw new InvalidOperationException($"Revit didn't export {format}");
            return new JObject { ["exported"] = format, ["folder"] = folder, ["files"] = new JArray(Directory.GetFiles(folder).Select(Path.GetFileName).Take(50)) };
        }

        private View ViewOf(Document doc) => Parameters["view"] != null ? ViewByName(doc, Parameters.Value<string>("view")) : null;

        private static View ViewByName(Document doc, string s) =>
            (long.TryParse(s, out long id) ? doc.GetElement(new ElementId(id)) as View : null)
            ?? new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().FirstOrDefault(v => !v.IsTemplate && (string.Equals(v.Name, s, StringComparison.OrdinalIgnoreCase) || (v is ViewSheet sh && sh.SheetNumber == s)))
            ?? throw new InvalidOperationException($"no view or sheet {s}");

        private static JObject InTx(Document doc, Func<JObject> body)
        {
            if (doc.IsModifiable) return body();
            using (var t = new Transaction(doc, "FMC file action"))
            {
                t.Start();
                JObject r = body();
                t.Commit();
                return r;
            }
        }
    }
}
