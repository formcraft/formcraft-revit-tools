using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// One transaction. Duplicates a legend view, or copies seed components and retypes them.
    /// There is no API to create a LegendComponent or a ViewLegend. No text notes are created.
    /// Each placed component is its own SubTransaction: a rejected parameter rolls that component back and the rest continue.
    /// </summary>
    public class FmcLegendApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft legend apply";

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
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_legend_apply needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    if (doc.IsFamilyDocument) throw new InvalidOperationException("[FMC-LEGEND] fmc_legend place runs on a project model.");
                    Refuse(doc);
                    string action = (Parameters.Value<string>("action") ?? "").Trim();
                    if (action == "create_view") Result = CreateView(app, doc);
                    else if (action == "place") Result = Place(app, doc);
                    else throw new InvalidOperationException("[FMC-LEGEND] fmc_legend_apply knows create_view and place.");
                    Result["saved"] = false;
                    Result["synced"] = false;
                    Result["free_text"] = false;
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
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

        private void Refuse(Document doc)
        {
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (Regex.IsMatch(blob, "hebert hostels", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("HEBERT HOSTELS is not written by fmc_legend.");
            if (FmcPhaseIds.IsCentral(doc)) throw new InvalidOperationException("A central model is not written by fmc_legend.");
            if (FmcTarget.IsProtected(doc.PathName ?? "", FmcTarget.Roots(Parameters)))
                throw new InvalidOperationException("The document is under a protected path.");
        }

        private JObject CreateView(UIApplication app, Document doc)
        {
            string name = (Parameters.Value<string>("name") ?? "").Trim();
            if (name.Length == 0) return Fail("FMC-LEGEND-NAME", "create_view needs name.");
            if (LegendNamed(doc, name) != null) return Fail("FMC-LEGEND-NAME-TAKEN", "A view already has that name. This tool does not delete it.");
            string sourceKey = (Parameters.Value<string>("source_document") ?? "").Trim();
            bool other = sourceKey.Length > 0 && !FmcTarget.Same(doc, sourceKey);
            Document src = other ? FmcLegendRead.Find(app, sourceKey) : doc;
            View seed = FindLegend(src, Parameters.Value<string>("seed_view_id") ?? Parameters.Value<string>("seed_view") ?? "");
            if (seed == null) return Fail("FMC-LEGEND-NO-VIEW", "Revit will not create a ViewLegend. No seed legend view was found.");
            string option = (Parameters.Value<string>("duplicate") ?? "duplicate").Trim();
            using (var transaction = new Transaction(doc, "Formcraft legend"))
            {
                transaction.Start();
                try
                {
                    View created;
                    if (!other)
                    {
                        var mode = option == "with_detailing" ? ViewDuplicateOption.WithDetailing : ViewDuplicateOption.Duplicate;
                        created = doc.GetElement(seed.Duplicate(mode)) as View;
                    }
                    else
                    {
                        ICollection<ElementId> copied;
                        try
                        {
                            copied = ElementTransformUtils.CopyElements(src, new List<ElementId> { seed.Id }, doc, Transform.Identity, new CopyPasteOptions());
                        }
                        catch (Exception ex)
                        {
                            transaction.RollBack();
                            return Fail("FMC-LEGEND-COPY-REFUSED", "Revit refused to copy the legend view. " + ex.Message);
                        }
                        if (copied == null || copied.Count == 0)
                        {
                            transaction.RollBack();
                            return Fail("FMC-LEGEND-COPY-REFUSED", "Revit returned no element from the legend-view copy.");
                        }
                        created = doc.GetElement(copied.First()) as View;
                        if (created == null || created.ViewType != ViewType.Legend)
                        {
                            transaction.RollBack();
                            return Fail("FMC-LEGEND-COPY-REFUSED", "Revit copied an element that is not a legend view.");
                        }
                    }
                    if (created == null)
                    {
                        transaction.RollBack();
                        return Fail("FMC-LEGEND-COPY-REFUSED", "Duplicate returned no view.");
                    }
                    created.Name = name;
                    transaction.Commit();
                    return new JObject
                    {
                        ["ok"] = true,
                        ["action"] = "create_view",
                        ["view_id"] = created.Id.Value.ToString(),
                        ["name"] = created.Name,
                        ["duplicate"] = other ? "copy_elements" : option,
                        ["same_document"] = !other,
                    };
                }
                catch (Exception ex)
                {
                    if (transaction.HasStarted() && !transaction.HasEnded()) transaction.RollBack();
                    return Fail("FMC-LEGEND-COPY-REFUSED", ex.Message);
                }
            }
        }

        private JObject Place(UIApplication app, Document doc)
        {
            View legend = FindLegend(doc, Parameters.Value<string>("view_id") ?? Parameters.Value<string>("view") ?? "");
            if (legend == null) return Fail("FMC-LEGEND-NO-VIEW", "The legend view is not in this document.");
            string sourceKey = (Parameters.Value<string>("source_document") ?? "").Trim();
            bool other = sourceKey.Length > 0 && !FmcTarget.Same(doc, sourceKey);
            Document src = other ? FmcLegendRead.Find(app, sourceKey) : doc;
            Element seed = FindId(src, Parameters.Value<string>("seed_id") ?? "");
            if (seed == null || seed.Category == null || seed.Category.Id.Value != (long)BuiltInCategory.OST_LegendComponents)
                return Fail("FMC-LEGEND-NO-SEED", "place one legend component by hand once");
            View seedView = src.GetElement(seed.OwnerViewId) as View;
            if (seedView == null) return Fail("FMC-LEGEND-NO-SEED", "The seed component has no owner view.");
            int scale = legend.Scale > 0 ? legend.Scale : 1;
            string label = (Parameters.Value<string>("label_mode") ?? "").Trim();
            if (label.Length == 0 && Parameters["label"] is JObject labelObj) label = labelObj.Value<string>("mode") ?? "none";
            if (label.Length == 0) label = "none";
            var placed = new JArray();
            var skipped = new JArray();
            var marks = new JArray();
            bool labelPossible = label == "none";
            string labelReason = "";
            using (var transaction = new Transaction(doc, "Formcraft legend"))
            {
                transaction.Start();
                try
                {
                    foreach (JObject item in (Parameters["items"] as JArray ?? new JArray()).OfType<JObject>())
                    {
                        using (var sub = new SubTransaction(doc))
                        {
                            sub.Start();
                            try
                            {
                                JObject row = PlaceOne(doc, legend, seed, seedView, item, scale, label, marks, ref labelPossible, ref labelReason);
                                if (row.Value<bool?>("ok") == true) { sub.Commit(); placed.Add(row); }
                                else { sub.RollBack(); skipped.Add(row); }
                            }
                            catch (Exception ex)
                            {
                                if (sub.HasStarted() && !sub.HasEnded()) sub.RollBack();
                                skipped.Add(new JObject { ["ok"] = false, ["type_id"] = item.Value<string>("type_id"), ["error"] = ex.Message, ["code"] = "FMC-LEGEND-COPY-REFUSED" });
                            }
                        }
                    }
                    transaction.Commit();
                }
                catch (Exception ex)
                {
                    if (transaction.HasStarted() && !transaction.HasEnded()) transaction.RollBack();
                    return Fail("FMC-LEGEND-COPY-REFUSED", ex.Message);
                }
            }
            return new JObject
            {
                ["ok"] = true,
                ["action"] = "place",
                ["view_id"] = legend.Id.Value.ToString(),
                ["placed"] = placed,
                ["skipped"] = skipped,
                ["type_marks"] = marks,
                ["label_possible"] = label == "none" ? true : labelPossible,
                ["label_reason"] = labelReason,
                ["free_text"] = false,
            };
        }

        private static JObject PlaceOne(Document doc, View legend, Element seed, View seedView, JObject item, int scale, string label, JArray marks, ref bool labelPossible, ref string labelReason)
        {
            string typeKey = item.Value<string>("type_id") ?? "";
            if (!long.TryParse(typeKey, out long typeValue))
                return new JObject { ["ok"] = false, ["code"] = "FMC-LEGEND-CATEGORY", ["type_id"] = typeKey };
            ElementId typeId = new ElementId(typeValue);
            if (doc.GetElement(typeId) == null)
                return new JObject { ["ok"] = false, ["code"] = "FMC-LEGEND-CATEGORY", ["type_id"] = typeKey, ["error"] = "The type is not in this document." };
            double xFt = item.Value<double?>("x_ft") ?? Paper(item.Value<double?>("x_mm") ?? 0, scale);
            double yFt = item.Value<double?>("y_ft") ?? Paper(item.Value<double?>("y_mm") ?? 0, scale);
            ICollection<ElementId> copied;
            try
            {
                copied = ElementTransformUtils.CopyElements(seedView, new List<ElementId> { seed.Id }, legend, Transform.Identity, new CopyPasteOptions());
            }
            catch (Exception ex)
            {
                return new JObject { ["ok"] = false, ["code"] = "FMC-LEGEND-COPY-REFUSED", ["type_id"] = typeKey, ["error"] = ex.Message };
            }
            if (copied == null || copied.Count == 0)
                return new JObject { ["ok"] = false, ["code"] = "FMC-LEGEND-COPY-REFUSED", ["type_id"] = typeKey, ["error"] = "CopyElements returned nothing." };
            Element component = doc.GetElement(copied.First());
            XYZ to = new XYZ(xFt, yFt, 0);
            BoundingBoxXYZ box = component.get_BoundingBox(legend);
            XYZ from = box == null ? XYZ.Zero : new XYZ((box.Min.X + box.Max.X) / 2, (box.Min.Y + box.Max.Y) / 2, 0);
            ElementTransformUtils.MoveElement(doc, component.Id, to - from);
            var names = (item["params"] as JArray ?? new JArray()).Select(t => t.ToString()).ToList();
            if (names.Count == 0) names = new List<string> { "LEGEND_COMPONENT", "LEGEND_COMPONENT_VIEW" };
            int direction = item.Value<int?>("direction") ?? -7;
            double? lengthFt = item.Value<double?>("length_ft");
            if (lengthFt == null && item.Value<double?>("length_mm") != null) lengthFt = item.Value<double>("length_mm") / 304.8;
            foreach (string param in names)
            {
                if (!SetParam(component, param, typeId, direction, lengthFt, out string why))
                    return new JObject { ["ok"] = false, ["code"] = "FMC-LEGEND-PARAM-REJECTED", ["type_id"] = typeKey, ["param"] = param, ["error"] = why };
            }
            string mark = TypeMark(doc.GetElement(typeId));
            if (!string.IsNullOrEmpty(mark)) marks.Add(new JObject { ["type_id"] = typeKey, ["type_mark"] = mark });
            JObject tagged = TryLabel(doc, legend, component, label);
            if (label != "none")
            {
                if (tagged.Value<bool?>("possible") != true) { labelPossible = false; labelReason = tagged.Value<string>("reason") ?? "The legend view did not accept the tag."; }
                else labelPossible = true;
            }
            return new JObject { ["ok"] = true, ["id"] = component.Id.Value.ToString(), ["type_id"] = typeKey, ["type_mark"] = mark, ["label"] = tagged, ["x_ft"] = xFt, ["y_ft"] = yFt };
        }

        private static bool SetParam(Element element, string name, ElementId typeId, int direction, double? lengthFt, out string why)
        {
            why = "";
            BuiltInParameter bip;
            if (name == "LEGEND_COMPONENT") bip = BuiltInParameter.LEGEND_COMPONENT;
            else if (name == "LEGEND_COMPONENT_VIEW") bip = BuiltInParameter.LEGEND_COMPONENT_VIEW;
            else if (name == "LEGEND_COMPONENT_LENGTH") bip = BuiltInParameter.LEGEND_COMPONENT_LENGTH;
            else { why = "Unknown parameter " + name; return false; }
            Parameter p = element.get_Parameter(bip);
            if (p == null) { why = name + " is not on this component."; return false; }
            if (p.IsReadOnly) { why = name + " is read-only."; return false; }
            bool ok;
            if (name == "LEGEND_COMPONENT") ok = p.Set(typeId);
            else if (name == "LEGEND_COMPONENT_VIEW") ok = p.Set(direction);
            else
            {
                if (lengthFt == null) { why = "A wall needs length_mm."; return false; }
                ok = p.Set(lengthFt.Value);
            }
            if (!ok) why = name + " Set returned false.";
            return ok;
        }

        private static JObject TryLabel(Document doc, View view, Element component, string mode)
        {
            if (mode == "none" || string.IsNullOrEmpty(mode)) return new JObject { ["attempted"] = false, ["possible"] = false };
            FamilySymbol tag = mode == "keynote" ? FirstSymbol(doc, BuiltInCategory.OST_KeynoteTags) : TypeMarkTag(doc);
            if (tag == null)
                return new JObject { ["attempted"] = true, ["possible"] = false, ["code"] = "FMC-LEGEND-LABEL-UNSUPPORTED", ["reason"] = "No keynote tag or multi-category tag is loaded. No text note was placed." };
            try
            {
                using (var nested = new SubTransaction(doc))
                {
                    nested.Start();
                    try
                    {
                        if (!tag.IsActive) tag.Activate();
                        IndependentTag.Create(doc, tag.Id, view.Id, new Reference(component), false, TagOrientation.Horizontal, component.get_BoundingBox(view)?.Min ?? XYZ.Zero);
                        nested.Commit();
                        return new JObject { ["attempted"] = true, ["possible"] = true, ["family"] = tag.FamilyName, ["mode"] = mode };
                    }
                    catch (Exception ex)
                    {
                        if (nested.HasStarted() && !nested.HasEnded()) nested.RollBack();
                        return new JObject { ["attempted"] = true, ["possible"] = false, ["code"] = "FMC-LEGEND-LABEL-UNSUPPORTED", ["reason"] = ex.Message };
                    }
                }
            }
            catch (Exception ex)
            {
                return new JObject { ["attempted"] = true, ["possible"] = false, ["code"] = "FMC-LEGEND-LABEL-UNSUPPORTED", ["reason"] = ex.Message };
            }
        }

        private static FamilySymbol TypeMarkTag(Document doc)
        {
            return FirstSymbol(doc, BuiltInCategory.OST_MultiCategoryTags) ?? FirstSymbol(doc, BuiltInCategory.OST_DoorTags);
        }

        private static FamilySymbol FirstSymbol(Document doc, BuiltInCategory category)
        {
            try
            {
                return new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).OfCategory(category).Cast<FamilySymbol>().FirstOrDefault();
            }
            catch { return null; }
        }

        private static string TypeMark(Element type)
        {
            try { return type?.get_Parameter(BuiltInParameter.ALL_MODEL_TYPE_MARK)?.AsString() ?? ""; }
            catch { return ""; }
        }

        private static View FindLegend(Document doc, string key)
        {
            if (string.IsNullOrWhiteSpace(key)) return null;
            if (long.TryParse(key, out long id))
            {
                if (doc.GetElement(new ElementId(id)) is View byId && byId.ViewType == ViewType.Legend) return byId;
            }
            return new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>()
                .FirstOrDefault(v => !v.IsTemplate && v.ViewType == ViewType.Legend && string.Equals(v.Name, key, StringComparison.OrdinalIgnoreCase));
        }

        private static View LegendNamed(Document doc, string name)
        {
            return new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>()
                .FirstOrDefault(v => string.Equals(v.Name, name, StringComparison.OrdinalIgnoreCase));
        }

        private static Element FindId(Document doc, string key)
        {
            if (!long.TryParse(key, out long id)) return null;
            return doc.GetElement(new ElementId(id));
        }

        private static double Paper(double mm, int scale) => mm * scale / 304.8;

        private static JObject Fail(string code, string message)
        {
            return new JObject { ["ok"] = false, ["code"] = code, ["message"] = message, ["free_text"] = false };
        }
    }
}
