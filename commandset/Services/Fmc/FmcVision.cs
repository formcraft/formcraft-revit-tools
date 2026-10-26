using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_view_image (owner 26 Oct: "the AI has to see the model"): a PNG of a view, or of a close-up 3D box around
    /// elements with them highlighted, for the AI to look at. Nothing in the model changes: the temporary view and the
    /// overrides are rolled back. selection true uses what the person has selected in Revit.
    /// </summary>
    public class FmcViewImageHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return _done.WaitOne(timeoutMilliseconds); }
        public string GetName() => "Formcraft view image";

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try { Result = Render(app.ActiveUIDocument ?? throw new InvalidOperationException("No model is open")); }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        private JObject Render(UIDocument uidoc)
        {
            Document doc = uidoc.Document;
            var ids = (Parameters["ids"] as JArray ?? new JArray()).Select(t => long.TryParse(t.ToString(), out long v) ? new ElementId(v) : doc.GetElement(t.ToString())?.Id)
                .Where(x => x != null && doc.GetElement(x) != null).ToList();
            if (Parameters.Value<bool?>("selection") == true) ids.AddRange(uidoc.Selection.GetElementIds().Where(x => !ids.Contains(x)));
            var highlight = (Parameters["highlight"] as JArray)?.Select(t => new ElementId(t.Value<long>())).ToList() ?? ids;
            int px = Math.Max(400, Math.Min(2400, Parameters.Value<int?>("size") ?? 1024));
            string dir = Path.Combine(Path.GetTempPath(), "Formcraft", "vision");
            Directory.CreateDirectory(dir);
            foreach (var old in Directory.GetFiles(dir, "*.png").Where(f => File.GetCreationTimeUtc(f) < DateTime.UtcNow.AddHours(-6))) { try { File.Delete(old); } catch (Exception) { } }
            string stem = Path.Combine(dir, "view_" + DateTime.Now.ToString("HHmmssfff"));
            var notes = new JArray();
            string viewName;
            using (var tg = new TransactionGroup(doc, "FMC view image (rolled back)"))
            {
                tg.Start();
                View v;
                using (var t = new Transaction(doc, "FMC view image"))
                {
                    t.Start();
                    string mode = Parameters.Value<string>("mode") ?? (ids.Count > 0 && Parameters["view"] == null ? "focus" : "view");
                    if (mode == "focus" && ids.Count > 0)
                    {
                        // a 3D box around the elements, padded, seen from the chosen side
                        var vft = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().First(x => x.ViewFamily == ViewFamily.ThreeDimensional);
                        var v3 = View3D.CreateIsometric(doc, vft.Id);
                        BoundingBoxXYZ box = Union(doc, ids) ?? throw new InvalidOperationException("these elements have no extent to look at");
                        double pad = (Parameters.Value<double?>("margin_mm") ?? 1500) / 304.8;
                        v3.SetSectionBox(new BoundingBoxXYZ { Min = box.Min - new XYZ(pad, pad, pad / 3), Max = box.Max + new XYZ(pad, pad, pad / 3) });
                        v3.SetOrientation(Orientation(Parameters.Value<string>("from") ?? "iso", (box.Min + box.Max) / 2));
                        v = v3;
                    }
                    else v = ViewOf(doc, Parameters.Value<string>("view")) ?? uidoc.ActiveView;
                    try { if (v.ViewType == ViewType.ThreeD) v.DisplayStyle = Parameters.Value<string>("style") == "hidden" ? DisplayStyle.HLR : DisplayStyle.ShadingWithEdges; } catch (Exception) { /* a template controls it */ }
                    try { v.DetailLevel = ViewDetailLevel.Fine; } catch (Exception) { }
                    if (highlight.Count > 0 && v.ViewType != ViewType.DrawingSheet)
                    {
                        // the elements in question in red, everything else as it is (or half-toned, ghost true)
                        var red = new OverrideGraphicSettings().SetProjectionLineColor(new Color(220, 30, 30)).SetCutLineColor(new Color(220, 30, 30)).SetProjectionLineWeight(6);
                        ElementId solid = new FilteredElementCollector(doc).OfClass(typeof(FillPatternElement)).Cast<FillPatternElement>().FirstOrDefault(f => f.GetFillPattern().IsSolidFill)?.Id;
                        if (solid != null) red.SetSurfaceForegroundPatternId(solid).SetSurfaceForegroundPatternColor(new Color(240, 80, 80));
                        if (Parameters.Value<bool?>("ghost") == true)
                            foreach (ElementId other in new FilteredElementCollector(doc, v.Id).WhereElementIsNotElementType().ToElementIds().Where(x => !highlight.Contains(x)))
                                try { v.SetElementOverrides(other, new OverrideGraphicSettings().SetHalftone(true)); } catch (Exception) { }
                        foreach (ElementId id in highlight) { try { v.SetElementOverrides(id, red); } catch (Exception e) { notes.Add($"{id.Value}: {e.Message}"); } }
                    }
                    t.Commit();
                }
                viewName = v.Name;
                var o = new ImageExportOptions
                {
                    ExportRange = ExportRange.SetOfViews, FilePath = stem, HLRandWFViewsFileType = ImageFileType.PNG, ShadowViewsFileType = ImageFileType.PNG,
                    ImageResolution = ImageResolution.DPI_150, ZoomType = ZoomFitType.FitToPage, PixelSize = px, FitDirection = FitDirectionType.Horizontal,
                };
                o.SetViewsAndSheets(new List<ElementId> { v.Id });
                doc.ExportImage(o);
                tg.RollBack();
            }
            string file = Directory.GetFiles(dir, Path.GetFileName(stem) + "*.png").FirstOrDefault() ?? throw new InvalidOperationException("Revit made no image");
            return new JObject { ["file"] = file, ["view"] = viewName, ["ids"] = new JArray(ids.Select(x => x.Value)), ["highlighted"] = highlight.Count, ["pixels"] = px, ["notes"] = notes };
        }

        private static BoundingBoxXYZ Union(Document doc, List<ElementId> ids)
        {
            var boxes = ids.Select(id => doc.GetElement(id)?.get_BoundingBox(null)).Where(b => b != null).ToList();
            if (boxes.Count == 0) return null;
            return new BoundingBoxXYZ
            {
                Min = new XYZ(boxes.Min(b => b.Min.X), boxes.Min(b => b.Min.Y), boxes.Min(b => b.Min.Z)),
                Max = new XYZ(boxes.Max(b => b.Max.X), boxes.Max(b => b.Max.Y), boxes.Max(b => b.Max.Z)),
            };
        }

        private static ViewOrientation3D Orientation(string from, XYZ target)
        {
            XYZ dir = from switch
            {
                "front" => new XYZ(0, 1, 0), "back" => new XYZ(0, -1, 0), "left" => new XYZ(1, 0, 0), "right" => new XYZ(-1, 0, 0),
                "top" => new XYZ(0, 0.001, -1), "iso_nw" => new XYZ(1, -1, -1), "iso_ne" => new XYZ(-1, -1, -1), "iso_sw" => new XYZ(1, 1, -1),
                _ => new XYZ(-1, 1, -1), // iso from the south-east, looking down
            };
            XYZ fwd = dir.Normalize();
            XYZ up = fwd.CrossProduct(XYZ.BasisZ).CrossProduct(fwd).Normalize();
            if (up.Z < 0) up = up.Negate();
            return new ViewOrientation3D(target - fwd * 100, up, fwd);
        }

        internal static View ViewOf(Document doc, string s)
        {
            if (string.IsNullOrEmpty(s)) return null;
            return (long.TryParse(s, out long id) ? doc.GetElement(new ElementId(id)) as View : null)
                ?? new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().FirstOrDefault(v => !v.IsTemplate && (string.Equals(v.Name, s, StringComparison.OrdinalIgnoreCase) || (v is ViewSheet sh && sh.SheetNumber == s)))
                ?? throw new InvalidOperationException($"no view or sheet {s}");
        }
    }

    /// <summary>
    /// fmc_model_check (owner 26 Oct: "the model should describe its problems well for the AI"): read-only checks that
    /// say what is wrong, where, with ids and a plain sentence each: Revit's own warnings, duplicates, rooms not placed
    /// or not enclosed, doors and windows without a host, walls overlapping, free wall ends, wall tops not attached under
    /// a roof, and clashes between structure, MEP and the rest. level limits it to one level.
    /// </summary>
    public class FmcModelCheckHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return _done.WaitOne(timeoutMilliseconds); }
        public string GetName() => "Formcraft model check";

        private const double Tol = 10 / 304.8;
        private int _limit = 50;

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try { Result = Check(app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No model is open")); }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        private static JArray Mm(XYZ p) => p == null ? null : new JArray(Math.Round(p.X * 304.8), Math.Round(p.Y * 304.8), Math.Round(p.Z * 304.8));

        private JObject Check(Document doc)
        {
            _limit = Parameters.Value<int?>("limit") ?? 50;
            var want = (Parameters["checks"] as JArray)?.Select(x => x.ToString()).ToHashSet();
            bool On(string c) => want == null || want.Contains(c);
            ElementId level = null;
            if (Parameters["level"] != null)
                level = new FilteredElementCollector(doc).OfClass(typeof(Level)).FirstOrDefault(l => string.Equals(l.Name, Parameters.Value<string>("level"), StringComparison.OrdinalIgnoreCase))?.Id
                    ?? throw new InvalidOperationException($"no level {Parameters.Value<string>("level")}");
            bool OnLevel(Element e) => level == null || e.LevelId == level;
            var model = new FilteredElementCollector(doc).WhereElementIsNotElementType().Where(e => e.Category != null && e.Category.CategoryType == CategoryType.Model && OnLevel(e)).ToList();
            var r = new JObject();
            if (On("revit_warnings")) r["revit_warnings"] = Warnings(doc, level);
            if (On("duplicates")) r["duplicates"] = Duplicates(model);
            if (On("rooms")) r["rooms"] = Rooms(doc, level);
            if (On("unhosted")) r["unhosted"] = Unhosted(model);
            var walls = model.OfType<Wall>().Where(w => w.Location is LocationCurve lc && lc.Curve is Line).ToList();
            if (On("wall_overlaps")) r["wall_overlaps"] = Overlaps(walls);
            if (On("free_wall_ends")) r["free_wall_ends"] = FreeEnds(walls);
            if (On("wall_tops")) r["wall_tops"] = Tops(doc, walls);
            if (On("clashes")) r["clashes"] = Clashes(doc, model);
            int total = r.Properties().Sum(p => p.Value.Value<int?>("count") ?? 0);
            return new JObject { ["model"] = doc.Title, ["level"] = Parameters["level"], ["problems"] = total, ["checks"] = r,
                ["next"] = total == 0 ? "No problems found by these checks" : "Look at each with see_view ids [...]; fix with modify_model" };
        }

        private JObject List(IEnumerable<JObject> items)
        {
            var all = items.ToList();
            return new JObject { ["count"] = all.Count, ["items"] = new JArray(all.Take(_limit)) };
        }

        private JObject Warnings(Document doc, ElementId level)
        {
            var groups = doc.GetWarnings()
                .Select(w => new { text = w.GetDescriptionText(), ids = w.GetFailingElements().Concat(w.GetAdditionalElements()).Distinct().ToList() })
                .Where(w => level == null || w.ids.Any(id => doc.GetElement(id)?.LevelId == level))
                .GroupBy(w => w.text);
            return List(groups.Select(g => new JObject
            {
                ["sentence"] = g.Key, ["times"] = g.Count(),
                ["ids"] = new JArray(g.SelectMany(w => w.ids).Distinct().Take(20).Select(x => x.Value)),
            }));
        }

        private JObject Duplicates(List<Element> model)
        {
            // the same category and type at the same place (to 10 mm): a batch run twice, or a copy left behind
            string Key(Element e)
            {
                string at = e.Location switch
                {
                    LocationPoint lp => $"{Math.Round(lp.Point.X / Tol)}:{Math.Round(lp.Point.Y / Tol)}:{Math.Round(lp.Point.Z / Tol)}",
                    LocationCurve lc => string.Join("|", new[] { lc.Curve.GetEndPoint(0), lc.Curve.GetEndPoint(1) }.Select(p => $"{Math.Round(p.X / Tol)}:{Math.Round(p.Y / Tol)}:{Math.Round(p.Z / Tol)}").OrderBy(s => s)),
                    _ => e.get_BoundingBox(null) is BoundingBoxXYZ b ? $"{Math.Round(b.Min.X / Tol)}:{Math.Round(b.Min.Y / Tol)}:{Math.Round(b.Max.X / Tol)}:{Math.Round(b.Max.Y / Tol)}:{Math.Round(b.Min.Z / Tol)}" : null,
                };
                return at == null ? null : $"{e.Category.Id.Value}/{e.GetTypeId().Value}/{e.LevelId.Value}/{at}";
            }
            return List(model.Where(e => !(e is Room)).GroupBy(Key).Where(g => g.Key != null && g.Count() > 1).Select(g => new JObject
            {
                ["sentence"] = $"{g.Count()} × {g.First().Category.Name} {g.First().Name} in the same place",
                ["ids"] = new JArray(g.Select(e => e.Id.Value)), ["keep"] = g.Min(e => e.Id.Value),
            }));
        }

        private JObject Rooms(Document doc, ElementId level)
        {
            var rooms = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms).Cast<Room>().Where(x => level == null || x.LevelId == level).ToList();
            var items = new List<JObject>();
            foreach (var g in rooms.Where(x => x.Location != null).GroupBy(x => $"{x.LevelId.Value}/{x.Number}"))
                if (g.Count() > 1) items.Add(new JObject { ["sentence"] = $"room number {g.First().Number} used {g.Count()} times on {doc.GetElement(g.First().LevelId)?.Name}", ["ids"] = new JArray(g.Select(x => x.Id.Value)) });
            foreach (Room x in rooms)
            {
                if (x.Location == null) items.Add(new JObject { ["sentence"] = $"room {x.Number} {x.Name} is not placed", ["ids"] = new JArray(x.Id.Value) });
                else if (x.Area <= 0) items.Add(new JObject { ["sentence"] = $"room {x.Number} {x.Name} is not enclosed (or redundant)", ["ids"] = new JArray(x.Id.Value), ["at_mm"] = Mm((x.Location as LocationPoint)?.Point) });
            }
            return List(items);
        }

        private JObject Unhosted(List<Element> model) =>
            List(model.OfType<FamilyInstance>().Where(f => (f.Category.Id.Value == (long)BuiltInCategory.OST_Doors || f.Category.Id.Value == (long)BuiltInCategory.OST_Windows) && f.Host == null)
                .Select(f => new JObject { ["sentence"] = $"{f.Category.Name} {f.Name} has no host wall", ["ids"] = new JArray(f.Id.Value), ["at_mm"] = Mm((f.Location as LocationPoint)?.Point) }));

        private JObject Overlaps(List<Wall> walls)
        {
            var items = new List<JObject>();
            for (int i = 0; i < walls.Count && items.Count < _limit; i++)
                for (int j = i + 1; j < walls.Count; j++)
                {
                    if (walls[i].LevelId != walls[j].LevelId) continue;
                    var a = (Line)((LocationCurve)walls[i].Location).Curve; var b = (Line)((LocationCurve)walls[j].Location).Curve;
                    if (Math.Abs(Math.Abs(a.Direction.DotProduct(b.Direction)) - 1) > 1e-3) continue;
                    var ua = Line.CreateUnbound(a.GetEndPoint(0), a.Direction);
                    if (ua.Distance(b.GetEndPoint(0)) > Tol * 5) continue;
                    double s0 = (b.GetEndPoint(0) - a.GetEndPoint(0)).DotProduct(a.Direction), s1 = (b.GetEndPoint(1) - a.GetEndPoint(0)).DotProduct(a.Direction);
                    double lo = Math.Max(0, Math.Min(s0, s1)), hi = Math.Min(a.Length, Math.Max(s0, s1));
                    if (hi - lo > Tol) items.Add(new JObject { ["sentence"] = $"walls overlap for {Math.Round((hi - lo) * 304.8)} mm", ["ids"] = new JArray(walls[i].Id.Value, walls[j].Id.Value), ["at_mm"] = Mm(a.GetEndPoint(0) + a.Direction * ((lo + hi) / 2)) });
                }
            return List(items);
        }

        private JObject FreeEnds(List<Wall> walls) =>
            List(walls.SelectMany(w => new[] { 0, 1 }.Where(end => ((LocationCurve)w.Location).get_ElementsAtJoin(end).Cast<Element>().All(x => x.Id == w.Id))
                .Select(end => new JObject { ["sentence"] = $"wall {w.Name} ends without meeting another wall", ["ids"] = new JArray(w.Id.Value), ["end"] = end, ["at_mm"] = Mm(((LocationCurve)w.Location).Curve.GetEndPoint(end)) })));

        private JObject Tops(Document doc, List<Wall> walls)
        {
            var roofs = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Roofs).WhereElementIsNotElementType().Select(x => x.get_BoundingBox(null)).Where(b => b != null).ToList();
            return List(walls.Where(w => w.get_Parameter(BuiltInParameter.WALL_TOP_IS_ATTACHED)?.AsInteger() != 1).Select(w => (w, b: w.get_BoundingBox(null))).Where(x => x.b != null)
                .Where(x => roofs.Any(r => r.Min.X < x.b.Max.X && r.Max.X > x.b.Min.X && r.Min.Y < x.b.Max.Y && r.Max.Y > x.b.Min.Y && r.Max.Z > x.b.Max.Z + Tol && r.Min.Z < x.b.Max.Z + 2000 / 304.8))
                .Select(x => new JObject { ["sentence"] = $"wall {x.w.Name} stops below the roof over it (top not attached)", ["ids"] = new JArray(x.w.Id.Value), ["top_mm"] = Math.Round(x.b.Max.Z * 304.8) }));
        }

        private JObject Clashes(Document doc, List<Element> model)
        {
            // structure, MEP, doors, windows and furniture against each other; walls with walls and joined pairs are left out
            var cats = new HashSet<long> { (long)BuiltInCategory.OST_StructuralColumns, (long)BuiltInCategory.OST_StructuralFraming, (long)BuiltInCategory.OST_DuctCurves,
                (long)BuiltInCategory.OST_PipeCurves, (long)BuiltInCategory.OST_CableTray, (long)BuiltInCategory.OST_Conduit, (long)BuiltInCategory.OST_Furniture,
                (long)BuiltInCategory.OST_Casework, (long)BuiltInCategory.OST_PlumbingFixtures, (long)BuiltInCategory.OST_MechanicalEquipment, (long)BuiltInCategory.OST_Stairs };
            var subjects = model.Where(e => cats.Contains(e.Category.Id.Value)).Take(1500).ToList();
            var seen = new HashSet<string>(); var items = new List<JObject>();
            foreach (Element a in subjects)
            {
                if (items.Count >= _limit) break;
                IEnumerable<ElementId> hits;
                try { hits = new FilteredElementCollector(doc).WhereElementIsNotElementType().WherePasses(new ElementIntersectsElementFilter(a)).ToElementIds(); }
                catch (Exception) { continue; }
                foreach (ElementId bId in hits)
                {
                    Element b = doc.GetElement(bId);
                    if (b?.Category == null || b.Category.CategoryType != CategoryType.Model || JoinGeometryUtils.AreElementsJoined(doc, a, b)) continue;
                    if (a is FamilyInstance fa && (fa.Host?.Id == b.Id || fa.SuperComponent?.Id == b.Id)) continue;
                    string key = string.Join("-", new[] { a.Id.Value, b.Id.Value }.OrderBy(x => x));
                    if (!seen.Add(key)) continue;
                    items.Add(new JObject { ["sentence"] = $"{a.Category.Name} {a.Name} clashes with {b.Category.Name} {b.Name}", ["ids"] = new JArray(a.Id.Value, b.Id.Value), ["at_mm"] = Mm((a.get_BoundingBox(null)?.Min + a.get_BoundingBox(null)?.Max) / 2) });
                }
            }
            return List(items);
        }
    }
}
