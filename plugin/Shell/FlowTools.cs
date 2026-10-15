using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Selection;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace revit_mcp_plugin.Shell
{
    /// <summary>
    /// Formcraft Flow's view tools (U22, boards flow/UI_Overlays and R_Flow), run by a person from the ribbon or the
    /// pane's quick tools: Section box (drag an area on a plan, your own 3D view opens with the box), View range (an area
    /// of a plan gets its own view range), Sheet Layout (align and distribute viewports) and Tag Tidy (selected tags
    /// only). Each says what it will do before it does it and is one Undo. They edit views and annotation, never model geometry, and they aren't AI tools.
    /// </summary>
    public static class FlowTools
    {
        private const string Title = "Formcraft Flow";
        private static ExternalEvent _event;
        private static readonly Handler _handler = new Handler();

        /// <summary>Called at start-up: the pane's quick tools run through this event (Revit's API context).</summary>
        public static void Register() => _event = ExternalEvent.Create(_handler);

        /// <summary>From the pane (not in Revit's API context): queue the tool.</summary>
        public static void Request(string tool)
        {
            _handler.Tool = tool;
            _event?.Raise();
        }

        private sealed class Handler : IExternalEventHandler
        {
            public string Tool = "";
            public void Execute(UIApplication app) => Run(app, Tool);
            public string GetName() => "Formcraft Flow: " + Tool;
        }

        /// <summary>From the ribbon (already in API context) or the handler above.</summary>
        public static void Run(UIApplication app, string tool)
        {
            UIDocument ui = app.ActiveUIDocument;
            if (ui == null) { TaskDialog.Show(Title, "Open a model first."); return; }
            try
            {
                switch (tool)
                {
                    case "Section box": case "Section Box": SectionBox(ui); break;
                    case "View range": ViewRangeArea(app, ui); break;
                    case ApplyViewRangeTool: ApplyViewRange(ui); break;
                    case "Align": case "Sheet Layout": Align(ui); break;
                    case "Tag Tidy": TagTidy(ui); break;
                    case "Shortcuts import": app.PostCommand(RevitCommandId.LookupPostableCommandId(PostableCommand.KeyboardShortcuts)); break;
                    default: TaskDialog.Show(Title, tool + " isn't a Flow tool."); break;
                }
            }
            catch (Autodesk.Revit.Exceptions.OperationCanceledException) { /* Esc: nothing changed */ }
            catch (Exception e) { TaskDialog.Show(Title, tool + " stopped: " + e.Message + "\n\nNothing was changed."); }
        }

        private static string Setting(string key, string fallback) => ShellHost.Settings?.Get("settings." + key) ?? fallback;
        private static double Mm(double v) => v / 304.8;

        private static bool Ask(string instruction, string content, string yes)
        {
            var d = new TaskDialog(Title) { MainInstruction = instruction, MainContent = content, CommonButtons = TaskDialogCommonButtons.Cancel };
            d.AddCommandLink(TaskDialogCommandLinkId.CommandLink1, yes, "One Undo puts it back.");
            return d.Show() == TaskDialogResult.CommandLink1;
        }

        // ---------- Section box ----------

        /// <summary>Drag an area on a plan: your own 3D view opens with a section box around it, from the level to the one above.</summary>
        private static void SectionBox(UIDocument ui)
        {
            Document doc = ui.Document;
            if (!(ui.ActiveView is ViewPlan plan) || plan.GenLevel == null)
            {
                TaskDialog.Show(Title, "Section box starts on a floor plan: open one, then drag the area.");
                return;
            }
            PickedBox box = ui.Selection.PickBox(PickBoxStyle.Crossing, "Section box: drag the area (Esc cancels)");
            double offset = Mm(Setting("flow.boxoffset", "300").StartsWith("1 m") ? 1000 : Setting("flow.boxoffset", "300").StartsWith("500") ? 500 : 300);
            double z0 = plan.GenLevel.Elevation, z1 = z0 + Mm(3000);
            if (Setting("flow.boxlevels", "true") != "false")
            {
                var above = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().Where(l => l.Elevation > z0 + 1e-6).OrderBy(l => l.Elevation).FirstOrDefault();
                if (above != null) z1 = above.Elevation;
            }
            XYZ min = new XYZ(Math.Min(box.Min.X, box.Max.X) - offset, Math.Min(box.Min.Y, box.Max.Y) - offset, z0 - offset);
            XYZ max = new XYZ(Math.Max(box.Min.X, box.Max.X) + offset, Math.Max(box.Min.Y, box.Max.Y) + offset, z1 + offset);
            string viewName = "FMC_3D_" + Environment.UserName;
            string size = $"{Math.Round((max.X - min.X) * 304.8)} x {Math.Round((max.Y - min.Y) * 304.8)} x {Math.Round((max.Z - min.Z) * 304.8)} mm";
            if (!Ask("Open your 3D view with this section box?", $"{plan.GenLevel.Name} up to the level above, {size}, offset {Math.Round(offset * 304.8)} mm. Your 3D view: {viewName}.", "Open 3D"))
                return;
            View3D v3;
            using (var t = new Transaction(doc, "Formcraft: section box"))
            {
                t.Start();
                v3 = new FilteredElementCollector(doc).OfClass(typeof(View3D)).Cast<View3D>().FirstOrDefault(v => !v.IsTemplate && v.Name == viewName);
                if (v3 == null)
                {
                    ViewFamilyType vft = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>()
                        .First(x => x.ViewFamily == ViewFamily.ThreeDimensional);
                    v3 = View3D.CreateIsometric(doc, vft.Id);
                    v3.Name = viewName;
                }
                v3.SetSectionBox(new BoundingBoxXYZ { Min = min, Max = max });
                v3.IsSectionBoxActive = true;
                t.Commit();
            }
            ui.ActiveView = v3;
        }

        // ---------- View range for an area ----------

        private const string ApplyViewRangeTool = "View range apply";

        /// <summary>What the person drew and what Apply will make, kept between the pick and the pane's Apply.</summary>
        private sealed class PendingArea
        {
            public Document Doc;
            public ElementId ViewId;
            public List<XYZ> Corners;
            public string Mode;           // "region": new plan region; "regionEdit"; "view": a view of its own; "edit": this view's range
            public ElementId RegionId;
            public string NewName;
            public string Template;       // the view template whose settings the new view takes before it is detached
        }

        private static PendingArea _pending;
        private static ViewRangeValues _values;

        /// <summary>From the pane's Apply (not in Revit's API context): queue the change.</summary>
        public static void RequestViewRange(ViewRangeValues values)
        {
            _values = values;
            Request(ApplyViewRangeTool);
        }

        /// <summary>
        /// Revit 2025's API has no way to make a plan region or to read or set its view range (only the element and its
        /// box). If a later Revit adds Autodesk.Revit.DB.PlanRegion with Create, GetViewRange and SetViewRange, this finds
        /// them at run time and the tool makes real plan regions; until then it makes a view of its own. Compiles on any
        /// Revit, because nothing here names the missing type.
        /// </summary>
        private static class NativeRegion
        {
            private static readonly Type RegionType = typeof(View).Assembly.GetType("Autodesk.Revit.DB.PlanRegion");
            private static readonly MethodInfo CreateMethod = RegionType?.GetMethod("Create", BindingFlags.Public | BindingFlags.Static, null,
                new[] { typeof(Document), typeof(ElementId), typeof(IList<CurveLoop>) }, null);
            private static readonly MethodInfo GetMethod = RegionType?.GetMethod("GetViewRange", Type.EmptyTypes);
            private static readonly MethodInfo SetMethod = RegionType?.GetMethod("SetViewRange", new[] { typeof(PlanViewRange) });

            public static bool CanCreate => CreateMethod != null && GetMethod != null && SetMethod != null;
            public static bool CanEdit(Element e) => GetMethod != null && SetMethod != null && RegionType.IsInstanceOfType(e);
            public static Element Create(Document doc, ElementId viewId, CurveLoop loop) =>
                (Element)Call(CreateMethod, null, doc, viewId, new List<CurveLoop> { loop });
            public static PlanViewRange Get(Element e) => (PlanViewRange)Call(GetMethod, e);
            public static void Set(Element e, PlanViewRange r) => Call(SetMethod, e, r);

            private static object Call(MethodInfo m, object target, params object[] args)
            {
                try { return m.Invoke(target, args); }
                catch (TargetInvocationException e) when (e.InnerException != null) { throw e.InnerException; }
            }
        }

        /// <summary>
        /// Drag a rectangle (or click corners) on a floor, ceiling or structural plan; the pane asks for the view range
        /// of that area, prefilled with the view's own. Apply makes a plan region where Revit's API can, otherwise a view of
        /// its own cropped to the area (FMC_VR_&lt;view&gt;_&lt;n&gt;). Clicking inside a plan region offers to change it.
        /// </summary>
        private static void ViewRangeArea(UIApplication app, UIDocument ui)
        {
            Document doc = ui.Document;
            var plan = ui.ActiveView as ViewPlan;
            if (plan == null || plan.IsTemplate || plan.GenLevel == null
                || (plan.ViewType != ViewType.FloorPlan && plan.ViewType != ViewType.CeilingPlan && plan.ViewType != ViewType.EngineeringPlan))
            {
                TaskDialog.Show(Title, "View range works on a floor, ceiling or structural plan: open one, then draw the area.");
                return;
            }
            bool ownView = plan.Name.StartsWith(ViewRange.ViewPrefix, StringComparison.OrdinalIgnoreCase);
            var d = new TaskDialog(Title)
            {
                MainInstruction = "Give an area of " + plan.Name + " its own view range",
                MainContent = "Draw the area, then set its range in the Formcraft pane. Nothing changes until you apply; model geometry is never touched.",
                CommonButtons = TaskDialogCommonButtons.Cancel,
            };
            d.AddCommandLink(TaskDialogCommandLinkId.CommandLink1, "Drag a rectangle", "Drag across the area, as for the section box.");
            d.AddCommandLink(TaskDialogCommandLinkId.CommandLink2, "Click corners",
                "Click each corner; click the first corner again (or press Esc) to finish. With touch, long-press each corner. Click inside a plan region first to change that region.");
            if (ownView) d.AddCommandLink(TaskDialogCommandLinkId.CommandLink3, "Change this view's range", "This is a Formcraft view-range view: set its range again.");
            var choice = d.Show();
            if (choice != TaskDialogResult.CommandLink1 && choice != TaskDialogResult.CommandLink2 && choice != TaskDialogResult.CommandLink3) return;

            var pending = new PendingArea { Doc = doc, ViewId = plan.Id };
            string area;
            if (choice == TaskDialogResult.CommandLink3)
            {
                pending.Mode = "edit";
                area = "the whole view";
            }
            else
            {
                List<XYZ> corners = choice == TaskDialogResult.CommandLink1 ? PickRectangle(ui, plan) : PickCorners(ui, plan, true);
                if (corners == null) return;
                Element region = RegionAt(doc, plan, corners);
                if (region != null)
                {
                    if (NativeRegion.CanEdit(region)) { pending.Mode = "regionEdit"; pending.RegionId = region.Id; }
                    else if (!OfferRegion(ui, region)) return;
                    else if (corners.Count < 3 && (corners = PickCorners(ui, plan, false)) == null) return;
                }
                pending.Corners = corners;
                if (pending.Mode == null) pending.Mode = NativeRegion.CanCreate ? "region" : "view";
                area = AreaText(plan, corners);
            }

            View template = doc.GetElement(plan.ViewTemplateId) as View;
            bool templateSetsRange = template != null && !template.GetNonControlledTemplateParameterIds().Contains(new ElementId(BuiltInParameter.PLAN_VIEW_RANGE));
            if (pending.Mode == "edit" && templateSetsRange)
            {
                TaskDialog.Show(Title, "The view template " + template.Name + " sets this view's range, so it can't be changed here. Change it in the template, or take the template off the view.");
                return;
            }
            string result;
            if (pending.Mode == "region") result = "Revit makes a plan region in " + plan.Name + " with this range. The rest of the plan keeps its own.";
            else if (pending.Mode == "regionEdit") result = "The plan region you clicked gets this range.";
            else if (pending.Mode == "edit") result = "This view's range changes. Nothing else does.";
            else
            {
                pending.NewName = ViewRange.NextViewName(plan.Name, new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Select(v => v.Name));
                if (templateSetsRange) pending.Template = template.Name;
                result = "Revit 2025's API can't make plan regions, so this makes a view of its own: " + pending.NewName + ", a copy of " + plan.Name
                         + " cropped to the area, with this range. The plan itself stays as it is."
                         + (templateSetsRange ? " Its template " + template.Name + " sets the range, so the new view takes the template's settings and is then detached from it." : "");
            }

            var request = new ViewRangeAreaRequest
            {
                ViewName = plan.Name,
                ViewKind = plan.ViewType == ViewType.CeilingPlan ? "Ceiling plan" : plan.ViewType == ViewType.EngineeringPlan ? "Structural plan" : "Floor plan",
                CeilingPlan = plan.ViewType == ViewType.CeilingPlan,
                AssociatedLevel = plan.GenLevel.Name,
                Levels = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().Select(l => new ViewRangeLevel(l.Name, l.Elevation * 304.8)).ToList(),
                Current = Read(doc, plan, pending.Mode == "regionEdit" ? NativeRegion.Get(doc.GetElement(pending.RegionId)) : plan.GetViewRange()),
                Area = area,
                Result = result,
                Native = pending.Mode == "region" || pending.Mode == "regionEdit",
            };
            _pending = pending;
            _values = null;
            ShellHost.ShowPane(app);
            ShellHost.Pane.ShowDialog(FlowViewRangeDialog.Create(request, values => { RequestViewRange(values); return null; }));
            ShellHost.Pane.Status = "View range: set the range in the dialog, then Apply. Cancel leaves nothing.";
        }

        /// <summary>A dragged rectangle, squared to the view (a rotated plan's rectangle is rotated in the model).</summary>
        private static List<XYZ> PickRectangle(UIDocument ui, View plan)
        {
            PickedBox box = ui.Selection.PickBox(PickBoxStyle.Crossing, "View range: drag the area (Esc cancels)");
            XYZ r = plan.RightDirection, u = plan.UpDirection, n = plan.ViewDirection;
            double u0 = box.Min.DotProduct(r), u1 = box.Max.DotProduct(r), v0 = box.Min.DotProduct(u), v1 = box.Max.DotProduct(u), w = box.Min.DotProduct(n);
            if (Math.Abs(u1 - u0) < Mm(100) || Math.Abs(v1 - v0) < Mm(100))
            {
                TaskDialog.Show(Title, "That area is too small: drag across it, or pick Click corners.");
                return null;
            }
            Func<double, double, XYZ> at = (a, b) => r * a + u * b + n * w;
            return new List<XYZ> { at(Math.Min(u0, u1), Math.Min(v0, v1)), at(Math.Max(u0, u1), Math.Min(v0, v1)), at(Math.Max(u0, u1), Math.Max(v0, v1)), at(Math.Min(u0, u1), Math.Max(v0, v1)) };
        }

        /// <summary>
        /// Corners clicked one by one (a long press with touch); clicking the first corner again, or Esc, closes the shape.
        /// The first click inside a plan region is enough to change that region.
        /// </summary>
        private static List<XYZ> PickCorners(UIDocument ui, View plan, bool regionClick)
        {
            var points = new List<XYZ>();
            double close = Mm(5) * Math.Max(1, plan.Scale); // 5 mm on paper
            while (true)
            {
                XYZ p;
                try
                {
                    p = ui.Selection.PickPoint(ObjectSnapTypes.Endpoints | ObjectSnapTypes.Intersections | ObjectSnapTypes.Nearest,
                        points.Count == 0 ? "View range: click the first corner, or inside a plan region to change it (Esc cancels)"
                                          : "View range: click corner " + (points.Count + 1) + "; click the first corner again or press Esc to finish");
                }
                catch (Autodesk.Revit.Exceptions.OperationCanceledException)
                {
                    if (points.Count >= 3) break;
                    return null;
                }
                catch (Autodesk.Revit.Exceptions.InvalidOperationException)
                {
                    TaskDialog.Show(Title, "This plan has no work plane to click on. Use Drag a rectangle, or set the work plane (Architecture › Work Plane › Set) first.");
                    return null;
                }
                if (regionClick && points.Count == 0 && RegionAt(ui.Document, plan, new List<XYZ> { p }) != null) return new List<XYZ> { p };
                if (points.Count >= 3 && Flat(p, plan).DistanceTo(Flat(points[0], plan)) <= close) break;
                if (points.Count > 0 && Flat(p, plan).DistanceTo(Flat(points[points.Count - 1], plan)) < Mm(10)) continue; // a double click
                points.Add(p);
            }
            double z = points[0].DotProduct(plan.ViewDirection);
            return points.Select(q => q - plan.ViewDirection * (q.DotProduct(plan.ViewDirection) - z)).ToList();
        }

        private static XYZ Flat(XYZ p, View plan) => new XYZ(p.DotProduct(plan.RightDirection), p.DotProduct(plan.UpDirection), 0);

        /// <summary>A plan region in this view whose box holds every point (a single click: the point), or null.</summary>
        private static Element RegionAt(Document doc, View plan, List<XYZ> points)
        {
            foreach (Element region in new FilteredElementCollector(doc, plan.Id).OfCategory(BuiltInCategory.OST_PlanRegion).WhereElementIsNotElementType())
            {
                BoundingBoxXYZ bb = region.get_BoundingBox(plan);
                if (bb == null) continue;
                if (points.All(p => p.X >= bb.Min.X - 1e-6 && p.X <= bb.Max.X + 1e-6 && p.Y >= bb.Min.Y - 1e-6 && p.Y <= bb.Max.Y + 1e-6)) return region;
            }
            return null;
        }

        /// <summary>Revit 2025 can't change a plan region's range from the API: select it for the person, or carry on.</summary>
        private static bool OfferRegion(UIDocument ui, Element region)
        {
            var d = new TaskDialog(Title)
            {
                MainInstruction = "This is inside a plan region",
                MainContent = "Revit 2025's API can't read or change a plan region's view range. Formcraft can select the region for you: then Properties › View Range › Edit sets it.",
                CommonButtons = TaskDialogCommonButtons.Cancel,
            };
            d.AddCommandLink(TaskDialogCommandLinkId.CommandLink1, "Select the plan region", "Then use Properties › View Range › Edit.");
            d.AddCommandLink(TaskDialogCommandLinkId.CommandLink2, "Make a view of its own here instead", "A copy of the plan cropped to this area, with its own range.");
            var choice = d.Show();
            if (choice == TaskDialogResult.CommandLink1) ui.Selection.SetElementIds(new List<ElementId> { region.Id });
            return choice == TaskDialogResult.CommandLink2;
        }

        private static string AreaText(View plan, List<XYZ> corners)
        {
            var flat = corners.Select(p => Flat(p, plan)).ToList();
            if (flat.Count == 1) return "a plan region";
            double w = (flat.Max(p => p.X) - flat.Min(p => p.X)) * 304.8, h = (flat.Max(p => p.Y) - flat.Min(p => p.Y)) * 304.8;
            return ViewRange.Size(w, h) + (flat.Count == 4 ? "" : ", " + flat.Count + " corners");
        }

        private static ViewRangeValues Read(Document doc, ViewPlan plan, PlanViewRange range)
        {
            Func<PlanViewPlane, ViewRangePlane> plane = p => new ViewRangePlane(LevelName(doc, plan, range.GetLevelId(p)), Math.Round(range.GetOffset(p) * 304.8));
            return new ViewRangeValues(plane(PlanViewPlane.TopClipPlane), plane(PlanViewPlane.CutPlane), plane(PlanViewPlane.BottomClipPlane), plane(PlanViewPlane.ViewDepthPlane));
        }

        private static string LevelName(Document doc, ViewPlan plan, ElementId id)
        {
            if (id == PlanViewRange.Unlimited) return ViewRange.Unlimited;
            if (id == PlanViewRange.LevelAbove) return ViewRange.LevelAbove;
            if (id == PlanViewRange.LevelBelow) return ViewRange.LevelBelow;
            if (id == PlanViewRange.Current) return plan.GenLevel.Name;
            return (doc.GetElement(id) as Level)?.Name ?? "";
        }

        private static ElementId LevelId(Document doc, ViewPlan plan, string name)
        {
            if (name == ViewRange.Unlimited) return PlanViewRange.Unlimited;
            if (name == ViewRange.LevelAbove) return PlanViewRange.LevelAbove;
            if (name == ViewRange.LevelBelow) return PlanViewRange.LevelBelow;
            if (name == plan.GenLevel.Name) return plan.GenLevel.Id;
            Level level = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().FirstOrDefault(l => l.Name == name);
            if (level == null) throw new InvalidOperationException("The level " + name + " isn't in the model any more.");
            return level.Id;
        }

        /// <summary>The person's values on a view range (the cut plane always on the plan's own level; a ceiling plan's bottom kept).</summary>
        private static PlanViewRange Fill(Document doc, ViewPlan plan, PlanViewRange range, ViewRangeValues v)
        {
            range.SetLevelId(PlanViewPlane.TopClipPlane, LevelId(doc, plan, v.Top.Level));
            range.SetOffset(PlanViewPlane.TopClipPlane, Mm(v.Top.OffsetMm));
            range.SetLevelId(PlanViewPlane.CutPlane, plan.GenLevel.Id);
            range.SetOffset(PlanViewPlane.CutPlane, Mm(v.Cut.OffsetMm));
            if (plan.ViewType != ViewType.CeilingPlan)
            {
                range.SetLevelId(PlanViewPlane.BottomClipPlane, LevelId(doc, plan, v.Bottom.Level));
                range.SetOffset(PlanViewPlane.BottomClipPlane, Mm(v.Bottom.OffsetMm));
            }
            range.SetLevelId(PlanViewPlane.ViewDepthPlane, LevelId(doc, plan, v.Depth.Level));
            range.SetOffset(PlanViewPlane.ViewDepthPlane, Mm(v.Depth.OffsetMm));
            return range;
        }

        private static CurveLoop Loop(List<XYZ> corners)
        {
            var loop = new CurveLoop();
            for (int i = 0; i < corners.Count; i++) loop.Append(Line.CreateBound(corners[i], corners[(i + 1) % corners.Count]));
            return loop;
        }

        /// <summary>The pane's Apply: one transaction, one Undo. A view element, never model geometry.</summary>
        private static void ApplyViewRange(UIDocument ui)
        {
            PendingArea p = _pending;
            ViewRangeValues v = _values;
            _pending = null;
            _values = null;
            if (p == null || v == null) return;
            Document doc = p.Doc;
            var plan = doc.IsValidObject ? doc.GetElement(p.ViewId) as ViewPlan : null;
            if (plan == null || plan.GenLevel == null)
            {
                TaskDialog.Show(Title, "The plan isn't open any more. Nothing was changed.");
                return;
            }
            View made = null;
            string done;
            using (var t = new Transaction(doc, "Formcraft: view range for an area"))
            {
                t.Start();
                if (p.Mode == "region")
                {
                    Element region = NativeRegion.Create(doc, plan.Id, Loop(p.Corners));
                    NativeRegion.Set(region, Fill(doc, plan, NativeRegion.Get(region), v));
                    done = "plan region made in " + plan.Name;
                }
                else if (p.Mode == "regionEdit")
                {
                    Element region = doc.GetElement(p.RegionId);
                    NativeRegion.Set(region, Fill(doc, plan, NativeRegion.Get(region), v));
                    done = "plan region changed in " + plan.Name;
                }
                else if (p.Mode == "edit")
                {
                    plan.SetViewRange(Fill(doc, plan, plan.GetViewRange(), v));
                    done = plan.Name + " has its new range";
                }
                else
                {
                    var copy = (ViewPlan)doc.GetElement(plan.Duplicate(ViewDuplicateOption.Duplicate));
                    copy.Name = p.NewName;
                    if (p.Template != null)
                    {
                        copy.ApplyViewTemplateParameters(doc.GetElement(plan.ViewTemplateId) as View);
                        copy.ViewTemplateId = ElementId.InvalidElementId;
                    }
                    Parameter scope = copy.get_Parameter(BuiltInParameter.VIEWER_VOLUME_OF_INTEREST_CROP);
                    if (scope != null && !scope.IsReadOnly && scope.AsElementId() != ElementId.InvalidElementId) scope.Set(ElementId.InvalidElementId);
                    Crop(copy, p.Corners);
                    copy.SetViewRange(Fill(doc, copy, copy.GetViewRange(), v));
                    made = copy;
                    done = p.NewName + " made, cropped to the area";
                }
                t.Commit();
            }
            if (made != null && doc.Equals(ui.Document)) ui.ActiveView = made;
            ShellHost.Pane.Status = "View range: " + done + ". One Undo takes it back.";
        }

        /// <summary>Crops a view to the drawn shape; a rectangle round it when Revit won't take the shape.</summary>
        private static void Crop(View view, List<XYZ> corners)
        {
            view.CropBoxActive = true;
            view.CropBoxVisible = true;
            ViewCropRegionShapeManager shape = view.GetCropRegionShapeManager();
            CurveLoop loop = Loop(corners);
            if (shape.CanHaveShape && shape.IsCropRegionShapeValid(loop))
            {
                shape.SetCropShape(loop);
                return;
            }
            BoundingBoxXYZ crop = view.CropBox;
            Transform toView = crop.Transform.Inverse;
            var local = corners.Select(c => toView.OfPoint(c)).ToList();
            crop.Min = new XYZ(local.Min(c => c.X), local.Min(c => c.Y), crop.Min.Z);
            crop.Max = new XYZ(local.Max(c => c.X), local.Max(c => c.Y), crop.Max.Z);
            view.CropBox = crop;
        }

        // ---------- Sheet Layout ----------

        /// <summary>Selected viewports on the active sheet (or all of them): align tops or lefts, or distribute evenly across.</summary>
        private static void Align(UIDocument ui)
        {
            Document doc = ui.Document;
            if (!(ui.ActiveView is ViewSheet sheet)) { TaskDialog.Show(Title, "Sheet Layout works on a sheet: open one."); return; }
            var picked = ui.Selection.GetElementIds().Select(id => doc.GetElement(id)).OfType<Viewport>().ToList();
            var ports = picked.Count >= 2 ? picked : sheet.GetAllViewports().Select(id => (Viewport)doc.GetElement(id)).ToList();
            if (ports.Count < 2) { TaskDialog.Show(Title, "Sheet Layout needs two or more viewports on the sheet."); return; }

            var d = new TaskDialog(Title)
            {
                MainInstruction = $"Lay out {ports.Count} viewports on {sheet.SheetNumber}?",
                MainContent = (picked.Count >= 2 ? "The selected viewports." : "Every viewport on the sheet (select some first to limit it).") + " Nothing moves until you pick; one Undo puts them back.",
                CommonButtons = TaskDialogCommonButtons.Cancel,
            };
            d.AddCommandLink(TaskDialogCommandLinkId.CommandLink1, "Align tops", "Every top edge on the highest one");
            d.AddCommandLink(TaskDialogCommandLinkId.CommandLink2, "Align left edges", "Every left edge on the leftmost one");
            d.AddCommandLink(TaskDialogCommandLinkId.CommandLink3, "Distribute evenly across", "Equal gaps between the leftmost and rightmost");
            var choice = d.Show();
            if (choice != TaskDialogResult.CommandLink1 && choice != TaskDialogResult.CommandLink2 && choice != TaskDialogResult.CommandLink3) return;

            var outlines = ports.ToDictionary(p => p, p => p.GetBoxOutline());
            using (var t = new Transaction(doc, "Formcraft: sheet layout"))
            {
                t.Start();
                if (choice == TaskDialogResult.CommandLink1)
                {
                    double top = outlines.Values.Max(o => o.MaximumPoint.Y);
                    foreach (var p in ports) p.SetBoxCenter(p.GetBoxCenter() + new XYZ(0, top - outlines[p].MaximumPoint.Y, 0));
                }
                else if (choice == TaskDialogResult.CommandLink2)
                {
                    double left = outlines.Values.Min(o => o.MinimumPoint.X);
                    foreach (var p in ports) p.SetBoxCenter(p.GetBoxCenter() + new XYZ(left - outlines[p].MinimumPoint.X, 0, 0));
                }
                else
                {
                    var order = ports.OrderBy(p => outlines[p].MinimumPoint.X).ToList();
                    double start = outlines[order[0]].MinimumPoint.X, end = outlines[order[order.Count - 1]].MaximumPoint.X;
                    double widths = order.Sum(p => outlines[p].MaximumPoint.X - outlines[p].MinimumPoint.X);
                    double gap = (end - start - widths) / (order.Count - 1), x = start;
                    foreach (var p in order)
                    {
                        double w = outlines[p].MaximumPoint.X - outlines[p].MinimumPoint.X;
                        p.SetBoxCenter(p.GetBoxCenter() + new XYZ(x - outlines[p].MinimumPoint.X, 0, 0));
                        x += w + gap;
                    }
                }
                t.Commit();
            }
        }

        // ---------- Tag Tidy ----------

        /// <summary>
        /// Selected tags only (tags a person placed move only when that person selects them, board manage/PaneAnnotate):
        /// line up in a row or a column, keep text horizontal, drop leaders that aren't needed, remove duplicates.
        /// </summary>
        private static void TagTidy(UIDocument ui)
        {
#if !REVIT2024_OR_GREATER
            TaskDialog.Show(Title, "Tag Tidy needs Revit 2024 or later.");
        }
#else
            Document doc = ui.Document;
            View view = ui.ActiveView;
            var tags = ui.Selection.GetElementIds().Select(id => doc.GetElement(id)).OfType<IndependentTag>().ToList();
            if (tags.Count == 0) { TaskDialog.Show(Title, "Tag Tidy works on the tags you select: select them in the view first."); return; }

            var duplicates = tags.GroupBy(t => string.Join(",", t.GetTaggedLocalElementIds().Select(i => i.ToString()).OrderBy(i => i)) + "|" + t.GetTypeId())
                .SelectMany(g => g.Skip(1)).ToList();
            var d = new TaskDialog(Title)
            {
                MainInstruction = $"Tidy {tags.Count} selected tags?",
                MainContent = (duplicates.Count > 0 ? $"{duplicates.Count} of them repeat another tag on the same element. " : "") + "Nothing moves until you pick; one Undo puts them back.",
                CommonButtons = TaskDialogCommonButtons.Cancel,
            };
            d.AddCommandLink(TaskDialogCommandLinkId.CommandLink1, "Line up in a row", "Same height as the first tag");
            d.AddCommandLink(TaskDialogCommandLinkId.CommandLink2, "Line up in a column", "Same left-right position as the first tag");
            d.AddCommandLink(TaskDialogCommandLinkId.CommandLink3, "Leaders only where needed", "A tag close to its element loses its leader");
            if (duplicates.Count > 0) d.AddCommandLink(TaskDialogCommandLinkId.CommandLink4, $"Remove {duplicates.Count} duplicate tags", "Keeps one tag per element and tag type");
            var choice = d.Show();
            if (choice == TaskDialogResult.Cancel || choice == TaskDialogResult.Close) return;

            using (var t = new Transaction(doc, "Formcraft: Tag Tidy"))
            {
                t.Start();
                XYZ first = tags[0].TagHeadPosition;
                bool horizontal = Setting("flow.tagtidy", "Keep text horizontal").Split('|').Contains("Keep text horizontal");
                foreach (IndependentTag tag in tags)
                {
                    if (choice == TaskDialogResult.CommandLink1 || choice == TaskDialogResult.CommandLink2)
                    {
                        XYZ p = tag.TagHeadPosition;
                        XYZ q = p - view.Origin, f = first - view.Origin;
                        double u = q.DotProduct(view.RightDirection), v = q.DotProduct(view.UpDirection);
                        if (choice == TaskDialogResult.CommandLink1) v = f.DotProduct(view.UpDirection); else u = f.DotProduct(view.RightDirection);
                        tag.TagHeadPosition = view.Origin + view.RightDirection * u + view.UpDirection * v + view.ViewDirection * q.DotProduct(view.ViewDirection);
                        if (horizontal && tag.TagOrientation != TagOrientation.Horizontal) { try { tag.TagOrientation = TagOrientation.Horizontal; } catch (Autodesk.Revit.Exceptions.ArgumentException) { /* this tag type can't turn */ } }
                    }
                    else if (choice == TaskDialogResult.CommandLink3 && tag.HasLeader)
                    {
                        var target = tag.GetTaggedLocalElements().FirstOrDefault();
                        BoundingBoxXYZ bb = target?.get_BoundingBox(view);
                        if (bb != null)
                        {
                            XYZ c = (bb.Min + bb.Max) / 2;
                            double reach = Math.Max((bb.Max - bb.Min).GetLength() / 2, Mm(300) * view.Scale / 100);
                            if (tag.TagHeadPosition.DistanceTo(c) <= reach) tag.HasLeader = false;
                        }
                    }
                }
                if (choice == TaskDialogResult.CommandLink4) doc.Delete(duplicates.Select(x => x.Id).ToList());
                t.Commit();
            }
        }
#endif
    }

    /// <summary>The pane's quick tools and Settings › Flow reach Revit through this.</summary>
    public sealed class RevitFlowTools : IFlowTools
    {
        public void Run(string tool) => FlowTools.Request(tool);
        public void OpenShortcutsImport() => FlowTools.Request("Shortcuts import");
    }
}
