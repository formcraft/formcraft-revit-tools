using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Analysis;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    internal static class FmcAvfViews
    {
        private static readonly HashSet<ViewType> Graphical = new HashSet<ViewType>
        {
            ViewType.FloorPlan, ViewType.CeilingPlan, ViewType.Elevation, ViewType.Section, ViewType.ThreeD,
            ViewType.EngineeringPlan, ViewType.AreaPlan, ViewType.Detail,
        };

        public static bool CanShow(View view) => view != null && !view.IsTemplate && Graphical.Contains(view.ViewType);

        public static List<string> Results(SpatialFieldManager sfm)
        {
            var names = new List<string>();
            if (sfm == null) return names;
            foreach (int index in sfm.GetRegisteredResults())
            {
                try { names.Add(sfm.GetResultSchema(index).Name ?? ""); } catch (Exception) { }
            }
            return names;
        }

        public static int FindSchema(SpatialFieldManager sfm, string name)
        {
            foreach (int index in sfm.GetRegisteredResults())
            {
                try { if (string.Equals(sfm.GetResultSchema(index).Name, name, StringComparison.Ordinal)) return index; } catch (Exception) { }
            }
            return -1;
        }
    }

    /// <summary>fmc_avf: graphical views, their AVF result schemas and the analysis display styles. No transaction.</summary>
    public class FmcAvfHandler : FmcSiteHandlerBase
    {
        protected override string Tool => "fmc_avf";

        protected override JObject Run(UIApplication app, Document doc)
        {
            JObject result = DocFacts(doc);
            result["internal_to_shared"] = InternalToSharedMm(doc);
            var styles = new JArray();
            var styleNames = new Dictionary<long, string>();
            foreach (AnalysisDisplayStyle style in new FilteredElementCollector(doc).OfClass(typeof(AnalysisDisplayStyle)).Cast<AnalysisDisplayStyle>())
            {
                styles.Add(new JObject { ["id"] = style.Id.Value.ToString(), ["name"] = style.Name ?? "" });
                styleNames[style.Id.Value] = style.Name ?? "";
            }
            var views = new JArray();
            foreach (View view in new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>())
            {
                bool canShow = FmcAvfViews.CanShow(view);
                var row = new JObject
                {
                    ["id"] = view.Id.Value.ToString(),
                    ["name"] = view.Name ?? "",
                    ["type"] = view.ViewType.ToString(),
                    ["is_template"] = view.IsTemplate,
                    ["can_show"] = canShow,
                };
                if (canShow)
                {
                    SpatialFieldManager sfm = null;
                    try { sfm = SpatialFieldManager.GetSpatialFieldManager(view); } catch (Exception) { sfm = null; }
                    row["results"] = new JArray(FmcAvfViews.Results(sfm).Cast<object>().ToArray());
                    try
                    {
                        ElementId styleId = view.AnalysisDisplayStyleId;
                        if (styleId != null && styleId != ElementId.InvalidElementId && styleNames.TryGetValue(styleId.Value, out string styleName))
                            row["style_name"] = styleName;
                    }
                    catch (Exception) { }
                }
                views.Add(row);
            }
            result["views"] = views;
            result["styles"] = styles;
            return result;
        }
    }

    /// <summary>
    /// fmc_avf_apply: one transaction. show gets or creates the named marker display style, sets it on the view, and puts
    /// the point results in the view's SpatialFieldManager under the named schema. clear empties the manager.
    /// AVF results are transient: Revit does not save them with the model.
    /// </summary>
    public class FmcAvfApplyHandler : FmcSiteHandlerBase
    {
        protected override string Tool => "fmc_avf_apply";

        protected override JObject Run(UIApplication app, Document doc)
        {
            Refuse(doc);
            View view = long.TryParse(Parameters.Value<string>("view_id"), out long viewId) ? doc.GetElement(new ElementId(viewId)) as View : null;
            if (!FmcAvfViews.CanShow(view)) throw new InvalidOperationException("[FMC-AVF-VIEW] The view is not a graphical, non-template view.");
            string action = (Parameters.Value<string>("action") ?? "show").Trim().ToLowerInvariant();
            string schemaName = (Parameters.Value<string>("schema_name") ?? "FMC Analysis").Trim();
            using (var transaction = new Transaction(doc, "Formcraft analysis display"))
            {
                transaction.Start();
                try
                {
                    JObject result = action == "clear" ? Clear(view, schemaName) : Show(doc, view, schemaName);
                    transaction.Commit();
                    result["view_id"] = view.Id.Value.ToString();
                    result["saved"] = false;
                    result["synced"] = false;
                    result["transient_results"] = true;
                    return result;
                }
                catch
                {
                    if (transaction.HasStarted() && !transaction.HasEnded()) transaction.RollBack();
                    throw;
                }
            }
        }

        private JObject Clear(View view, string schemaName)
        {
            SpatialFieldManager sfm = SpatialFieldManager.GetSpatialFieldManager(view);
            List<string> names = FmcAvfViews.Results(sfm);
            if (sfm == null || names.Count == 0) throw new InvalidOperationException("[FMC-AVF-NOTHING] The view has no analysis results to clear.");
            bool all = Parameters.Value<bool?>("all") == true;
            if (!all && names.Any(n => n != schemaName))
                throw new InvalidOperationException("[FMC-AVF-OTHERS] The view also holds other results. Pass all true.");
            sfm.Clear();
            return new JObject { ["ok"] = true, ["action"] = "clear", ["cleared"] = new JArray(names.Cast<object>().ToArray()) };
        }

        private JObject Show(Document doc, View view, string schemaName)
        {
            List<XYZ> points = PointsFeet(Parameters["xyz_mm"]);
            var values = (Parameters["values"] as JArray ?? new JArray()).Select(v => v.Value<double>()).ToList();
            if (points.Count == 0 || points.Count != values.Count)
                throw new InvalidOperationException("[FMC-AVF-POINTS] The points and the values do not match.");
            string styleName = (Parameters.Value<string>("style_name") ?? "FMC AVF Markers").Trim();
            AnalysisDisplayStyle style = new FilteredElementCollector(doc).OfClass(typeof(AnalysisDisplayStyle)).Cast<AnalysisDisplayStyle>()
                .FirstOrDefault(s => string.Equals(s.Name, styleName, StringComparison.OrdinalIgnoreCase));
            bool styleCreated = false;
            if (style == null)
            {
                var markers = new AnalysisDisplayMarkersAndTextSettings
                {
                    MarkerType = AnalysisDisplayStyleMarkerType.Circle,
                    MarkerSize = Parameters.Value<double?>("marker_size") ?? 0.01,
                    TextLabelType = Parameters.Value<bool?>("show_text") == true ? AnalysisDisplayStyleMarkerTextLabelType.ShowAll : AnalysisDisplayStyleMarkerTextLabelType.ShowNone,
                };
                var colors = new AnalysisDisplayColorSettings
                {
                    MinColor = ColorOf(Parameters["min_color"], new Color(0, 90, 255)),
                    MaxColor = ColorOf(Parameters["max_color"], new Color(255, 40, 0)),
                };
                var legend = new AnalysisDisplayLegendSettings
                {
                    ShowLegend = true,
                    ShowUnits = true,
                    ShowDataDescription = true,
                    NumberOfSteps = Math.Max(2, Math.Min(20, Parameters.Value<int?>("steps") ?? 8)),
                };
                style = AnalysisDisplayStyle.CreateAnalysisDisplayStyle(doc, styleName, markers, colors, legend);
                styleCreated = true;
            }
            view.AnalysisDisplayStyleId = style.Id;
            SpatialFieldManager sfm = SpatialFieldManager.GetSpatialFieldManager(view);
            bool created = false;
            if (sfm == null)
            {
                sfm = SpatialFieldManager.CreateSpatialFieldManager(view, 1);
                created = true;
            }
            bool replaced = false;
            if (!created && Parameters.Value<bool?>("replace") != false && FmcAvfViews.Results(sfm).Count > 0)
            {
                sfm.Clear();
                replaced = true;
            }
            int schemaIndex = FmcAvfViews.FindSchema(sfm, schemaName);
            if (schemaIndex < 0)
            {
                var schema = new AnalysisResultSchema(schemaName, Parameters.Value<string>("description") ?? "Formcraft analysis results");
                string unit = (Parameters.Value<string>("unit_name") ?? "").Trim();
                if (unit.Length > 0) schema.SetUnits(new List<string> { unit }, new List<double> { 1.0 });
                schemaIndex = sfm.RegisterResult(schema);
            }
            int primitive = sfm.AddSpatialFieldPrimitive();
            var domain = new FieldDomainPointsByXYZ(points);
            var field = new FieldValues(values.Select(v => new ValueAtPoint(new List<double> { v })).ToList());
            sfm.UpdateSpatialFieldPrimitive(primitive, domain, field, schemaIndex);
            var result = new JObject
            {
                ["ok"] = true,
                ["action"] = "show",
                ["points"] = points.Count,
                ["manager_created"] = created,
                ["replaced"] = replaced,
                ["schema_index"] = schemaIndex,
                ["primitive_index"] = primitive,
                ["style_id"] = style.Id.Value.ToString(),
                ["style_created"] = styleCreated,
            };
            try
            {
                result["min"] = sfm.GetMinimum(schemaIndex, true);
                result["max"] = sfm.GetMaximum(schemaIndex, true);
            }
            catch (Exception) { }
            return result;
        }

        private static Color ColorOf(JToken token, Color fallback)
        {
            if (token is JArray a && a.Count == 3)
                return new Color((byte)Math.Max(0, Math.Min(255, a[0].Value<int>())), (byte)Math.Max(0, Math.Min(255, a[1].Value<int>())), (byte)Math.Max(0, Math.Min(255, a[2].Value<int>())));
            return fallback;
        }
    }
}
