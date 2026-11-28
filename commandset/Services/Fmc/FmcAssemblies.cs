using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Bridge;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// F59 assemblies (server/src/fmc/assemblies_*.ts plans everything; this only reads and carries the plan out, mm from
    /// the server, feet in Revit). <b>read</b>: fill patterns, curtain wall types with their grids, mullions and panel,
    /// mullion, panel, railing and top rail types, legend views. <b>apply</b>: patterns created or changed, curtain wall and
    /// railing types duplicated from their base (or changed) and set, in one transaction; the dry run rolls it back.
    /// </summary>
    public class FmcAssembliesHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public string Action { get; set; } = "";
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft assemblies";

        private static double Ft(double mm) => mm / 304.8;
        private static double Mm(double ft) => Math.Round(ft * 304.8, 3);
        private static readonly string[] Layouts = { "none", "fixed_distance", "fixed_number", "maximum_spacing", "minimum_spacing" };

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try
            {
                using var target = FmcTarget.Resolve(app, Parameters, mayOpen: false);
                Document doc = target.Doc;
                if (doc.IsFamilyDocument) throw new InvalidOperationException("Assemblies are project types, not family content");
                switch (Action)
                {
                    case "read": Result = Read(doc); break;
                    case "apply": Result = Apply(doc); break;
                    default: Error = $"Unknown assemblies action '{Action}'"; break;
                }
            }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        private static IEnumerable<WallType> CurtainTypes(Document doc) =>
            new FilteredElementCollector(doc).OfClass(typeof(WallType)).Cast<WallType>().Where(w => w.Kind == WallKind.Curtain);
        private static IEnumerable<Element> PanelTypes(Document doc) =>
            new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_CurtainWallPanels).WhereElementIsElementType().ToElements();
        private static string NameOf(Document doc, Parameter p) =>
            p == null || p.StorageType != StorageType.ElementId || p.AsElementId() == ElementId.InvalidElementId ? null : doc.GetElement(p.AsElementId())?.Name;

        private static JObject Grid(WallType t, BuiltInParameter layout, BuiltInParameter length)
        {
            int code = t.get_Parameter(layout)?.AsInteger() ?? 0;
            var g = new JObject { ["layout"] = code >= 0 && code < Layouts.Length ? Layouts[code] : code.ToString() };
            if (code == 1 || code == 3 || code == 4) g["spacing"] = Mm(t.get_Parameter(length)?.AsDouble() ?? 0);
            return g;
        }

        // ---------------------------------------------------------------------------------------------------------
        // read

        private JObject Read(Document doc)
        {
            var patterns = new JArray();
            foreach (FillPatternElement fpe in new FilteredElementCollector(doc).OfClass(typeof(FillPatternElement)).Cast<FillPatternElement>())
            {
                FillPattern fp = fpe.GetFillPattern();
                if (fp == null || fp.IsSolidFill) continue;
                patterns.Add(new JObject
                {
                    ["name"] = fpe.Name, ["id"] = fpe.Id.Value, ["target"] = fp.Target == FillPatternTarget.Model ? "model" : "drafting",
                    ["grids"] = new JArray(fp.GetFillGrids().Select(g => new JObject
                    {
                        ["angle"] = Math.Round(g.Angle * 180 / Math.PI, 4), ["spacing"] = Mm(g.Offset), ["shift"] = Mm(g.Shift),
                        ["origin"] = new JArray(Mm(g.Origin.U), Mm(g.Origin.V)),
                    })),
                });
            }
            var curtains = new JArray(CurtainTypes(doc).Select(t => new JObject
            {
                ["name"] = t.Name, ["id"] = t.Id.Value,
                ["vertical"] = Grid(t, BuiltInParameter.SPACING_LAYOUT_VERT, BuiltInParameter.SPACING_LENGTH_VERT),
                ["horizontal"] = Grid(t, BuiltInParameter.SPACING_LAYOUT_HORIZ, BuiltInParameter.SPACING_LENGTH_HORIZ),
                ["mullion"] = new JObject
                {
                    ["interior"] = NameOf(doc, t.get_Parameter(BuiltInParameter.AUTO_MULLION_INTERIOR_VERT)),
                    ["border"] = NameOf(doc, t.get_Parameter(BuiltInParameter.AUTO_MULLION_BORDER1_VERT)),
                },
                ["panel"] = NameOf(doc, t.get_Parameter(BuiltInParameter.AUTO_PANEL_WALL)),
            }));
            var railings = new JArray(new FilteredElementCollector(doc).OfClass(typeof(RailingType)).Cast<RailingType>().Select(r => new JObject
            {
                ["name"] = r.Name, ["id"] = r.Id.Value, ["height"] = Mm(r.TopRailHeight),
                ["top_rail"] = r.TopRailType == ElementId.InvalidElementId ? null : doc.GetElement(r.TopRailType)?.Name,
            }));
            return new JObject
            {
                ["patterns"] = patterns, ["curtain_types"] = curtains, ["railing_types"] = railings,
                ["mullion_types"] = new JArray(new FilteredElementCollector(doc).OfClass(typeof(MullionType)).Select(e => e.Name).Distinct()),
                ["panel_types"] = new JArray(PanelTypes(doc).Select(e => e.Name).Distinct()),
                ["top_rail_types"] = new JArray(new FilteredElementCollector(doc).OfClass(typeof(TopRailType)).Select(e => e.Name).Distinct()),
                ["legend_views"] = new JArray(new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>()
                    .Where(v => !v.IsTemplate && v.ViewType == ViewType.Legend).Select(v => v.Name)),
            };
        }

        // ---------------------------------------------------------------------------------------------------------
        // apply

        private JObject Apply(Document doc)
        {
            bool dry = Parameters.Value<bool?>("dry_run") ?? true;
            var results = new JArray();
            var failures = new FmcFailures();
            bool anyError;
            using (var t = new Transaction(doc, "Formcraft: assemblies (F59)"))
            {
                failures.Attach(t);
                t.Start();
                foreach (JObject p in (Parameters["patterns"] as JArray ?? new JArray()).OfType<JObject>()) results.Add(Step("pattern", p, () => Pattern(doc, p)));
                foreach (JObject c in (Parameters["curtain_walls"] as JArray ?? new JArray()).OfType<JObject>()) results.Add(Step("curtain_wall", c, () => Curtain(doc, c)));
                foreach (JObject r in (Parameters["railings"] as JArray ?? new JArray()).OfType<JObject>()) results.Add(Step("railing", r, () => Railing(doc, r)));
                // one Undo, all or nothing: a step that failed rolls the real run back too
                anyError = results.OfType<JObject>().Any(r => r["error"] != null);
                if (dry || anyError) t.RollBack(); else t.Commit();
            }
            return new JObject
            {
                ["dry_run"] = dry, ["results"] = results, ["rolled_back"] = dry || anyError || failures.RolledBack, ["failed"] = anyError,
                ["warnings"] = new JArray(failures.Warnings), ["errors"] = new JArray(failures.Errors),
            };
        }

        private static JObject Step(string kind, JObject p, Func<string> run)
        {
            try { return new JObject { ["kind"] = kind, ["name"] = p.Value<string>("name"), ["done"] = run() }; }
            catch (Exception e) { return new JObject { ["kind"] = kind, ["name"] = p.Value<string>("name"), ["error"] = e.Message }; }
        }

        private static string Pattern(Document doc, JObject p)
        {
            string name = p.Value<string>("name");
            var target = p.Value<string>("target") == "model" ? FillPatternTarget.Model : FillPatternTarget.Drafting;
            var fp = new FillPattern(name, target, FillPatternHostOrientation.ToView);
            var grids = new List<FillGrid>();
            foreach (JObject g in (p["grids"] as JArray ?? new JArray()).OfType<JObject>())
            {
                var o = g["origin"] as JArray;
                grids.Add(new FillGrid
                {
                    Angle = (g.Value<double?>("angle") ?? 0) * Math.PI / 180, Offset = Ft(g.Value<double>("spacing")), Shift = Ft(g.Value<double?>("shift") ?? 0),
                    Origin = new UV(Ft(o?[0]?.Value<double>() ?? 0), Ft(o?[1]?.Value<double>() ?? 0)),
                });
            }
            fp.SetFillGrids(grids);
            FillPatternElement have = FillPatternElement.GetFillPatternElementByName(doc, target, name);
            if (have != null) { have.SetFillPattern(fp); return "changed"; }
            FillPatternElement.Create(doc, fp);
            return "created";
        }

        private static ElementId IdByName(IEnumerable<Element> list, string name, string what)
        {
            if (string.IsNullOrEmpty(name)) return null;
            Element e = list.FirstOrDefault(x => string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase));
            if (e == null) throw new InvalidOperationException($"The model has no {what} {name}");
            return e.Id;
        }

        private static T TypeFor<T>(IEnumerable<T> types, JObject p, out bool made) where T : ElementType
        {
            string name = p.Value<string>("name"), baseName = p.Value<string>("base");
            T have = types.FirstOrDefault(x => string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase));
            made = have == null;
            if (have != null) return have;
            T from = types.FirstOrDefault(x => string.Equals(x.Name, baseName, StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException($"The model has no type {baseName} to start from");
            return (T)from.Duplicate(name);
        }

        private static void SetGrid(WallType t, JObject g, BuiltInParameter layout, BuiltInParameter length)
        {
            if (g == null) return;
            t.get_Parameter(layout)?.Set(g.Value<int>("layout_code"));
            double? mm = g.Value<double?>("spacing");
            if (mm.HasValue) t.get_Parameter(length)?.Set(Ft(mm.Value));
        }

        private static string Curtain(Document doc, JObject c)
        {
            WallType t = TypeFor(CurtainTypes(doc).ToList(), c, out bool made);
            SetGrid(t, c["vertical"] as JObject, BuiltInParameter.SPACING_LAYOUT_VERT, BuiltInParameter.SPACING_LENGTH_VERT);
            SetGrid(t, c["horizontal"] as JObject, BuiltInParameter.SPACING_LAYOUT_HORIZ, BuiltInParameter.SPACING_LENGTH_HORIZ);
            var mullions = new FilteredElementCollector(doc).OfClass(typeof(MullionType)).ToElements();
            ElementId interior = IdByName(mullions, c.Value<string>("mullion_interior"), "mullion type");
            if (interior != null) foreach (var bip in new[] { BuiltInParameter.AUTO_MULLION_INTERIOR_VERT, BuiltInParameter.AUTO_MULLION_INTERIOR_HORIZ }) t.get_Parameter(bip)?.Set(interior);
            ElementId border = IdByName(mullions, c.Value<string>("mullion_border"), "mullion type");
            if (border != null)
                foreach (var bip in new[] { BuiltInParameter.AUTO_MULLION_BORDER1_VERT, BuiltInParameter.AUTO_MULLION_BORDER2_VERT, BuiltInParameter.AUTO_MULLION_BORDER1_HORIZ, BuiltInParameter.AUTO_MULLION_BORDER2_HORIZ })
                    t.get_Parameter(bip)?.Set(border);
            ElementId panel = IdByName(PanelTypes(doc), c.Value<string>("panel"), "curtain panel type");
            if (panel != null) t.get_Parameter(BuiltInParameter.AUTO_PANEL_WALL)?.Set(panel);
            return made ? "created" : "changed";
        }

        private static string Railing(Document doc, JObject r)
        {
            RailingType t = TypeFor(new FilteredElementCollector(doc).OfClass(typeof(RailingType)).Cast<RailingType>().ToList(), r, out bool made);
            t.TopRailHeight = Ft(r.Value<double>("height"));
            ElementId top = IdByName(new FilteredElementCollector(doc).OfClass(typeof(TopRailType)).ToElements(), r.Value<string>("top_rail"), "top rail type");
            if (top != null) t.TopRailType = top;
            return made ? "created" : "changed";
        }
    }
}
