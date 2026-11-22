using System.IO;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Places kit details into the open project. One transaction, one subtransaction per detail.
    /// The kit source is opened in the background and closed without saving. The kit file is not edited.
    /// OpenOptions has no read-only flag. A workshared source is detached and its worksets are discarded, so the central is not touched.
    /// </summary>
    public class FmcDetailsApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft details apply";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_details_apply needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    Refuse(doc, Parameters);
                    var placed = new JArray();
                    var skipped = new JArray();
                    using (var transaction = new Transaction(doc, "Formcraft details"))
                    {
                        var options = transaction.GetFailureHandlingOptions();
                        options.SetFailuresPreprocessor(new Quiet());
                        options.SetClearAfterRollback(true);
                        transaction.SetFailureHandlingOptions(options);
                        transaction.Start();
                        try
                        {
                            foreach (JObject op in (Parameters["ops"] as JArray ?? new JArray()).OfType<JObject>())
                            {
                                using (var sub = new SubTransaction(doc))
                                {
                                    sub.Start();
                                    try
                                    {
                                        placed.Add(Place(app, doc, op));
                                        sub.Commit();
                                    }
                                    catch (Exception ex)
                                    {
                                        if (sub.HasStarted() && !sub.HasEnded()) sub.RollBack();
                                        skipped.Add(new JObject
                                        {
                                            ["detail_id"] = op.Value<string>("detail_id") ?? "",
                                            ["code"] = CodeOf(ex.Message),
                                            ["message"] = ex.Message,
                                        });
                                    }
                                }
                            }
                            transaction.Commit();
                        }
                        catch
                        {
                            if (transaction.HasStarted() && !transaction.HasEnded()) transaction.RollBack();
                            throw;
                        }
                    }
                    Result = new JObject
                    {
                        ["ok"] = true,
                        ["read_only"] = false,
                        ["saved"] = false,
                        ["synced"] = false,
                        ["kit_saved"] = false,
                        ["placed"] = placed,
                        ["skipped"] = skipped,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                        ["is_central"] = false,
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static JObject Place(UIApplication app, Document doc, JObject op)
        {
            string id = op.Value<string>("detail_id") ?? "";
            string source = op.Value<string>("source") ?? "";
            string kind = (op.Value<string>("kind") ?? "drafting").Trim();
            string viewName = op.Value<string>("view_name") ?? ("DET " + id);
            string sheetKey = op.Value<string>("sheet") ?? "";
            if (string.IsNullOrWhiteSpace(source)) throw new InvalidOperationException("[FMC-DETAIL-SOURCE] " + id + " has no source file.");
            if (FmcTarget.Same(doc, source)) throw new InvalidOperationException("[FMC-DETAIL-SOURCE] The source is the document being written. Refusing to copy a view onto itself.");
            ViewDrafting view = FindDrafting(doc, viewName);
            bool created = false;
            if (view == null)
            {
                ViewFamilyType vft = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>()
                    .FirstOrDefault(t => t.ViewFamily == ViewFamily.Drafting);
                if (vft == null) throw new InvalidOperationException("[FMC-DETAIL-NO-VIEWTYPE] The project has no drafting view type.");
                view = ViewDrafting.Create(doc, vft.Id);
                view.Name = viewName;
                created = true;
            }
            int copied = 0;
            string sourceClosed = "not-opened";
            if (!created && HasGraphics(doc, view)) sourceClosed = "view-reused";
            else if (kind == "family" || source.EndsWith(".rfa", StringComparison.OrdinalIgnoreCase))
            {
                copied = PlaceFamily(doc, source, op.Value<string>("type_name") ?? "", view);
                sourceClosed = "family-not-saved";
            }
            else
            {
                bool opened = false;
                Document src = null;
                try
                {
                    src = OpenSource(app, source, out opened);
                    View from = SourceView(src, op.Value<string>("view") ?? "");
                    var ids = new FilteredElementCollector(src, from.Id).WhereElementIsNotElementType().Where(Graphic).Select(e => e.Id).ToList();
                    if (ids.Count == 0) throw new InvalidOperationException("[FMC-DETAIL-EMPTY] " + id + " has no detail components, lines, text or filled regions in " + from.Name + ".");
                    var copies = ElementTransformUtils.CopyElements(from, ids, view, Transform.Identity, new CopyPasteOptions());
                    copied = copies?.Count ?? 0;
                    if (copied == 0) throw new InvalidOperationException("[FMC-DETAIL-COPY] CopyElements returned nothing for " + id + ".");
                }
                finally
                {
                    if (opened && src != null)
                    {
                        src.Close(false);
                        sourceClosed = "closed-without-save";
                    }
                    else sourceClosed = "already-open-not-closed";
                }
            }
            var row = new JObject
            {
                ["detail_id"] = id,
                ["view_id"] = view.Id.Value.ToString(),
                ["view_name"] = view.Name,
                ["created_view"] = created,
                ["copied"] = copied,
                ["source_closed"] = sourceClosed,
                ["kit_saved"] = false,
            };
            if (!string.IsNullOrWhiteSpace(sheetKey)) row["sheet"] = PlaceOnSheet(doc, view, sheetKey);
            return row;
        }

        private static int PlaceFamily(Document doc, string path, string typeName, View view)
        {
            string name = Path.GetFileNameWithoutExtension(path);
            Family family = new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>()
                .FirstOrDefault(f => string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase));
            if (family == null)
            {
                if (!File.Exists(path)) throw new InvalidOperationException("[FMC-DETAIL-SOURCE] File not found: " + path);
                doc.LoadFamily(path, new KeepExisting(), out family);
                if (family == null)
                    family = new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>()
                        .FirstOrDefault(f => string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase));
            }
            if (family == null) throw new InvalidOperationException("[FMC-DETAIL-SOURCE] Revit did not load " + path + ".");
            FamilySymbol symbol = null;
            foreach (ElementId sid in family.GetFamilySymbolIds())
            {
                if (doc.GetElement(sid) is FamilySymbol candidate && (typeName.Length == 0 || string.Equals(candidate.Name, typeName, StringComparison.OrdinalIgnoreCase)))
                {
                    symbol = candidate;
                    break;
                }
            }
            if (symbol == null) throw new InvalidOperationException("[FMC-DETAIL-TYPE] " + name + " has no type" + (typeName.Length > 0 ? " named " + typeName : "") + ".");
            if (!symbol.IsActive) symbol.Activate();
            FamilyInstance inst = doc.Create.NewFamilyInstance(XYZ.Zero, symbol, view);
            if (inst == null) throw new InvalidOperationException("[FMC-DETAIL-PLACE] Revit did not place " + name + " in the drafting view.");
            return 1;
        }

        private static Document OpenSource(UIApplication app, string path, out bool openedHere)
        {
            foreach (Document open in app.Application.Documents)
            {
                if (FmcTarget.Same(open, path)) { openedHere = false; return open; }
            }
            if (!File.Exists(path)) throw new InvalidOperationException("[FMC-DETAIL-SOURCE] File not found: " + path);
            ModelPath modelPath = ModelPathUtils.ConvertUserVisiblePathToModelPath(path);
            var options = new OpenOptions { Audit = false };
            try
            {
                if (BasicFileInfo.Extract(path).IsWorkshared)
                    options.DetachFromCentralOption = DetachFromCentralOption.DetachAndDiscardWorksets;
            }
            catch (Exception) { /* not a workshared project */ }
            openedHere = true;
            return app.Application.OpenDocumentFile(modelPath, options);
        }

        private static View SourceView(Document src, string name)
        {
            var views = new FilteredElementCollector(src).OfClass(typeof(View)).Cast<View>()
                .Where(v => !v.IsTemplate && (v is ViewDrafting || v.ViewType == ViewType.Detail))
                .ToList();
            if (name.Length > 0)
            {
                View named = views.FirstOrDefault(v => string.Equals(v.Name, name, StringComparison.OrdinalIgnoreCase));
                if (named == null) throw new InvalidOperationException("[FMC-DETAIL-VIEW] The source has no drafting or detail view named " + name + ".");
                return named;
            }
            if (views.Count == 1) return views[0];
            string list = string.Join(", ", views.Take(20).Select(v => v.Name));
            throw new InvalidOperationException("[FMC-DETAIL-VIEW] The source has " + views.Count + " drafting or detail views (" + list + "). Name one in the catalogue.");
        }

        private static ViewDrafting FindDrafting(Document doc, string name)
        {
            return new FilteredElementCollector(doc).OfClass(typeof(ViewDrafting)).Cast<ViewDrafting>()
                .FirstOrDefault(v => !v.IsTemplate && string.Equals(v.Name, name, StringComparison.OrdinalIgnoreCase));
        }

        private static bool HasGraphics(Document doc, View view)
        {
            return new FilteredElementCollector(doc, view.Id).WhereElementIsNotElementType().Any(Graphic);
        }

        private static bool Graphic(Element element)
        {
            if (element?.Category == null) return false;
            long id = element.Category.Id.Value;
            return id == (long)BuiltInCategory.OST_DetailComponents
                || id == (long)BuiltInCategory.OST_Lines
                || id == (long)BuiltInCategory.OST_TextNotes
                || id == (long)BuiltInCategory.OST_FilledRegion;
        }

        private static JObject PlaceOnSheet(Document doc, View view, string key)
        {
            ViewSheet sheet = new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>()
                .FirstOrDefault(s => string.Equals(s.SheetNumber, key, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(s.Name, key, StringComparison.OrdinalIgnoreCase)
                    || s.Id.Value.ToString() == key);
            if (sheet == null) return new JObject { ["code"] = "FMC-DETAIL-SHEET", ["message"] = "No sheet matches " + key + ". The drafting view was still created." };
            if (!Viewport.CanAddViewToSheet(doc, sheet.Id, view.Id))
                return new JObject { ["code"] = "FMC-DETAIL-SHEET", ["sheet"] = sheet.SheetNumber, ["message"] = view.Name + " is already on a sheet, or Revit will not place it." };
            BoundingBoxUV outline = sheet.Outline;
            XYZ at = new XYZ((outline.Min.U + outline.Max.U) / 2, (outline.Min.V + outline.Max.V) / 2, 0);
            Viewport port = Viewport.Create(doc, sheet.Id, view.Id, at);
            return new JObject { ["sheet"] = sheet.SheetNumber, ["viewport_id"] = port.Id.Value.ToString() };
        }

        private static void Refuse(Document doc, JObject parameters)
        {
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (System.Text.RegularExpressions.Regex.IsMatch(blob, "hebert hostels", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                throw new InvalidOperationException("HEBERT HOSTELS is not written by fmc_details.");
            if (FmcPhaseIds.IsCentral(doc)) throw new InvalidOperationException("A central model is not written by fmc_details.");
            if (FmcTarget.IsProtected(doc.PathName ?? "", FmcTarget.Roots(parameters)))
                throw new InvalidOperationException("The document is under a protected path.");
            if (KitOriginal(doc.PathName ?? "")) throw new InvalidOperationException("A kit original is not written by fmc_details.");
        }

        private static bool KitOriginal(string filePath)
        {
            string norm = (filePath ?? "").Replace('/', '\\');
            if (norm.IndexOf("\\_Staging\\", StringComparison.OrdinalIgnoreCase) >= 0) return false;
            if (norm.IndexOf("\\_ChainTests\\", StringComparison.OrdinalIgnoreCase) >= 0) return false;
            return norm.IndexOf("\\04_Families\\", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static string CodeOf(string message)
        {
            var match = System.Text.RegularExpressions.Regex.Match(message ?? "", @"FMC-[A-Z0-9-]+");
            return match.Success ? match.Value : "FMC-DETAIL-COPY";
        }

        private sealed class Quiet : IFailuresPreprocessor
        {
            public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor)
            {
                foreach (FailureMessageAccessor message in accessor.GetFailureMessages())
                    if (message.GetSeverity() == FailureSeverity.Warning) accessor.DeleteWarning(message);
                return FailureProcessingResult.Continue;
            }
        }

        private sealed class KeepExisting : IFamilyLoadOptions
        {
            public bool OnFamilyFound(bool familyInUse, out bool overwriteParameterValues)
            {
                overwriteParameterValues = false;
                return false;
            }

            public bool OnSharedFamilyFound(Family sharedFamily, bool familyInUse, out FamilySource source, out bool overwriteParameterValues)
            {
                source = FamilySource.Project;
                overwriteParameterValues = false;
                return false;
            }
        }
    }
}
