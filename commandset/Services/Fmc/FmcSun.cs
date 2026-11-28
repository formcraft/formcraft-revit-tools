using System.Globalization;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>fmc_sun: the site location, 3D views and existing sun settings. No transaction.</summary>
    public class FmcSunHandler : FmcSiteHandlerBase
    {
        protected override string Tool => "fmc_sun";

        protected override JObject Run(UIApplication app, Document doc)
        {
            JObject result = DocFacts(doc);
            var site = new JObject();
            try
            {
                SiteLocation loc = doc.SiteLocation;
                if (loc != null)
                {
                    site["latitude_deg"] = Math.Round(Deg(loc.Latitude), 6);
                    site["longitude_deg"] = Math.Round(Deg(loc.Longitude), 6);
                    site["time_zone_h"] = loc.TimeZone;
                    site["place_name"] = loc.PlaceName ?? "";
                }
            }
            catch (Exception ex) { site["error"] = ex.Message; }
            result["site"] = site;
            try { result["project_north_deg"] = Math.Round(Deg(doc.ActiveProjectLocation.GetProjectPosition(XYZ.Zero).Angle), 6); }
            catch (Exception) { result["project_north_deg"] = null; }
            var views3d = new JArray();
            var sunViews = new JArray();
            foreach (View3D v in new FilteredElementCollector(doc).OfClass(typeof(View3D)).Cast<View3D>())
            {
                views3d.Add(new JObject
                {
                    ["id"] = v.Id.Value.ToString(),
                    ["name"] = v.Name ?? "",
                    ["is_template"] = v.IsTemplate,
                    ["is_perspective"] = v.IsPerspective,
                });
                if (v.IsTemplate) continue;
                try
                {
                    SunAndShadowSettings sas = v.SunAndShadowSettings;
                    if (sas != null && sas.SunAndShadowType != SunAndShadowType.Lighting)
                        sunViews.Add(new JObject
                        {
                            ["id"] = v.Id.Value.ToString(),
                            ["name"] = v.Name ?? "",
                            ["sun_type"] = sas.SunAndShadowType.ToString(),
                            ["start_utc"] = sas.StartDateAndTime.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture),
                        });
                }
                catch (Exception) { }
            }
            var names = new JArray();
            foreach (View v in new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>()) names.Add(v.Name ?? "");
            result["views_3d"] = views3d;
            result["sun_views"] = sunViews;
            result["view_names"] = names;
            return result;
        }
    }

    /// <summary>
    /// fmc_sun_apply: one transaction, one subtransaction per study view. Each view is a copy of source_view or a new
    /// isometric 3D view, with its own sun settings (UTC instants from the server), shadows on and the sun path when asked.
    /// The site location is never changed. Revit's sun altitude and azimuth are read back after the commit.
    /// </summary>
    public class FmcSunApplyHandler : FmcSiteHandlerBase
    {
        protected override string Tool => "fmc_sun_apply";

        protected override JObject Run(UIApplication app, Document doc)
        {
            Refuse(doc);
            string sourceKey = Parameters.Value<string>("source_view") ?? "";
            bool sunPath = Parameters.Value<bool?>("sun_path") != false;
            View3D source = FindView<View3D>(doc, sourceKey);
            if (sourceKey.Trim().Length > 0 && (source == null || source.IsTemplate))
                throw new InvalidOperationException("[FMC-SUN-SOURCE-VIEW] source_view is not a 3D view in the document.");
            ElementId vft = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>()
                .FirstOrDefault(t => t.ViewFamily == ViewFamily.ThreeDimensional)?.Id;
            if (source == null && vft == null) throw new InvalidOperationException("[FMC-SUN-SOURCE-VIEW] The document has no 3D view type.");
            var made = new List<(string Name, View3D View, bool Shadows, bool Path, bool TemplateCleared)>();
            var failed = new JArray();
            using (var transaction = new Transaction(doc, "Formcraft sun study"))
            {
                transaction.Start();
                try
                {
                    foreach (JObject study in (Parameters["studies"] as JArray ?? new JArray()).OfType<JObject>())
                    {
                        string name = (study.Value<string>("name") ?? "").Trim();
                        using (var sub = new SubTransaction(doc))
                        {
                            sub.Start();
                            try
                            {
                                if (name.Length == 0) throw new InvalidOperationException("The view name is missing.");
                                View3D view = source != null
                                    ? doc.GetElement(source.Duplicate(ViewDuplicateOption.Duplicate)) as View3D
                                    : View3D.CreateIsometric(doc, vft);
                                if (view == null) throw new InvalidOperationException("The 3D view was not made.");
                                view.Name = name;
                                bool cleared = false;
                                if (view.ViewTemplateId != ElementId.InvalidElementId)
                                {
                                    view.ViewTemplateId = ElementId.InvalidElementId;
                                    cleared = true;
                                }
                                SunAndShadowSettings sas = view.SunAndShadowSettings
                                    ?? throw new InvalidOperationException("The view has no sun settings.");
                                DateTime start = Utc(study.Value<string>("utc"));
                                if (string.Equals(study.Value<string>("kind"), "one_day", StringComparison.OrdinalIgnoreCase))
                                {
                                    sas.SunAndShadowType = SunAndShadowType.OneDayStudy;
                                    sas.SunriseToSunset = false;
                                    sas.StartDateAndTime = start;
                                    sas.EndDateAndTime = Utc(study.Value<string>("end_utc"));
                                    SunStudyTimeInterval interval = Interval(study.Value<int?>("interval_min") ?? 60);
                                    if (sas.IsTimeIntervalValid(interval)) sas.TimeInterval = interval;
                                }
                                else
                                {
                                    sas.SunAndShadowType = SunAndShadowType.StillImage;
                                    sas.StartDateAndTime = start;
                                }
                                bool shadows = SetYesNo(view, BuiltInParameter.GRAPHIC_DISPLAY_OPTIONS_SHADOWS, true);
                                bool path = sunPath && SetYesNo(view, BuiltInParameter.VIEW_GRAPH_SUN_PATH, true);
                                sub.Commit();
                                made.Add((name, view, shadows, path, cleared));
                            }
                            catch (Exception ex)
                            {
                                try { if (sub.HasStarted() && !sub.HasEnded()) sub.RollBack(); } catch (Exception) { }
                                failed.Add(new JObject { ["name"] = name, ["code"] = "FMC-SUN-VIEW", ["reason"] = ex.Message });
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
            var views = new JArray();
            foreach (var row in made)
            {
                var item = new JObject
                {
                    ["name"] = row.Name,
                    ["view_id"] = row.View.Id.Value.ToString(),
                    ["shadows_on"] = row.Shadows,
                    ["sun_path_on"] = row.Path,
                    ["template_cleared"] = row.TemplateCleared,
                };
                try
                {
                    SunAndShadowSettings sas = row.View.SunAndShadowSettings;
                    double frame = sas.SunAndShadowType == SunAndShadowType.StillImage ? sas.ActiveFrame : 1.0;
                    if (!sas.IsFrameValid(frame)) frame = sas.ActiveFrame;
                    item["altitude_rad"] = sas.GetFrameAltitude(frame);
                    item["azimuth_rad"] = sas.GetFrameAzimuth(frame);
                    item["revit_utc"] = sas.GetFrameTime(frame).ToString("o", CultureInfo.InvariantCulture);
                    if (sas.SunAndShadowType == SunAndShadowType.OneDayStudy) item["frames"] = sas.NumberOfFrames;
                }
                catch (Exception ex) { item["readback_error"] = ex.Message; }
                views.Add(item);
            }
            return new JObject
            {
                ["ok"] = failed.Count == 0,
                ["views"] = views,
                ["failed"] = failed,
                ["shadows"] = made.Count > 0 && made.All(m => m.Shadows),
                ["site_changed"] = false,
                ["saved"] = false,
                ["synced"] = false,
            };
        }

        private static DateTime Utc(string text)
        {
            if (!DateTime.TryParse(text ?? "", CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out DateTime at))
                throw new InvalidOperationException("[FMC-SUN-DATE] The study time is not an ISO UTC instant: " + text);
            return DateTime.SpecifyKind(at, DateTimeKind.Utc);
        }

        private static SunStudyTimeInterval Interval(int minutes)
        {
            switch (minutes)
            {
                case 15: return SunStudyTimeInterval.Minutes15;
                case 30: return SunStudyTimeInterval.Minutes30;
                case 45: return SunStudyTimeInterval.Minutes45;
                default: return SunStudyTimeInterval.Hour;
            }
        }
    }
}
