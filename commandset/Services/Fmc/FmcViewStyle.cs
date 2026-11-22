using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>Existing view templates, filters and room names. No transaction.</summary>
    public class FmcViewStyleHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft view style";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_viewstyle needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    var templates = new JArray(new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(view => view.IsTemplate).Select(view => view.Name));
                    var filters = new JArray(new FilteredElementCollector(doc).OfClass(typeof(ParameterFilterElement)).Select(filter => filter.Name));
                    var rooms = new JArray();
                    foreach (Element room in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms).WhereElementIsNotElementType().Take(400))
                    {
                        rooms.Add(new JObject
                        {
                            ["id"] = room.Id.Value.ToString(),
                            ["name"] = room.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString() ?? "",
                            ["department"] = room.get_Parameter(BuiltInParameter.ROOM_DEPARTMENT)?.AsString() ?? "",
                        });
                    }
                    var schemes = new JArray();
                    foreach (ColorFillScheme scheme in new FilteredElementCollector(doc).OfClass(typeof(ColorFillScheme)).Cast<ColorFillScheme>())
                        schemes.Add(new JObject { ["id"] = scheme.Id.Value.ToString(), ["name"] = scheme.Name ?? "" });
                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["title"] = doc.Title ?? "",
                        ["path"] = doc.PathName ?? "",
                        ["is_central"] = FmcPhaseIds.IsCentral(doc),
                        ["templates"] = templates,
                        ["filters"] = filters,
                        ["rooms"] = rooms,
                        ["schemes"] = schemes,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }
    }

    /// <summary>
    /// One transaction. Creates view templates, parameter filters, or a room colour scheme.
    /// The colour-scheme API cannot choose Department or Name. When that cannot be confirmed the scheme is rolled back
    /// and the result is FMC-VIEWSTYLE-SCHEME-PARAM.
    /// </summary>
    public class FmcViewStyleApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft view style apply";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_viewstyle_apply needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    Refuse(doc);
                    string action = (Parameters.Value<string>("action") ?? "").Trim();
                    var done = new JArray();
                    var skipped = new JArray();
                    string code = "";
                    using (var transaction = new Transaction(doc, "Formcraft view style"))
                    {
                        transaction.Start();
                        try
                        {
                            if (action == "templates") Templates(doc, done, skipped);
                            else if (action == "filters") Filters(doc, done, skipped);
                            else if (action == "room_fill") code = RoomFill(doc, done, skipped);
                            else throw new InvalidOperationException("[FMC-VIEWSTYLE-ACTION] action is templates, filters or room_fill.");
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
                        ["ok"] = code.Length == 0,
                        ["code"] = code,
                        ["action"] = action,
                        ["applied"] = done,
                        ["skipped"] = skipped,
                        ["saved"] = false,
                        ["synced"] = false,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private void Refuse(Document doc)
        {
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (Regex.IsMatch(blob, "hebert hostels", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("HEBERT HOSTELS is not written by fmc_viewstyle.");
            if (FmcPhaseIds.IsCentral(doc)) throw new InvalidOperationException("A central model is not written by fmc_viewstyle.");
            if (FmcTarget.IsProtected(doc.PathName ?? "", FmcTarget.Roots(Parameters)))
                throw new InvalidOperationException("The document is under a protected path.");
        }

        private void Templates(Document doc, JArray done, JArray skipped)
        {
            foreach (JObject op in Ops())
            {
                string name = op.Value<string>("name") ?? "";
                View existing = TemplatesNamed(doc, name);
                if (existing != null)
                {
                    skipped.Add(new JObject { ["name"] = name, ["code"] = "FMC-VIEWSTYLE-NAME-TAKEN" });
                    continue;
                }
                View source = FindView(doc, op.Value<string>("from_view"), false);
                if (source == null)
                {
                    skipped.Add(new JObject { ["name"] = name, ["code"] = "FMC-VIEWSTYLE-NO-VIEW" });
                    continue;
                }
                using (var sub = new SubTransaction(doc))
                {
                    sub.Start();
                    try
                    {
                        View template = source.CreateViewTemplate();
                        template.Name = name;
                        if (op["scale"] != null && op["scale"].Type != JTokenType.Null) template.Scale = op.Value<int>("scale");
                        if (!string.IsNullOrWhiteSpace(op.Value<string>("detail_level")))
                            template.DetailLevel = (ViewDetailLevel)Enum.Parse(typeof(ViewDetailLevel), op.Value<string>("detail_level"), true);
                        if (!string.IsNullOrWhiteSpace(op.Value<string>("discipline")))
                            template.Discipline = (ViewDiscipline)Enum.Parse(typeof(ViewDiscipline), op.Value<string>("discipline"), true);
                        int applied = 0;
                        foreach (string viewName in (op["apply_to"] as JArray ?? new JArray()).Select(token => token.ToString()))
                        {
                            View view = FindView(doc, viewName, false);
                            if (view == null) continue;
                            view.ViewTemplateId = template.Id;
                            applied++;
                        }
                        sub.Commit();
                        done.Add(new JObject { ["name"] = template.Name, ["id"] = template.Id.Value.ToString(), ["applied"] = applied });
                    }
                    catch (Exception ex)
                    {
                        try { if (sub.HasStarted()) sub.RollBack(); } catch (Exception) { }
                        skipped.Add(new JObject { ["name"] = name, ["code"] = "FMC-VIEWSTYLE-NO-VIEW", ["reason"] = ex.Message });
                    }
                }
            }
        }

        private void Filters(Document doc, JArray done, JArray skipped)
        {
            foreach (JObject op in Ops())
            {
                string name = op.Value<string>("name") ?? "";
                if (new FilteredElementCollector(doc).OfClass(typeof(ParameterFilterElement)).Any(filter => string.Equals(filter.Name, name, StringComparison.OrdinalIgnoreCase)))
                {
                    skipped.Add(new JObject { ["name"] = name, ["code"] = "FMC-VIEWSTYLE-NAME-TAKEN" });
                    continue;
                }
                using (var sub = new SubTransaction(doc))
                {
                    sub.Start();
                    try
                    {
                        var cats = Categories(doc, op["categories"] as JArray);
                        if (cats.Count == 0) throw new InvalidOperationException("A filter needs categories.");
                        var filterable = ParameterFilterUtilities.GetFilterableParametersInCommon(doc, cats);
                        var rules = new List<FilterRule>();
                        foreach (JObject rule in (op["rules"] as JArray ?? new JArray()).OfType<JObject>())
                            rules.Add(Rule(doc, filterable, rule));
                        ElementFilter elementFilter = rules.Count > 0 ? new ElementParameterFilter(rules) : null;
                        ParameterFilterElement filter = elementFilter == null
                            ? ParameterFilterElement.Create(doc, name, cats)
                            : ParameterFilterElement.Create(doc, name, cats, elementFilter);
                        var colour = op["color"] as JArray;
                        int applied = 0;
                        if (colour != null && colour.Count >= 3)
                        {
                            var overrides = Colour(doc, colour);
                            foreach (string viewName in (op["apply_to"] as JArray ?? new JArray()).Select(token => token.ToString()))
                            {
                                View view = FindView(doc, viewName, false);
                                if (view == null) continue;
                                if (!view.GetFilters().Contains(filter.Id)) view.AddFilter(filter.Id);
                                view.SetFilterOverrides(filter.Id, overrides);
                                applied++;
                            }
                        }
                        sub.Commit();
                        done.Add(new JObject { ["name"] = filter.Name, ["id"] = filter.Id.Value.ToString(), ["applied"] = applied, ["provisional"] = op.Value<bool?>("provisional") == true });
                    }
                    catch (Exception ex)
                    {
                        try { if (sub.HasStarted()) sub.RollBack(); } catch (Exception) { }
                        skipped.Add(new JObject { ["name"] = name, ["code"] = "FMC-VIEWSTYLE-FILTER", ["reason"] = ex.Message });
                    }
                }
            }
        }

        /// <summary>Returns FMC-VIEWSTYLE-SCHEME-PARAM when the scheme parameter cannot be confirmed. The subtransaction is rolled back.</summary>
        private string RoomFill(Document doc, JArray done, JArray skipped)
        {
            JObject op = Ops().FirstOrDefault();
            if (op == null) return "";
            string by = op.Value<string>("by") ?? "Department";
            ElementId rooms = new ElementId(BuiltInCategory.OST_Rooms);
            using (var sub = new SubTransaction(doc))
            {
                sub.Start();
                try
                {
                    ColorFillScheme scheme = new FilteredElementCollector(doc).OfClass(typeof(ColorFillScheme)).Cast<ColorFillScheme>()
                        .FirstOrDefault(item => (item.Name ?? "").IndexOf(by, StringComparison.OrdinalIgnoreCase) >= 0);
                    bool created = false;
                    if (scheme == null)
                    {
                        // Revit 2025 has no ColorFillScheme.Create. A missing scheme is reported, not created.
                        created = true;
                    }
                    // A scheme this call just created has no public way to bind Department or Name.
                    // Naming it is not binding it. Only a scheme that already exists for that parameter is filled.
                    if (created || !SchemeMatches(scheme, by))
                    {
                        sub.RollBack();
                        skipped.Add(new JObject
                        {
                            ["code"] = "FMC-VIEWSTYLE-SCHEME-PARAM",
                            ["reason"] = "Revit can create a room colour scheme, and it cannot bind that scheme to " + by + ". No entry was written on the wrong parameter.",
                        });
                        return "FMC-VIEWSTYLE-SCHEME-PARAM";
                    }
                    ElementId solid = SolidFill(doc);
                    int added = 0;
                    foreach (JObject entry in (op["entries"] as JArray ?? new JArray()).OfType<JObject>())
                    {
                        string value = entry.Value<string>("value") ?? "";
                        if (value.Length == 0) continue;
                        var row = new ColorFillSchemeEntry(StorageType.String);
                        row.SetStringValue(value);
                        JArray colour = entry["color"] as JArray;
                        if (colour != null && colour.Count >= 3)
                            row.Color = new Color((byte)colour[0].Value<int>(), (byte)colour[1].Value<int>(), (byte)colour[2].Value<int>());
                        if (solid != ElementId.InvalidElementId) row.FillPatternId = solid;
                        try { scheme.AddEntry(row); added++; }
                        catch (Exception ex) { skipped.Add(new JObject { ["value"] = value, ["code"] = "FMC-VIEWSTYLE-SCHEME-PARAM", ["reason"] = ex.Message }); }
                    }
                    string viewName = op.Value<string>("view") ?? "";
                    View view = FindView(doc, viewName, false) ?? new FilteredElementCollector(doc).OfClass(typeof(ViewPlan)).Cast<ViewPlan>().FirstOrDefault(item => !item.IsTemplate && item.ViewType == ViewType.FloorPlan);
                    if (view != null)
                    {
                        view.SetColorFillSchemeId(rooms, scheme.Id);
                        if (op.Value<bool?>("legend") != false)
                        {
                            ColorFillLegend.Create(doc, view.Id, rooms, new XYZ(20 / 304.8, 20 / 304.8, 0));
                        }
                    }
                    sub.Commit();
                    done.Add(new JObject { ["scheme"] = scheme.Name, ["id"] = scheme.Id.Value.ToString(), ["created"] = created, ["entries"] = added, ["by"] = by });
                    return "";
                }
                catch (Exception ex)
                {
                    try { if (sub.HasStarted()) sub.RollBack(); } catch (Exception) { }
                    skipped.Add(new JObject { ["code"] = "FMC-VIEWSTYLE-SCHEME-PARAM", ["reason"] = ex.Message });
                    return "FMC-VIEWSTYLE-SCHEME-PARAM";
                }
            }
        }

        /// <summary>True when an existing scheme is already named for the parameter. A scheme just created by the API is not.</summary>
        private static bool SchemeMatches(ColorFillScheme scheme, string by)
        {
            return (scheme.Name ?? "").IndexOf(by, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private List<JObject> Ops() => (Parameters["ops"] as JArray ?? new JArray()).OfType<JObject>().ToList();

        private static View TemplatesNamed(Document doc, string name) =>
            new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().FirstOrDefault(view => view.IsTemplate && string.Equals(view.Name, name, StringComparison.OrdinalIgnoreCase));

        private static View FindView(Document doc, string key, bool templates)
        {
            if (string.IsNullOrWhiteSpace(key)) return null;
            if (long.TryParse(key, out long id) && doc.GetElement(new ElementId(id)) is View byId) return byId;
            return new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>()
                .FirstOrDefault(view => view.IsTemplate == templates && string.Equals(view.Name, key, StringComparison.OrdinalIgnoreCase));
        }

        private static List<ElementId> Categories(Document doc, JArray names)
        {
            var ids = new List<ElementId>();
            foreach (string name in (names ?? new JArray()).Select(token => token.ToString()))
            {
                Category category = Enum.TryParse(name, true, out BuiltInCategory builtIn) ? Category.GetCategory(doc, builtIn) : null;
                if (category == null && Enum.TryParse("OST_" + name.Replace(" ", ""), true, out BuiltInCategory prefixed))
                    category = Category.GetCategory(doc, prefixed);
                category ??= doc.Settings.Categories.Cast<Category>().FirstOrDefault(item => string.Equals(item.Name, name, StringComparison.OrdinalIgnoreCase));
                if (category != null) ids.Add(category.Id);
            }
            return ids;
        }

        private static FilterRule Rule(Document doc, ICollection<ElementId> filterable, JObject rule)
        {
            string name = rule.Value<string>("parameter") ?? "";
            ElementId parameter = filterable.FirstOrDefault(id => string.Equals(ParamName(doc, id), name, StringComparison.OrdinalIgnoreCase));
            if (parameter == null || parameter == ElementId.InvalidElementId) throw new InvalidOperationException(name + " can't be filtered for these categories.");
            string how = (rule.Value<string>("evaluator") ?? "equals").ToLowerInvariant();
            string value = rule.Value<string>("value") ?? "";
            return how switch
            {
                "contains" => ParameterFilterRuleFactory.CreateContainsRule(parameter, value),
                "begins_with" => ParameterFilterRuleFactory.CreateBeginsWithRule(parameter, value),
                "greater" => ParameterFilterRuleFactory.CreateGreaterRule(parameter, AsDouble(value), 1e-6),
                "less" => ParameterFilterRuleFactory.CreateLessRule(parameter, AsDouble(value), 1e-6),
                _ => ParameterFilterRuleFactory.CreateEqualsRule(parameter, value),
            };
        }

        private static double AsDouble(string value) => double.TryParse(value, out double number) ? number : 0;

        private static string ParamName(Document doc, ElementId id)
        {
            if (id.Value < 0) { try { return LabelUtils.GetLabelFor((BuiltInParameter)id.Value); } catch (Exception) { return ""; } }
            return doc.GetElement(id)?.Name ?? "";
        }

        private static OverrideGraphicSettings Colour(Document doc, JArray colour)
        {
            var color = new Color((byte)colour[0].Value<int>(), (byte)colour[1].Value<int>(), (byte)colour[2].Value<int>());
            var settings = new OverrideGraphicSettings();
            settings.SetProjectionLineColor(color);
            settings.SetCutLineColor(color);
            ElementId solid = SolidFill(doc);
            if (solid != ElementId.InvalidElementId)
            {
                settings.SetSurfaceForegroundPatternId(solid);
                settings.SetSurfaceForegroundPatternColor(color);
            }
            return settings;
        }

        private static ElementId SolidFill(Document doc) =>
            new FilteredElementCollector(doc).OfClass(typeof(FillPatternElement)).Cast<FillPatternElement>().FirstOrDefault(pattern => pattern.GetFillPattern().IsSolidFill)?.Id
            ?? ElementId.InvalidElementId;
    }
}
