using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Read for fmc_keynote_place. No transaction. Lists plan views, linked keynote tags in any view, and hosts.
    /// The API cannot create a keynote link. This read does not place a tag.
    /// </summary>
    public class FmcKeynotePlaceHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft keynote place";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            string titleBefore = app.ActiveUIDocument?.Document?.Title ?? "";
            string viewBefore = app.ActiveUIDocument?.ActiveView?.UniqueId ?? "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_keynote_place needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["saved"] = false,
                        ["documents"] = new JArray(Read(doc, Parameters)),
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                        ["images"] = new JArray(),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally
            {
                string titleAfter = app.ActiveUIDocument?.Document?.Title ?? "";
                string viewAfter = app.ActiveUIDocument?.ActiveView?.UniqueId ?? "";
                if (Result != null && string.IsNullOrEmpty(Error))
                    Result["active_unchanged"] = titleBefore == titleAfter && viewBefore == viewAfter;
                _done.Set();
            }
        }

        internal static JObject Read(Document doc, JObject parameters)
        {
            var cats = CategoryIds(doc, parameters["categories"] as JArray);
            var views = new JArray();
            var hosts = new JArray();
            foreach (View view in new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(IsPlan))
            {
                views.Add(new JObject { ["id"] = view.Id.Value.ToString(), ["name"] = view.Name ?? "", ["view_type"] = view.ViewType.ToString(), ["is_plan"] = true });
                foreach (ElementId cat in cats)
                {
                    foreach (Element host in new FilteredElementCollector(doc, view.Id).OfCategoryId(cat).WhereElementIsNotElementType())
                    {
                        hosts.Add(new JObject
                        {
                            ["id"] = host.Id.Value.ToString(),
                            ["category"] = host.Category?.Name ?? "",
                            ["view_id"] = view.Id.Value.ToString(),
                            ["name"] = host.Name ?? "",
                        });
                    }
                }
            }
            var tags = new JArray();
            foreach (IndependentTag tag in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_KeynoteTags).WhereElementIsNotElementType().OfType<IndependentTag>())
            {
                View owner = doc.GetElement(tag.OwnerViewId) as View;
                string hostId = "";
                try
                {
                    foreach (Reference reference in tag.GetTaggedReferences() ?? new List<Reference>())
                        if (reference?.ElementId != null && reference.ElementId != ElementId.InvalidElementId) { hostId = reference.ElementId.Value.ToString(); break; }
                }
                catch (Exception) { hostId = ""; }
                Element type = doc.GetElement(tag.GetTypeId());
                tags.Add(new JObject
                {
                    ["id"] = tag.Id.Value.ToString(),
                    ["view_id"] = owner?.Id.Value.ToString() ?? "",
                    ["view"] = owner?.Name ?? "",
                    ["host"] = hostId,
                    ["key"] = TextKey(tag),
                    ["key_source"] = SourceText(tag),
                    ["tag_type"] = type == null ? "" : type.Name,
                    ["linked"] = !TagTextEmpty(tag),
                });
            }
            return new JObject
            {
                ["title"] = doc.Title ?? "",
                ["path"] = doc.PathName ?? "",
                ["is_central"] = FmcPhaseIds.IsCentral(doc),
                ["views"] = views,
                ["tags"] = tags,
                ["hosts"] = hosts,
            };
        }

        internal static bool IsPlan(View view)
        {
            if (view == null || view.IsTemplate) return false;
            return view.ViewType == ViewType.FloorPlan || view.ViewType == ViewType.CeilingPlan
                || view.ViewType == ViewType.EngineeringPlan || view.ViewType == ViewType.AreaPlan;
        }

        internal static List<ElementId> CategoryIds(Document doc, JArray names)
        {
            var wanted = (names ?? new JArray()).Select(token => token.ToString()).Where(name => name.Trim().Length > 0).ToList();
            if (wanted.Count == 0) wanted = new List<string> { "Walls", "Doors", "Windows", "Floors", "Ceilings", "Rooms" };
            var ids = new List<ElementId>();
            foreach (string name in wanted)
            {
                Category category = null;
                if (Enum.TryParse("OST_" + name.Replace(" ", ""), true, out BuiltInCategory builtIn))
                    category = Category.GetCategory(doc, builtIn);
                category ??= doc.Settings.Categories.Cast<Category>().FirstOrDefault(item => string.Equals(item.Name, name, StringComparison.OrdinalIgnoreCase));
                if (category != null && !ids.Contains(category.Id)) ids.Add(category.Id);
            }
            return ids;
        }

        internal static string SourceText(Element tag)
        {
            Parameter parameter = tag.get_Parameter(BuiltInParameter.KEY_SOURCE_PARAM);
            return (parameter == null ? "" : parameter.AsValueString() ?? "").Trim();
        }

        internal static bool TagTextEmpty(IndependentTag tag)
        {
            try { return string.IsNullOrWhiteSpace(tag.TagText); }
            catch (Exception) { return true; }
        }

        static string TextKey(IndependentTag tag)
        {
            Parameter parameter = tag.get_Parameter(BuiltInParameter.KEYNOTE_TEXT) ?? tag.LookupParameter("Keynote Text");
            return parameter == null ? "" : (parameter.AsString() ?? parameter.AsValueString() ?? "").Trim();
        }
    }

    /// <summary>
    /// One transaction. Copies a linked keynote seed into each target view and retargets the host.
    /// A copy whose TagText is empty is rolled back. Nothing blank is kept.
    /// </summary>
    public class FmcKeynotePlaceApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft keynote place apply";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            string titleBefore = app.ActiveUIDocument?.Document?.Title ?? "";
            string viewBefore = app.ActiveUIDocument?.ActiveView?.UniqueId ?? "";
            Document opened = null;
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_keynote_place_apply needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    Refuse(doc);
                    var viewsOut = new JArray();
                    string code = "";
                    using (var transaction = new Transaction(doc, "Formcraft keynotes"))
                    {
                        transaction.Start();
                        try
                        {
                            IndependentTag seed = ResolveSeed(app, doc, ref opened, out string seedCode, out string seedReason);
                            if (seed == null)
                            {
                                code = seedCode;
                                foreach (JObject view in ViewOps())
                                    viewsOut.Add(new JObject { ["view_id"] = view.Value<string>("view_id"), ["view"] = view.Value<string>("view"), ["placed"] = new JArray(), ["skipped"] = new JArray(new JObject { ["code"] = seedCode, ["reason"] = seedReason }) });
                                transaction.RollBack();
                            }
                            else
                            {
                                View seedView = doc.GetElement(seed.OwnerViewId) as View;
                                ElementId landed = seed.Id;
                                foreach (JObject viewOp in ViewOps())
                                    viewsOut.Add(PlaceView(doc, seed, seedView, viewOp));
                                if ((Parameters["seed"] as JObject)?.Value<string>("route") == "kit")
                                    TryDeleteLanding(doc, landed, viewsOut);
                                transaction.Commit();
                            }
                        }
                        catch
                        {
                            if (transaction.HasStarted() && !transaction.HasEnded()) transaction.RollBack();
                            throw;
                        }
                    }
                    Result = new JObject
                    {
                        ["ok"] = code.Length == 0,
                        ["code"] = code,
                        ["views"] = viewsOut,
                        ["saved"] = false,
                        ["synced"] = false,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally
            {
                try { if (opened != null && opened.IsValidObject) opened.Close(false); } catch (Exception) { /* the seed file is never saved */ }
                string titleAfter = app.ActiveUIDocument?.Document?.Title ?? "";
                string viewAfter = app.ActiveUIDocument?.ActiveView?.UniqueId ?? "";
                if (Result != null && string.IsNullOrEmpty(Error))
                    Result["active_unchanged"] = titleBefore == titleAfter && viewBefore == viewAfter;
                _done.Set();
            }
        }

        private List<JObject> ViewOps() => (Parameters["views"] as JArray ?? new JArray()).OfType<JObject>().ToList();

        private void Refuse(Document doc)
        {
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (Regex.IsMatch(blob, "hebert hostels", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("HEBERT HOSTELS is not written by fmc_keynote_place.");
            if (FmcPhaseIds.IsCentral(doc)) throw new InvalidOperationException("A central model is not written by fmc_keynote_place.");
            if (FmcTarget.IsProtected(doc.PathName ?? "", FmcTarget.Roots(Parameters)))
                throw new InvalidOperationException("The document is under a protected path.");
        }

        private IndependentTag ResolveSeed(UIApplication app, Document doc, ref Document opened, out string code, out string reason)
        {
            code = "";
            reason = "";
            JObject seed = Parameters["seed"] as JObject ?? new JObject();
            string route = (seed.Value<string>("route") ?? "").Trim();
            string by = (Parameters.Value<string>("by") ?? "element").Trim();
            if (route == "document")
            {
                IndependentTag tag = ById(doc, seed.Value<string>("id")) as IndependentTag;
                if (tag == null || FmcKeynotePlaceHandler.TagTextEmpty(tag))
                {
                    code = "FMC-KEYNOTE-SEED-LOAD";
                    reason = "The seed tag is not a linked keynote in this model.";
                    return null;
                }
                return tag;
            }
            string file = (seed.Value<string>("path") ?? "").Trim();
            if (file.Length == 0 || !System.IO.File.Exists(file))
            {
                code = "FMC-KEYNOTE-SEED-MISSING";
                reason = "The kit seed model is not on disk: " + file;
                return null;
            }
            try { opened = app.Application.OpenDocumentFile(file); }
            catch (Exception ex)
            {
                code = "FMC-KEYNOTE-SEED-LOAD";
                reason = ex.Message;
                return null;
            }
            IndependentTag kit = FindLinked(opened, by);
            if (kit == null)
            {
                code = "FMC-KEYNOTE-SEED-LOAD";
                reason = "The kit seed model has no linked " + by + " keynote tag.";
                return null;
            }
            JObject first = ViewOps().FirstOrDefault(view => (view["hosts"] as JArray)?.Count > 0);
            View dest = first == null ? null : ById(doc, first.Value<string>("view_id")) as View;
            if (dest == null)
            {
                code = "FMC-KEYNOTE-VIEW";
                reason = "No target plan was open to receive the kit seed.";
                return null;
            }
            View sourceView = opened.GetElement(kit.OwnerViewId) as View;
            ICollection<ElementId> copied = CopyTag(opened, sourceView, kit.Id, doc, dest, out string copyCode, out string copyReason);
            if (copied == null)
            {
                code = copyCode;
                reason = copyReason;
                return null;
            }
            IndependentTag landed = copied.Select(id => doc.GetElement(id)).OfType<IndependentTag>().FirstOrDefault();
            if (landed == null || FmcKeynotePlaceHandler.TagTextEmpty(landed))
            {
                code = "FMC-NO-API-KEYNOTE-LINK";
                reason = "Copying the kit seed did not keep a keynote link (TagText empty). Nothing was kept.";
                return null;
            }
            return landed;
        }

        private static IndependentTag FindLinked(Document doc, string by)
        {
            foreach (IndependentTag tag in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_KeynoteTags).WhereElementIsNotElementType().OfType<IndependentTag>())
            {
                if (FmcKeynotePlaceHandler.TagTextEmpty(tag)) continue;
                string source = FmcKeynotePlaceHandler.SourceText(tag);
                string type = doc.GetElement(tag.GetTypeId())?.Name ?? "";
                if ((source + " " + type).IndexOf(by, StringComparison.OrdinalIgnoreCase) >= 0) return tag;
            }
            return null;
        }

        private JObject PlaceView(Document doc, IndependentTag seed, View seedView, JObject viewOp)
        {
            var placed = new JArray();
            var skipped = new JArray();
            View view = ById(doc, viewOp.Value<string>("view_id")) as View;
            if (view == null || !FmcKeynotePlaceHandler.IsPlan(view))
            {
                skipped.Add(new JObject { ["code"] = "FMC-KEYNOTE-VIEW", ["reason"] = "That view is not an open plan." });
                return new JObject { ["view_id"] = viewOp.Value<string>("view_id"), ["view"] = viewOp.Value<string>("view"), ["placed"] = placed, ["skipped"] = skipped };
            }
            foreach (string hostId in (viewOp["hosts"] as JArray ?? new JArray()).Select(token => token.ToString()))
            {
                Element host = ById(doc, hostId);
                if (host == null)
                {
                    skipped.Add(new JObject { ["host"] = hostId, ["code"] = "FMC-KEYNOTE-NO-HOST", ["reason"] = "The host is not in this model." });
                    continue;
                }
                if (seedView == null)
                {
                    skipped.Add(new JObject { ["host"] = hostId, ["code"] = "FMC-KEYNOTE-COPY-REFUSED", ["reason"] = "The seed tag has no owner view." });
                    continue;
                }
                using (var sub = new SubTransaction(doc))
                {
                    sub.Start();
                    try
                    {
                        ICollection<ElementId> copied;
                        if (seedView != null && seedView.Id != view.Id)
                        {
                            copied = CopyTag(doc, seedView, seed.Id, doc, view, out string copyCode, out string copyReason);
                            if (copied == null)
                            {
                                sub.RollBack();
                                skipped.Add(new JObject { ["host"] = hostId, ["code"] = copyCode.Length == 0 ? "FMC-KEYNOTE-COPY-REFUSED" : copyCode, ["reason"] = copyReason.Length == 0 ? "CopyElements was refused." : copyReason });
                                continue;
                            }
                        }
                        else copied = ElementTransformUtils.CopyElement(doc, seed.Id, XYZ.Zero);
                        if (copied == null)
                        {
                            sub.RollBack();
                            skipped.Add(new JObject { ["host"] = hostId, ["code"] = "FMC-KEYNOTE-COPY-REFUSED", ["reason"] = "CopyElements was refused." });
                            continue;
                        }
                        IndependentTag copy = copied.Select(id => doc.GetElement(id)).OfType<IndependentTag>().FirstOrDefault();
                        if (copy == null)
                        {
                            sub.RollBack();
                            skipped.Add(new JObject { ["host"] = hostId, ["code"] = "FMC-KEYNOTE-COPY-REFUSED", ["reason"] = "The copy was not a keynote tag." });
                            continue;
                        }
                        IList<Reference> oldRefs = copy.GetTaggedReferences();
                        if (oldRefs != null && oldRefs.Count > 0) copy.RemoveReferences(oldRefs);
                        copy.AddReferences(new List<Reference> { new Reference(host) });
                        try { copy.TagHeadPosition = Where(host); } catch (Exception) { /* the head stays where the copy landed */ }
                        doc.Regenerate();
                        bool points = false;
                        foreach (Reference reference in copy.GetTaggedReferences() ?? new List<Reference>())
                            if (reference != null && reference.ElementId == host.Id) points = true;
                        if (points && !FmcKeynotePlaceHandler.TagTextEmpty(copy))
                        {
                            sub.Commit();
                            placed.Add(new JObject { ["host"] = hostId, ["tag"] = copy.Id.Value.ToString() });
                        }
                        else
                        {
                            sub.RollBack();
                            string fail = FmcKeynotePlaceHandler.TagTextEmpty(copy) ? "FMC-NO-API-KEYNOTE-LINK" : "FMC-KEYNOTE-RETARGET-REFUSED";
                            string why = fail == "FMC-NO-API-KEYNOTE-LINK"
                                ? "The copy did not keep a keynote link (TagText empty). Nothing blank was kept."
                                : "The copied tag does not point at the host.";
                            skipped.Add(new JObject { ["host"] = hostId, ["code"] = fail, ["reason"] = why });
                        }
                    }
                    catch (Exception ex)
                    {
                        try { if (sub.HasStarted()) sub.RollBack(); } catch (Exception) { }
                        string fail = ex.Message.IndexOf("FMC-", StringComparison.Ordinal) >= 0 ? "FMC-KEYNOTE-RETARGET-REFUSED" : "FMC-KEYNOTE-COPY-REFUSED";
                        skipped.Add(new JObject { ["host"] = hostId, ["code"] = fail, ["reason"] = ex.Message });
                    }
                }
            }
            return new JObject { ["view_id"] = view.Id.Value.ToString(), ["view"] = view.Name, ["placed"] = placed, ["skipped"] = skipped };
        }

        /// <summary>View-to-view when both views are in one document. Otherwise the document overload. A refusal is a code, not a blank tag.</summary>
        private static void TryDeleteLanding(Document doc, ElementId landed, JArray views)
        {
            foreach (JObject view in views.OfType<JObject>())
                foreach (JObject placed in (view["placed"] as JArray ?? new JArray()).OfType<JObject>())
                    if (placed.Value<string>("tag") == landed.Value.ToString()) return;
            try { doc.Delete(landed); } catch (Exception) { /* the landing tag stays if Revit will not delete it */ }
        }

        private static ICollection<ElementId> CopyTag(Document sourceDoc, View sourceView, ElementId id, Document destDoc, View destView, out string code, out string reason)
        {
            code = "";
            reason = "";
            var ids = new List<ElementId> { id };
            var options = new CopyPasteOptions();
            try
            {
                if (sourceDoc.Equals(destDoc) && sourceView != null && destView != null)
                    return ElementTransformUtils.CopyElements(sourceView, ids, destView, Transform.Identity, options);
            }
            catch (Exception ex)
            {
                code = "FMC-KEYNOTE-COPY-REFUSED";
                reason = ex.Message;
            }
            try
            {
                if (!sourceDoc.Equals(destDoc))
                    return ElementTransformUtils.CopyElements(sourceDoc, ids, destDoc, Transform.Identity, options);
            }
            catch (Exception ex)
            {
                code = "FMC-KEYNOTE-COPY-REFUSED";
                reason = reason.Length == 0 ? ex.Message : reason + " " + ex.Message;
            }
            return code.Length == 0 ? null : null;
        }

        private static Element ById(Document doc, string id)
        {
            if (string.IsNullOrWhiteSpace(id) || !long.TryParse(id, out long value)) return null;
            return doc.GetElement(new ElementId(value));
        }

        private static XYZ Where(Element element)
        {
            if (element.Location is LocationPoint point) return point.Point;
            if (element.Location is LocationCurve curve) return curve.Curve.Evaluate(0.5, true);
            BoundingBoxXYZ box = element.get_BoundingBox(null);
            return box == null ? XYZ.Zero : (box.Min + box.Max) / 2;
        }
    }
}
