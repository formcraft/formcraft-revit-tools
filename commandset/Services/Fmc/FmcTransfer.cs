using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>GAP-13 read: view templates, filters, legends, revisions and sheets in two open documents. No transaction.</summary>
    public class FmcTransferReadHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft transfer read";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                var p = (JObject)(Parameters ?? new JObject()).DeepClone();
                p["document"] = (p.Value<string>("target") ?? "").Trim();
                if ((p.Value<string>("document") ?? "").Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_transfer needs target. Refusing to use the active document.");
                var kinds = new HashSet<string>((p["kinds"] as JArray)?.Select(k => k.ToString()) ?? new[] { "view_templates", "filters", "legends", "revisions", "sheets" });
                using (FmcTarget target = FmcTarget.Resolve(app, p, mayOpen: false))
                {
                    Document source = FmcGap.FindOpen(app, p.Value<string>("source"), "source");
                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["source"] = FmcTransferRead.Describe(source, kinds),
                        ["target"] = FmcTransferRead.Describe(target.Doc, kinds),
                        ["resolved_document"] = FmcTarget.Resolved(target.Doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }
    }

    internal static class FmcTransferRead
    {
        public static JObject Describe(Document doc, HashSet<string> kinds)
        {
            var items = new JArray();
            if (kinds.Contains("view_templates"))
                foreach (View v in new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(v => v.IsTemplate))
                    items.Add(Item(v.Id, "view_templates", v.Name, v.Name, v.ViewType.ToString()));
            if (kinds.Contains("filters"))
                foreach (FilterElement f in new FilteredElementCollector(doc).OfClass(typeof(FilterElement)).Cast<FilterElement>())
                {
                    string sig = f.GetType().Name;
                    if (f is ParameterFilterElement pf)
                        sig += ":" + string.Join(",", pf.GetCategories().Select(c => c.Value).OrderBy(c => c));
                    items.Add(Item(f.Id, "filters", f.Name, f.Name, sig));
                }
            if (kinds.Contains("legends"))
                foreach (View v in new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(v => !v.IsTemplate && v.ViewType == ViewType.Legend))
                    items.Add(Item(v.Id, "legends", v.Name, v.Name, ""));
            if (kinds.Contains("revisions"))
                foreach (Revision r in new FilteredElementCollector(doc).OfClass(typeof(Revision)).Cast<Revision>())
                {
                    var row = Item(r.Id, "revisions", r.Description ?? "", (r.Description ?? "") + "|" + (r.RevisionDate ?? ""), (r.IssuedTo ?? "") + "|" + (r.IssuedBy ?? ""));
                    row["detail"] = new JObject { ["sequence"] = r.SequenceNumber, ["issued"] = r.Issued, ["date"] = r.RevisionDate ?? "" };
                    items.Add(row);
                }
            if (kinds.Contains("sheets"))
                foreach (ViewSheet s in new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>().Where(s => !s.IsTemplate && !s.IsPlaceholder))
                {
                    var row = Item(s.Id, "sheets", s.Name, s.SheetNumber, s.Name);
                    row["detail"] = new JObject { ["views"] = s.GetAllPlacedViews().Count, ["title_block"] = TitleBlockName(doc, s) };
                    items.Add(row);
                }
            return new JObject
            {
                ["title"] = doc.Title ?? "",
                ["path"] = doc.PathName ?? "",
                ["is_central"] = FmcPhaseIds.IsCentral(doc),
                ["project_number"] = doc.ProjectInformation?.Number ?? "",
                ["items"] = items,
            };
        }

        private static JObject Item(ElementId id, string kind, string name, string key, string signature)
        {
            return new JObject { ["id"] = FmcGap.Id(id), ["kind"] = kind, ["name"] = name ?? "", ["key"] = key ?? "", ["signature"] = signature ?? "" };
        }

        public static string TitleBlockName(Document doc, ViewSheet sheet)
        {
            var tb = new FilteredElementCollector(doc, sheet.Id).OfCategory(BuiltInCategory.OST_TitleBlocks).WhereElementIsNotElementType().FirstOrDefault() as FamilyInstance;
            return tb == null ? "" : (tb.Symbol?.FamilyName ?? "") + ": " + (tb.Symbol?.Name ?? "");
        }
    }

    /// <summary>
    /// GAP-13 apply: one transaction in the target, one subtransaction per item. A name or number already in the target is
    /// skipped, never overwritten. Templates, filters and legends use ElementTransformUtils.CopyElements with the target's
    /// types kept. Revisions are created unissued. Sheets are created with the same title block type when the target has it,
    /// without their views.
    /// </summary>
    public class FmcTransferApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft transfer apply";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                var p = (JObject)(Parameters ?? new JObject()).DeepClone();
                p["document"] = (p.Value<string>("target") ?? "").Trim();
                if ((p.Value<string>("document") ?? "").Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_transfer_apply needs target. Refusing to use the active document.");
                using (FmcTarget t = FmcTarget.Resolve(app, p, mayOpen: false))
                {
                    Document target = t.Doc;
                    Document source = FmcGap.FindOpen(app, p.Value<string>("source"), "source");
                    if (source.Equals(target)) throw new InvalidOperationException("[FMC-TRANSFER-PROJECT] Source and target are the same document.");
                    FmcGap.RefuseWrite(target, p, "fmc_transfer");
                    var applied = new JArray();
                    var skipped = new JArray();
                    var now = FmcTransferRead.Describe(target, new HashSet<string> { "view_templates", "filters", "legends", "revisions", "sheets" });
                    var taken = new HashSet<string>(((JArray)now["items"]).Select(i => i.Value<string>("kind") + "\u0001" + (i.Value<string>("key") ?? "").ToLowerInvariant()));
                    using (var transaction = new Transaction(target, "Formcraft transfer"))
                    {
                        transaction.Start();
                        try
                        {
                            foreach (JObject op in (p["ops"] as JArray ?? new JArray()).OfType<JObject>())
                                One(source, target, op, taken, applied, skipped);
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
                        ["applied"] = applied,
                        ["skipped"] = skipped,
                        ["saved"] = false,
                        ["synced"] = false,
                        ["resolved_document"] = FmcTarget.Resolved(target),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static void One(Document source, Document target, JObject op, HashSet<string> taken, JArray applied, JArray skipped)
        {
            string kind = op.Value<string>("kind") ?? "";
            string name = op.Value<string>("name") ?? "";
            string key = op.Value<string>("key") ?? name;
            var row = new JObject { ["kind"] = kind, ["name"] = name, ["key"] = key };
            if (taken.Contains(kind + "\u0001" + key.ToLowerInvariant()))
            {
                row["code"] = "FMC-TRANSFER-DUPLICATE";
                skipped.Add(row);
                return;
            }
            Element element = source.GetElement(FmcGap.IdOf(op.Value<string>("source_id")));
            if (element == null)
            {
                row["code"] = "FMC-TRANSFER-GONE";
                row["reason"] = "The source item is no longer in the source document.";
                skipped.Add(row);
                return;
            }
            using (var sub = new SubTransaction(target))
            {
                sub.Start();
                try
                {
                    var created = new JArray();
                    var notes = new JArray();
                    if (kind == "view_templates" || kind == "filters" || kind == "legends")
                    {
                        var options = new CopyPasteOptions();
                        options.SetDuplicateTypeNamesHandler(new FmcUseDestinationTypes());
                        ICollection<ElementId> ids = ElementTransformUtils.CopyElements(source, new List<ElementId> { element.Id }, target, Transform.Identity, options);
                        foreach (ElementId id in ids) created.Add(FmcGap.Id(id));
                        if (kind == "view_templates" && element is View tv)
                            try { foreach (ElementId f in tv.GetFilters()) notes.Add("filter " + FmcGap.NameOf(source, f) + " comes with the template"); } catch (Exception) { /* no filters on this view type */ }
                    }
                    else if (kind == "revisions" && element is Revision r)
                    {
                        Revision made = Revision.Create(target);
                        made.Description = r.Description;
                        made.RevisionDate = r.RevisionDate;
                        made.IssuedBy = r.IssuedBy;
                        made.IssuedTo = r.IssuedTo;
                        created.Add(FmcGap.Id(made.Id));
                        notes.Add("created unissued; numbering follows the target's sequence");
                    }
                    else if (kind == "sheets" && element is ViewSheet s)
                    {
                        string tb = FmcTransferRead.TitleBlockName(source, s);
                        ElementId tbType = ElementId.InvalidElementId;
                        if (tb.Length > 0)
                        {
                            var match = new FilteredElementCollector(target).OfCategory(BuiltInCategory.OST_TitleBlocks).WhereElementIsElementType().Cast<FamilySymbol>()
                                .FirstOrDefault(fs => string.Equals((fs.FamilyName ?? "") + ": " + (fs.Name ?? ""), tb, StringComparison.OrdinalIgnoreCase));
                            if (match != null) tbType = match.Id; else notes.Add("title block " + tb + " is not loaded in the target; the sheet has none");
                        }
                        ViewSheet made = ViewSheet.Create(target, tbType);
                        made.SheetNumber = s.SheetNumber;
                        made.Name = s.Name;
                        created.Add(FmcGap.Id(made.Id));
                        int views = s.GetAllPlacedViews().Count;
                        if (views > 0) notes.Add(views + " placed view(s) not copied");
                    }
                    else throw new InvalidOperationException("[FMC-TRANSFER-KIND] kind is view_templates, filters, legends, revisions or sheets, and must match the source element.");
                    sub.Commit();
                    taken.Add(kind + "\u0001" + key.ToLowerInvariant());
                    row["created"] = created;
                    row["notes"] = notes;
                    applied.Add(row);
                }
                catch (Exception ex)
                {
                    if (sub.HasStarted() && !sub.HasEnded()) sub.RollBack();
                    row["code"] = "FMC-TRANSFER-FAILED";
                    row["reason"] = ex.Message;
                    skipped.Add(row);
                }
            }
        }
    }
}
