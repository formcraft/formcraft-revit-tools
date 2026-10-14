using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Templates as data (Phase 1, U29): one layer of the base recipe applied to a template in staging. The server reads
    /// the recipe from the kit; each layer here is the hand build of 14 Oct (scripts/kitbuild/template), which passed
    /// its audit in Revit 2025, fed from the recipe instead of hand-made files. Every layer creates or updates by name
    /// and never deletes, so a layer can run again; a layer that runs out of time stops and answers "more", and the
    /// next call carries on. Demand factors, line weights and phases are never set (rule 5; no API).
    /// </summary>
    public static class FmcTemplateBuild
    {
        private const double Mm = 1 / 304.8;
        private static readonly CultureInfo Ci = CultureInfo.InvariantCulture;

        public static JObject Create(Autodesk.Revit.ApplicationServices.Application app, string seed, string target)
        {
            if (File.Exists(target)) return new JObject { ["created"] = false, ["reason"] = "exists", ["path"] = target };
            if (!File.Exists(seed)) throw new FileNotFoundException($"Seed template not found: {seed}");
            Document d = app.NewProjectTemplateDocument(seed);
            try { d.SaveAs(target, new SaveAsOptions { MaximumBackups = 1 }); }
            finally { d.Close(false); }
            return new JObject { ["created"] = true, ["path"] = target, ["seed"] = seed };
        }

        public static JObject Apply(Document d, string layer, JObject p, double seconds)
        {
            var sw = Stopwatch.StartNew();
            var notes = new JArray();
            int made = 0, updated = 0, skipped = 0;
            bool more = false;
            using (var t = new Transaction(d, "Formcraft template: " + layer))
            {
                t.Start();
                switch (layer)
                {
                    case "units_params": UnitsParams(d, p, notes, ref made, ref updated); break;
                    case "graphics": Graphics(d, p, notes, ref made, ref updated); break;
                    case "electrical": Electrical(d, p, notes, ref made, ref skipped); break;
                    case "systems": Systems(d, p, notes, ref made, ref skipped); break;
                    case "filters": Filters(d, p, notes, ref made, ref updated); break;
                    case "view_templates": more = ViewTemplates(d, p, notes, sw, seconds, ref made, ref skipped); break;
                    case "qa_views": QaViews(d, p, notes, ref made, ref skipped); break;
                    case "schedules": Schedules(d, p, notes, ref made, ref skipped); break;
                    default: throw new ArgumentException($"Unknown layer '{layer}'");
                }
                t.Commit();
            }
            return new JObject { ["layer"] = layer, ["made"] = made, ["updated"] = updated, ["skipped"] = skipped, ["more"] = more, ["notes"] = notes,
                ["seconds"] = Math.Round(sw.Elapsed.TotalSeconds, 1) };
        }

        // ---------- units, revisions, parameters, TBC ----------

        private static void UnitsParams(Document d, JObject p, JArray notes, ref int made, ref int updated)
        {
            var app = d.Application;
            Units u = d.GetUnits();
            foreach (JObject x in (p["units"] as JArray ?? new JArray()).OfType<JObject>())
            {
                try
                {
                    ForgeTypeId spec = Spec(x.Value<string>("spec")), unit = Unit(x.Value<string>("unit"));
                    var fo = new FormatOptions(unit) { Accuracy = x.Value<double>("accuracy") };
                    string sym = x.Value<string>("symbol");
                    if (!string.IsNullOrEmpty(sym)) fo.SetSymbolTypeId(Symbol(sym));
                    u.SetFormatOptions(spec, fo);
                }
                catch (Exception e) { notes.Add($"unit {x.Value<string>("spec")}: {e.Message}"); }
            }
            d.SetUnits(u);

            foreach (JObject s in (p["revisions"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string nm = s.Value<string>("name");
                if (new FilteredElementCollector(d).OfClass(typeof(RevisionNumberingSequence)).Any(e => e.Name == nm)) continue;
                var ns = new NumericRevisionSettings { Prefix = s.Value<string>("prefix"), MinimumDigits = s.Value<int>("digits"), StartNumber = 1 };
                RevisionNumberingSequence.CreateNumericSequence(d, nm, ns);
                made++;
            }

            // Every kit parameter from the dictionary, by category and binding. The dictionary must be Revit's shared parameter file.
            DefinitionFile spf = app.OpenSharedParameterFile() ?? throw new InvalidOperationException("No shared parameter file is set in Revit: point it at the kit's FMC_SharedParameters.txt first");
            var defs = spf.Groups.SelectMany(g => g.Definitions.Cast<Definition>()).OfType<ExternalDefinition>().GroupBy(x => x.Name).ToDictionary(g => g.Key, g => g.First());
            var missing = new List<string>();
            var badCats = new HashSet<string>();
            foreach (JObject pp in (p["params"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string name = pp.Value<string>("name");
                if (!defs.TryGetValue(name, out ExternalDefinition def)) { missing.Add(name); continue; }
                CategorySet cs = app.Create.NewCategorySet();
                foreach (string c in (pp["categories"] as JArray ?? new JArray()).Select(x => x.ToString()))
                {
                    if (Enum.TryParse(c, out BuiltInCategory bic) && Category.GetCategory(d, bic) is Category cat && cat.AllowsBoundParameters) cs.Insert(cat);
                    else badCats.Add(c);
                }
                if (cs.IsEmpty) continue;
                ElementBinding b = pp.Value<string>("binding") == "Type" ? (ElementBinding)app.Create.NewTypeBinding(cs) : app.Create.NewInstanceBinding(cs);
                if (d.ParameterBindings.Insert(def, b, GroupTypeId.Data)) made++;
                else if (d.ParameterBindings.ReInsert(def, b, GroupTypeId.Data)) updated++;
            }
            if (missing.Count > 0) notes.Add("not in the shared parameter file: " + string.Join(", ", missing));
            if (badCats.Count > 0) notes.Add("categories that can't take parameters (kit change request): " + string.Join(", ", badCats));

            int tbc = 0;
            foreach (string name in (p["tbc"] as JArray ?? new JArray()).Select(x => x.ToString()))
            {
                Parameter q = d.ProjectInformation.LookupParameter(name);
                if (q != null && q.StorageType == StorageType.String && string.IsNullOrEmpty(q.AsString())) { q.Set("TBC"); tbc++; }
            }
            notes.Add($"TBC in {tbc} Project Information fields");
        }

        private static ForgeTypeId Spec(string n) => n switch
        {
            "Length" => SpecTypeId.Length, "Area" => SpecTypeId.Area, "Volume" => SpecTypeId.Volume, "Angle" => SpecTypeId.Angle,
            "Slope" => SpecTypeId.Slope, "Currency" => SpecTypeId.Currency, _ => throw new ArgumentException("unknown spec " + n),
        };
        private static ForgeTypeId Unit(string n) => n switch
        {
            "Millimeters" => UnitTypeId.Millimeters, "SquareMeters" => UnitTypeId.SquareMeters, "CubicMeters" => UnitTypeId.CubicMeters,
            "Degrees" => UnitTypeId.Degrees, "Percentage" => UnitTypeId.Percentage, "Currency" => UnitTypeId.Currency,
            _ => throw new ArgumentException("unknown unit " + n),
        };
        private static ForgeTypeId Symbol(string n) => n switch
        {
            "MSup2" => SymbolTypeId.MSup2, "MSup3" => SymbolTypeId.MSup3, "Degree" => SymbolTypeId.Degree, "Percent" => SymbolTypeId.Percent,
            _ => throw new ArgumentException("unknown symbol " + n),
        };

        // ---------- text types, line patterns, fill patterns ----------

        private static void Graphics(Document d, JObject p, JArray notes, ref int made, ref int updated)
        {
            var types = new FilteredElementCollector(d).OfClass(typeof(TextNoteType)).Cast<TextNoteType>().ToList();
            TextNoteType first = types.First();
            foreach (JObject x in (p["text"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string nm = x.Value<string>("name");
                TextNoteType tt = types.FirstOrDefault(t => t.Name == nm);
                if (tt == null) { tt = (TextNoteType)first.Duplicate(nm); made++; } else updated++;
                tt.get_Parameter(BuiltInParameter.TEXT_FONT).Set(x.Value<string>("font"));
                tt.get_Parameter(BuiltInParameter.TEXT_SIZE).Set(x.Value<double>("size_mm") * Mm);
                tt.get_Parameter(BuiltInParameter.TEXT_WIDTH_SCALE).Set(1.0);
                tt.get_Parameter(BuiltInParameter.TEXT_STYLE_BOLD).Set(x.Value<bool>("bold") ? 1 : 0);
            }
            foreach (JObject x in (p["lines"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string nm = x.Value<string>("name");
                var lp = new LinePattern(nm);
                lp.SetSegments((x["segments"] as JArray ?? new JArray()).OfType<JObject>().Select(s =>
                {
                    string k = s.Value<string>("kind");
                    double mm = s.Value<double>("mm") * Mm;
                    return k == "dash" ? new LinePatternSegment(LinePatternSegmentType.Dash, mm)
                         : k == "space" ? new LinePatternSegment(LinePatternSegmentType.Space, mm)
                         : new LinePatternSegment(LinePatternSegmentType.Dot, 0);
                }).ToList());
                LinePatternElement ex = LinePatternElement.GetLinePatternElementByName(d, nm);
                if (ex == null) { LinePatternElement.Create(d, lp); made++; } else { ex.SetLinePattern(lp); updated++; }
            }
            var fills = new FilteredElementCollector(d).OfClass(typeof(FillPatternElement)).Cast<FillPatternElement>().ToList();
            foreach (JObject x in (p["fills"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string nm = x.Value<string>("name"), kind = x.Value<string>("kind");
                var target = x.Value<string>("target") == "Model" ? FillPatternTarget.Model : FillPatternTarget.Drafting;
                FillPattern fp;
                double spacing = (x.Value<double?>("spacing_mm") ?? 1.5) * Mm, angle = (x.Value<double?>("angle") ?? 45) * Math.PI / 180;
                switch (kind)
                {
                    case "solid": continue; // Revit allows one solid fill: the built-in <Solid fill> stands in
                    case "hatch": fp = new FillPattern(nm, target, FillPatternHostOrientation.ToView, angle, spacing); break;
                    case "crosshatch":
                    {
                        fp = new FillPattern(nm, target, FillPatternHostOrientation.ToView);
                        var g1 = new FillGrid { Angle = angle, Offset = spacing };
                        var g2 = new FillGrid { Angle = angle + Math.PI / 2, Offset = spacing };
                        fp.SetFillGrids(new List<FillGrid> { g1, g2 });
                        break;
                    }
                    case "grid":
                    {
                        fp = new FillPattern(nm, target, FillPatternHostOrientation.ToHost);
                        fp.SetFillGrids(new List<FillGrid> { new FillGrid { Angle = 0, Offset = spacing }, new FillGrid { Angle = Math.PI / 2, Offset = spacing } });
                        break;
                    }
                    case "copy":
                    {
                        FillPatternElement src = fills.FirstOrDefault(f => f.Name == x.Value<string>("copy_of"));
                        if (src == null) { notes.Add($"{nm}: Revit's \"{x.Value<string>("copy_of")}\" isn't in this template"); continue; }
                        fp = src.GetFillPattern();
                        fp.Name = nm;
                        break;
                    }
                    default: notes.Add($"{nm}: unknown fill kind {kind}"); continue;
                }
                FillPatternElement ex = fills.FirstOrDefault(f => f.Name == nm);
                if (ex == null) { FillPatternElement.Create(d, fp); made++; } else { ex.SetFillPattern(fp); updated++; }
            }
        }

        // ---------- electrical settings ----------

        private static void Electrical(Document d, JObject p, JArray notes, ref int made, ref int skipped)
        {
            ElectricalSetting es = ElectricalSetting.GetElectricalSettings(d);
            double V(double v) => UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Volts);
            var vt = new Dictionary<string, VoltageType>();
            foreach (JObject x in (p["voltages"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string nm = x.Value<string>("name");
                VoltageType ex = es.VoltageTypes.Cast<VoltageType>().FirstOrDefault(v => v.Name == nm);
                if (ex == null) { ex = es.AddVoltageType(nm, V(x.Value<double>("value")), V(x.Value<double>("min")), V(x.Value<double>("max"))); made++; } else skipped++;
                vt[nm] = ex;
            }
            foreach (VoltageType v in es.VoltageTypes) if (!vt.ContainsKey(v.Name)) vt[v.Name] = v;
            foreach (JObject x in (p["systems"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string nm = x.Value<string>("name");
                if (es.DistributionSysTypes.Cast<DistributionSysType>().Any(s => s.Name == nm)) { skipped++; continue; }
                var phase = x.Value<string>("phase") == "Single" ? ElectricalPhase.SinglePhase : ElectricalPhase.ThreePhase;
                var config = x.Value<string>("config") switch { "Delta" => ElectricalPhaseConfiguration.Delta, "Wye" => ElectricalPhaseConfiguration.Wye, _ => ElectricalPhaseConfiguration.Undefined };
                string ll = x.Value<string>("ll"), lg = x.Value<string>("lg");
                if ((ll != null && !vt.ContainsKey(ll)) || (lg != null && !vt.ContainsKey(lg))) { notes.Add($"{nm}: a voltage it names isn't defined"); continue; }
                es.AddDistributionSysType(nm, phase, config, x.Value<int>("wires"), ll == null ? null : vt[ll], lg == null ? null : vt[lg]);
                made++;
            }
            var have = new FilteredElementCollector(d).OfClass(typeof(ElectricalLoadClassification)).Select(x => x.Name).ToHashSet();
            foreach (string n in (p["loads"] as JArray ?? new JArray()).Select(x => x.ToString()))
            {
                if (have.Contains(n)) { skipped++; continue; }
                ElectricalLoadClassification.Create(d, n); // the name only: demand factors are the engineer's (rule 5)
                made++;
            }
        }

        // ---------- pipe and duct system types ----------

        private static void Systems(Document d, JObject p, JArray notes, ref int made, ref int skipped)
        {
            var pst = new FilteredElementCollector(d).OfClass(typeof(PipingSystemType)).Cast<PipingSystemType>().ToList();
            foreach (JObject x in (p["piping"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string nm = x.Value<string>("name");
                if (pst.Any(s => s.Name == nm)) { skipped++; continue; }
                var cls = (MEPSystemClassification)Enum.Parse(typeof(MEPSystemClassification), x.Value<string>("classification"));
                PipingSystemType src = pst.FirstOrDefault(s => s.SystemClassification == cls);
                if (src == null) { notes.Add($"{nm}: no {cls} piping system to copy"); continue; }
                src.Duplicate(nm);
                made++;
            }
            var dst = new FilteredElementCollector(d).OfClass(typeof(MechanicalSystemType)).Cast<MechanicalSystemType>().ToList();
            foreach (JObject x in (p["duct"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string nm = x.Value<string>("name");
                if (dst.Any(s => s.Name == nm)) { skipped++; continue; }
                var cls = (MEPSystemClassification)Enum.Parse(typeof(MEPSystemClassification), x.Value<string>("from"));
                MechanicalSystemType src = dst.FirstOrDefault(s => s.SystemClassification == cls);
                if (src == null) { notes.Add($"{nm}: no {cls} duct system to copy"); continue; }
                src.Duplicate(nm);
                made++;
            }
        }

        // ---------- filters ----------

        private static void Filters(Document d, JObject p, JArray notes, ref int made, ref int updated)
        {
            var sp = new FilteredElementCollector(d).OfClass(typeof(SharedParameterElement)).Cast<SharedParameterElement>()
                .GroupBy(x => x.Name).ToDictionary(g => g.Key, g => g.First());
            List<ElementId> fiveD = new List<ElementId>();
            if (sp.TryGetValue("FMC_Keynote_Code", out SharedParameterElement kc) && d.ParameterBindings.get_Item(kc.GetDefinition()) is ElementBinding kb)
                fiveD = kb.Categories.Cast<Category>().Select(c => c.Id).ToList();
            var existing = new FilteredElementCollector(d).OfClass(typeof(ParameterFilterElement)).Cast<ParameterFilterElement>().ToDictionary(x => x.Name, x => x);

            foreach (JObject f in (p["filters"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string name = f.Value<string>("name");
                try
                {
                    var ids = new List<ElementId>();
                    string rs = f.Value<string>("rule") ?? "none";
                    ElementFilter ef = null;
                    if (rs.StartsWith("or:") || rs.StartsWith("and:"))
                    {
                        var parts = rs.Substring(rs.IndexOf(':') + 1).Split(';').Select(x => (ElementFilter)new ElementParameterFilter(Rule(d, sp, x, ids))).ToList();
                        ef = rs.StartsWith("or:") ? new LogicalOrFilter(parts) : (ElementFilter)new LogicalAndFilter(parts);
                    }
                    else if (rs != "none") ef = new ElementParameterFilter(Rule(d, sp, rs, ids));

                    var cats = new List<ElementId>();
                    foreach (string c in (f["categories"] as JArray ?? new JArray()).Select(x => x.ToString()))
                    {
                        if (c == "5D") { cats.AddRange(fiveD); continue; }
                        Category cat = Enum.TryParse(c, out BuiltInCategory bic) ? Category.GetCategory(d, bic) : d.Settings.Categories.Cast<Category>().FirstOrDefault(x => x.Name == c);
                        if (cat != null) cats.Add(cat.Id); else notes.Add($"{name}: no category {c}");
                    }
                    // A rule parameter must be filterable on every category: drop the ones that lack it, and say which.
                    var dropped = new List<string>();
                    if (ids.Count > 0)
                        cats = cats.Where(c =>
                        {
                            var common = ParameterFilterUtilities.GetFilterableParametersInCommon(d, new List<ElementId> { c });
                            bool all = ids.All(common.Contains);
                            if (!all) dropped.Add(Category.GetCategory(d, c)?.Name ?? c.ToString());
                            return all;
                        }).ToList();
                    if (cats.Count == 0) { notes.Add($"{name}: no category takes its rule's parameter (kit change request)"); continue; }
                    if (!existing.TryGetValue(name, out ParameterFilterElement pfe)) { pfe = ParameterFilterElement.Create(d, name, cats); existing[name] = pfe; made++; }
                    else { pfe.SetCategories(cats); updated++; }
                    if (ef != null) pfe.SetElementFilter(ef);
                    if (dropped.Count > 0) notes.Add($"{name}: left out {string.Join(", ", dropped)} (no such parameter there)");
                }
                catch (Exception e) { notes.Add($"{name}: {e.Message}"); }
            }
        }

        private static FilterRule Rule(Document d, Dictionary<string, SharedParameterElement> sp, string s, List<ElementId> ids)
        {
            string[] a = s.Split(':');
            if (a[0] == "sys")
            {
                PipingSystemType st = new FilteredElementCollector(d).OfClass(typeof(PipingSystemType)).Cast<PipingSystemType>().FirstOrDefault(x => x.Name == a[1])
                    ?? throw new InvalidOperationException($"no piping system {a[1]}: run the systems layer first");
                var bid = new ElementId(BuiltInParameter.RBS_PIPING_SYSTEM_TYPE_PARAM);
                ids.Add(bid);
                return ParameterFilterRuleFactory.CreateEqualsRule(bid, st.Id);
            }
            ElementId id = a[1].StartsWith("B.") ? new ElementId((BuiltInParameter)Enum.Parse(typeof(BuiltInParameter), a[1].Substring(2)))
                : sp.TryGetValue(a[1], out SharedParameterElement e) ? e.Id : throw new InvalidOperationException($"{a[1]} isn't bound in this template: run units_params first");
            ids.Add(id);
            switch (a[0])
            {
                case "noval": return ParameterFilterRuleFactory.CreateHasNoValueParameterRule(id);
                case "hasval": return ParameterFilterRuleFactory.CreateHasValueParameterRule(id);
                case "eq": return ParameterFilterRuleFactory.CreateEqualsRule(id, a[2]);
                case "begins": return ParameterFilterRuleFactory.CreateBeginsWithRule(id, a[2]);
                case "notbegins": return ParameterFilterRuleFactory.CreateNotBeginsWithRule(id, a[2]);
                case "contains": return ParameterFilterRuleFactory.CreateContainsRule(id, a[2]);
                case "ieq": return ParameterFilterRuleFactory.CreateEqualsRule(id, int.Parse(a[2], Ci));
                case "gt":
                {
                    ForgeTypeId dt = sp.TryGetValue(a[1], out SharedParameterElement g) ? g.GetDefinition().GetDataType() : null;
                    return dt == SpecTypeId.Int.Integer ? ParameterFilterRuleFactory.CreateGreaterRule(id, int.Parse(a[2], Ci))
                        : ParameterFilterRuleFactory.CreateGreaterRule(id, double.Parse(a[2], Ci), 1e-6);
                }
                case "phase":
                {
                    Phase ph = d.Phases.Cast<Phase>().FirstOrDefault(x => x.Name == a[2]) ?? throw new InvalidOperationException($"no phase {a[2]}");
                    return ParameterFilterRuleFactory.CreateEqualsRule(id, ph.Id);
                }
            }
            throw new ArgumentException("unknown rule " + s);
        }

        // ---------- view templates (in slices: stops after the time given, answers "more") ----------

        private static bool ViewTemplates(Document d, JObject p, JArray notes, Stopwatch sw, double seconds, ref int made, ref int skipped)
        {
            var style = (p["filters"] as JArray ?? new JArray()).OfType<JObject>().ToDictionary(x => x.Value<string>("name"), x => x);
            var vfts = new FilteredElementCollector(d).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().ToList();
            ElementId Vft(ViewFamily f) => vfts.First(x => x.ViewFamily == f).Id;
            Level lvl = new FilteredElementCollector(d).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => l.Elevation).First();
            var flt = new FilteredElementCollector(d).OfClass(typeof(ParameterFilterElement)).Cast<ParameterFilterElement>().ToDictionary(x => x.Name, x => x);
            ElementId solid = FillPatternElement.GetFillPatternElementByName(d, FillPatternTarget.Drafting, "<Solid fill>")?.Id ?? ElementId.InvalidElementId;
            var have = new HashSet<string>(new FilteredElementCollector(d).OfClass(typeof(View)).Cast<View>().Where(v => v.IsTemplate).Select(v => v.Name));
            var disc = new Dictionary<string, int> { ["Architectural"] = 1, ["Structural"] = 2, ["Mechanical"] = 4, ["Electrical"] = 8, ["Plumbing"] = 16, ["Coordination"] = 4095 };

            foreach (JObject a in (p["view_templates"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string name = a.Value<string>("name");
                if (have.Contains(name)) { skipped++; continue; }
                if (sw.Elapsed.TotalSeconds > seconds) return true;
                var tmp = new List<ElementId>();
                try
                {
                    View v = null;
                    switch (a.Value<string>("type"))
                    {
                        case "FP": v = ViewPlan.Create(d, Vft(ViewFamily.FloorPlan), lvl.Id); break;
                        case "CP": v = ViewPlan.Create(d, Vft(ViewFamily.CeilingPlan), lvl.Id); break;
                        case "SP": v = ViewPlan.Create(d, Vft(ViewFamily.StructuralPlan), lvl.Id); break;
                        case "AP": v = ViewPlan.CreateAreaPlan(d, new FilteredElementCollector(d).OfClass(typeof(AreaScheme)).First().Id, lvl.Id); break;
                        case "3D": v = View3D.CreateIsometric(d, Vft(ViewFamily.ThreeDimensional)); break;
                        case "DR": v = ViewDrafting.Create(d, Vft(ViewFamily.Drafting)); break;
                        case "SE": v = ViewSection.CreateSection(d, Vft(ViewFamily.Section), new BoundingBoxXYZ { Min = new XYZ(-10, -10, -10), Max = new XYZ(10, 10, 10) }); break;
                        case "EL":
                        {
                            ViewPlan pl = ViewPlan.Create(d, Vft(ViewFamily.FloorPlan), lvl.Id);
                            tmp.Add(pl.Id);
                            ElevationMarker mk = ElevationMarker.CreateElevationMarker(d, Vft(ViewFamily.Elevation), XYZ.Zero, 100);
                            tmp.Insert(0, mk.Id);
                            v = mk.CreateElevation(d, pl.Id, 0);
                            break;
                        }
                    }
                    if (v == null) { notes.Add($"{name}: unknown view type"); continue; }
                    tmp.Insert(0, v.Id);
                    int scale = a.Value<int>("scale");
                    if (scale > 0) v.Scale = scale;
                    string det = a.Value<string>("detail");
                    v.DetailLevel = det == "C" ? ViewDetailLevel.Coarse : det == "F" ? ViewDetailLevel.Fine : ViewDetailLevel.Medium;
                    Parameter dp = v.get_Parameter(BuiltInParameter.VIEW_DISCIPLINE);
                    if (dp != null && !dp.IsReadOnly && disc.TryGetValue(a.Value<string>("discipline") ?? "", out int dv)) dp.Set(dv);
                    if (a.Value<string>("type") != "DR")
                        foreach (string fn in (a["filters"] as JArray ?? new JArray()).Select(x => x.ToString()))
                        {
                            if (!flt.TryGetValue(fn, out ParameterFilterElement fe)) { notes.Add($"{name}: no filter {fn}"); continue; }
                            v.AddFilter(fe.Id);
                            if (!style.TryGetValue(fn, out JObject st)) continue;
                            var rgb = (st["rgb"] as JArray ?? new JArray()).Select(c => (byte)c.Value<int>()).ToArray();
                            var col = new Color(rgb[0], rgb[1], rgb[2]);
                            var o = new OverrideGraphicSettings();
                            if (st.Value<bool>("surface"))
                            {
                                o.SetSurfaceForegroundPatternId(solid).SetSurfaceForegroundPatternColor(col).SetCutForegroundPatternId(solid).SetCutForegroundPatternColor(col);
                            }
                            else
                            {
                                o.SetProjectionLineColor(col).SetCutLineColor(col);
                                string pat = st.Value<string>("pattern");
                                if (!string.IsNullOrEmpty(pat) && LinePatternElement.GetLinePatternElementByName(d, pat) is LinePatternElement lp)
                                    o.SetProjectionLinePatternId(lp.Id).SetCutLinePatternId(lp.Id);
                            }
                            v.SetFilterOverrides(fe.Id, o);
                        }
                    View vt = v.CreateViewTemplate();
                    vt.Name = name;
                    made++;
                }
                catch (Exception e) { notes.Add($"{name}: {e.Message}"); }
                foreach (ElementId id in tmp) { try { if (d.GetElement(id) != null) d.Delete(id); } catch (Exception) { /* already gone with its marker */ } }
            }
            return false;
        }

        // ---------- QA, model and export views ----------

        private static void QaViews(Document d, JObject p, JArray notes, ref int made, ref int skipped)
        {
            var views = new FilteredElementCollector(d).OfClass(typeof(View)).Cast<View>().ToList();
            ElementId v3 = new FilteredElementCollector(d).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().First(x => x.ViewFamily == ViewFamily.ThreeDimensional).Id;
            foreach (JObject s in (p["qa_views"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string name = s.Value<string>("name"), tpl = s.Value<string>("template");
                if (views.Any(v => !v.IsTemplate && v.Name == name)) { skipped++; continue; }
                View template = views.FirstOrDefault(v => v.IsTemplate && v.Name == tpl);
                if (template == null) { notes.Add($"{name}: no view template {tpl} (run view_templates first)"); continue; }
                View3D v = View3D.CreateIsometric(d, v3);
                v.Name = name;
                v.ViewTemplateId = template.Id;
                made++;
            }
        }

        // ---------- schedules ----------

        private static void Schedules(Document d, JObject p, JArray notes, ref int made, ref int skipped)
        {
            var have = new HashSet<string>(new FilteredElementCollector(d).OfClass(typeof(View)).Cast<View>().Select(v => v.Name));
            foreach (JObject s in (p["schedules"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string name = s.Value<string>("name");
                if (have.Contains(name)) { skipped++; continue; }
                try
                {
                    string c = s.Value<string>("category");
                    ElementId cid = c == "*" ? ElementId.InvalidElementId
                        : Enum.TryParse(c, out BuiltInCategory bic) ? new ElementId(bic)
                        : d.Settings.Categories.Cast<Category>().FirstOrDefault(x => x.Name == c)?.Id ?? throw new InvalidOperationException($"no category {c}");
                    ViewSchedule vs = ViewSchedule.CreateSchedule(d, cid);
                    vs.Name = name;
                    ScheduleDefinition def = vs.Definition;
                    var sf = def.GetSchedulableFields();
                    var fid = new Dictionary<string, ScheduleFieldId>();
                    var miss = new List<string>();
                    foreach (string fn in (s["fields"] as JArray ?? new JArray()).Select(x => x.ToString()))
                    {
                        SchedulableField f = sf.FirstOrDefault(x => x.GetName(d) == fn);
                        if (f == null) { miss.Add(fn); continue; }
                        fid[fn] = def.AddField(f).FieldId;
                    }
                    foreach (string op in (s["ops"] as JArray ?? new JArray()).Select(x => x.ToString()))
                    {
                        string[] o = op.Split(new[] { ':' }, 2);
                        if (!fid.TryGetValue(o[1], out ScheduleFieldId id)) { notes.Add($"{name}: {o[1]} isn't a field, so it can't {(o[0] == "g" ? "group" : o[0] == "s" ? "sort" : "filter")}"); continue; }
                        if (o[0] == "g") def.AddSortGroupField(new ScheduleSortGroupField(id) { ShowHeader = true });
                        else if (o[0] == "s") def.AddSortGroupField(new ScheduleSortGroupField(id));
                        else if (o[0] == "none") def.AddFilter(new ScheduleFilter(id, ScheduleFilterType.HasNoValue));
                    }
                    if (!s.Value<bool>("itemized")) def.IsItemized = false;
                    if (miss.Count > 0) notes.Add($"{name}: no field {string.Join(", ", miss)} in this template");
                    made++;
                }
                catch (Exception e) { notes.Add($"{name}: {e.Message}"); }
            }
        }

        // ---------- what a template holds, for compare ----------

        public static JObject Names(Document d)
        {
            JArray Of(IEnumerable<string> n) => new JArray(n.Distinct().OrderBy(x => x));
            var views = new FilteredElementCollector(d).OfClass(typeof(View)).Cast<View>().ToList();
            var bound = new List<string>();
            var it = d.ParameterBindings.ForwardIterator();
            while (it.MoveNext()) if (it.Key != null) bound.Add(it.Key.Name);
            return new JObject
            {
                ["title"] = d.Title,
                ["text_types"] = Of(new FilteredElementCollector(d).OfClass(typeof(TextNoteType)).Select(x => x.Name)),
                ["line_patterns"] = Of(new FilteredElementCollector(d).OfClass(typeof(LinePatternElement)).Select(x => x.Name)),
                ["fill_patterns"] = Of(new FilteredElementCollector(d).OfClass(typeof(FillPatternElement)).Select(x => x.Name)),
                ["filters"] = Of(new FilteredElementCollector(d).OfClass(typeof(ParameterFilterElement)).Select(x => x.Name)),
                ["view_templates"] = Of(views.Where(v => v.IsTemplate).Select(v => v.Name)),
                ["views"] = Of(views.Where(v => !v.IsTemplate && !(v is ViewSchedule)).Select(v => v.Name)),
                ["schedules"] = Of(views.OfType<ViewSchedule>().Where(v => !v.IsTemplate).Select(v => v.Name)),
                ["parameters"] = Of(bound),
            };
        }
    }
}
