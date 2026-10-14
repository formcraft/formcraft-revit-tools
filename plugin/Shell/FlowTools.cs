using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Selection;
using Formcraft.Shell.Services;

namespace revit_mcp_plugin.Shell
{
    /// <summary>
    /// Formcraft Flow's view tools (U22, boards flow/UI_Overlays and R_Flow), run by a person from the ribbon or the
    /// pane's quick tools: Section box (drag an area on a plan, your own 3D view opens with the box), Sheet Layout (align
    /// and distribute viewports) and Tag Tidy (selected tags only). Each says what it will do before it does it and is one
    /// Undo. They edit views and annotation, never model geometry, and they aren't AI tools.
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
