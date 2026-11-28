using System;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_fam_hosting: a family's hosting. read: host, placement type, Work Plane-Based, Always Vertical, adaptive state,
    /// reference points, instance parameters, solids and voids. apply: only what the API changes in place (Work Plane-Based
    /// and Always Vertical; reference points made adaptive placement points). A family's host (wall, floor, ceiling, roof,
    /// face) comes from its template and is never changed here: the server gives the rebuild path for that instead.
    /// </summary>
    public static class FmcFamHosting
    {
        // FAMILY_HOSTING_BEHAVIOR's integer values; the text Revit shows is sent too, so a retest can confirm the map
        private static readonly string[] Hosts = { "none", "wall", "floor", "ceiling", "roof", "face" };

        private static bool? Flag(Element e, BuiltInParameter bip)
        {
            Parameter p = e?.get_Parameter(bip);
            return p == null ? (bool?)null : p.AsInteger() == 1;
        }

        public static JObject Read(Document doc)
        {
            Family own = doc.OwnerFamily ?? throw new InvalidOperationException("The document has no owner family");
            Parameter host = own.get_Parameter(BuiltInParameter.FAMILY_HOSTING_BEHAVIOR);
            int code = host?.AsInteger() ?? 0;
            Parameter wpb = own.get_Parameter(BuiltInParameter.FAMILY_WORK_PLANE_BASED);
            bool adaptive = false;
            int adaptivePoints = 0;
            try { adaptive = AdaptiveComponentFamilyUtils.IsAdaptiveComponentFamily(own); } catch (Exception) { /* not offered */ }
            try { adaptivePoints = AdaptiveComponentFamilyUtils.GetNumberOfAdaptivePoints(own); } catch (Exception) { /* not adaptive */ }
            var points = new JArray();
            foreach (ReferencePoint rp in new FilteredElementCollector(doc).OfClass(typeof(ReferencePoint)).Cast<ReferencePoint>())
            {
                bool isAdaptive = false;
                try { isAdaptive = AdaptiveComponentFamilyUtils.IsAdaptivePoint(doc, rp.Id); } catch (Exception) { /* plain point */ }
                points.Add(new JObject { ["id"] = FmcFamEditHandler.IdOf(rp.Id), ["adaptive"] = isAdaptive });
            }
            var forms = new FilteredElementCollector(doc).OfClass(typeof(GenericForm)).Cast<GenericForm>().ToList();
            var category = own.FamilyCategory;
            return new JObject
            {
                ["family"] = System.IO.Path.GetFileNameWithoutExtension(doc.Title), ["category"] = category?.Name, ["path"] = doc.PathName,
                ["placement"] = own.FamilyPlacementType.ToString(),
                ["hosting"] = code >= 0 && code < Hosts.Length ? Hosts[code] : code.ToString(), ["hosting_code"] = code, ["hosting_text"] = host?.AsValueString(),
                ["work_plane_based"] = wpb == null ? (bool?)null : wpb.AsInteger() == 1, ["work_plane_based_settable"] = wpb != null && !wpb.IsReadOnly,
                ["always_vertical"] = Flag(own, BuiltInParameter.FAMILY_ALWAYS_VERTICAL),
                ["is_adaptive"] = adaptive, ["adaptive_points"] = adaptivePoints,
                ["is_conceptual_mass"] = category != null && category.Id.Value == (long)BuiltInCategory.OST_Mass,
                ["reference_points"] = points,
                ["instance_parameters"] = new JArray(doc.FamilyManager.Parameters.Cast<FamilyParameter>().Where(p => p.IsInstance).Select(p => p.Definition.Name)),
                ["solids"] = forms.Count(f => f.IsSolid), ["voids"] = forms.Count(f => !f.IsSolid),
            };
        }

        public static JObject Apply(Document doc, JObject p)
        {
            Family own = doc.OwnerFamily ?? throw new InvalidOperationException("The document has no owner family");
            string action = p.Value<string>("action");
            switch (action)
            {
                case "work_plane_based":
                {
                    Parameter wpb = own.get_Parameter(BuiltInParameter.FAMILY_WORK_PLANE_BASED);
                    if (wpb == null || wpb.IsReadOnly) throw new InvalidOperationException("Revit doesn't let this family be work plane-based (the setting is missing or read-only)");
                    bool before = wpb.AsInteger() == 1;
                    if (!before && !wpb.Set(1)) throw new InvalidOperationException("Revit refused Work Plane-Based");
                    JObject row = new JObject { ["action"] = action, ["work_plane_based"] = before ? "unchanged" : "set" };
                    bool? av = p.Value<bool?>("always_vertical");
                    if (av.HasValue)
                    {
                        Parameter avp = own.get_Parameter(BuiltInParameter.FAMILY_ALWAYS_VERTICAL);
                        if (avp == null || avp.IsReadOnly) throw new InvalidOperationException("Always Vertical is missing or read-only on this family");
                        if (!avp.Set(av.Value ? 1 : 0)) throw new InvalidOperationException("Revit refused Always Vertical");
                        row["always_vertical"] = av.Value;
                    }
                    doc.Regenerate();
                    return row;
                }
                case "make_adaptive":
                {
                    var rows = new JArray();
                    foreach (long id in (p["points"] as JArray ?? new JArray()).Select(t => t.Value<long>()))
                    {
                        ElementId eid = FmcFamEditHandler.Id(id);
                        if (!(doc.GetElement(eid) is ReferencePoint)) throw new InvalidOperationException($"{id} isn't a reference point");
                        if (AdaptiveComponentFamilyUtils.IsAdaptivePoint(doc, eid)) { rows.Add(new JObject { ["id"] = id, ["done"] = "unchanged" }); continue; }
                        AdaptiveComponentFamilyUtils.MakeAdaptivePoint(doc, eid, AdaptivePointType.PlacementPoint);
                        rows.Add(new JObject { ["id"] = id, ["done"] = "made adaptive (placement point)" });
                    }
                    doc.Regenerate();
                    int n = 0;
                    try { n = AdaptiveComponentFamilyUtils.GetNumberOfAdaptivePoints(own); } catch (Exception) { /* not reported */ }
                    return new JObject { ["action"] = action, ["points"] = rows, ["adaptive_points_after"] = n };
                }
                default: throw new InvalidOperationException($"Unknown hosting action '{action}' (face-based is a rebuild, never an in-place change)");
            }
        }
    }
}
