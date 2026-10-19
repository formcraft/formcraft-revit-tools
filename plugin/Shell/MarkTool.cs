using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Selection;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;
using Grid = System.Windows.Controls.Grid;
using TextBox = System.Windows.Controls.TextBox;
using ComboBox = System.Windows.Controls.ComboBox;

namespace revit_mcp_plugin.Shell
{
    /// <summary>
    /// Formcraft Flow › Mark (docs/PLAN_MARK_REVIEW.md, R4): point at the model and say what is wrong. Pick elements,
    /// elements in a linked model, or a place on a surface; the view, the camera, the section box and a picture of the
    /// view are kept; a small window takes the note, who fixes it (the AI modeller, a person, a discipline, anyone) and
    /// the priority. The ticket goes to the project's review register (fmc_review mark): marking never changes the model,
    /// so it works on live and shared models. A voice note is added from the pane's Review board.
    /// </summary>
    public static class MarkTool
    {
        private const string Title = "Formcraft Mark";

        public static void Run(UIDocument ui)
        {
            Document doc = ui.Document;
            string folder = ProjectFolder(doc);

            var how = new TaskDialog(Title) { MainInstruction = "What do you want to mark?", CommonButtons = TaskDialogCommonButtons.Cancel };
            how.AddCommandLink(TaskDialogCommandLinkId.CommandLink1, "Elements", "Pick one or more, then Finish.");
            how.AddCommandLink(TaskDialogCommandLinkId.CommandLink2, "Elements in a linked model", "Pick them through the link.");
            how.AddCommandLink(TaskDialogCommandLinkId.CommandLink3, "A place", "Click a point on any surface: an empty corner, a gap, a wall.");
            TaskDialogResult pick = how.Show();
            if (pick != TaskDialogResult.CommandLink1 && pick != TaskDialogResult.CommandLink2 && pick != TaskDialogResult.CommandLink3) return;

            var where = new JObject();
            var uids = new JArray();
            var ifc = new JArray();
            var linked = new JArray();
            XYZ point = null;
            if (pick == TaskDialogResult.CommandLink1)
            {
                IList<Reference> refs = ui.Selection.PickObjects(ObjectType.Element, "Pick what's wrong, then Finish");
                foreach (Reference r in refs)
                {
                    Element e = doc.GetElement(r);
                    if (e == null) continue;
                    uids.Add(e.UniqueId);
                    ifc.Add(IfcGuid(doc, e.Id));
                }
                point = Centre(refs.Select(r => doc.GetElement(r)).Where(e => e != null), ui.ActiveView);
            }
            else if (pick == TaskDialogResult.CommandLink2)
            {
                IList<Reference> refs = ui.Selection.PickObjects(ObjectType.LinkedElement, "Pick what's wrong in the link, then Finish");
                var picked = new List<XYZ>();
                foreach (Reference r in refs)
                {
                    if (!(doc.GetElement(r.ElementId) is RevitLinkInstance link)) continue;
                    Document ld = link.GetLinkDocument();
                    Element e = ld?.GetElement(r.LinkedElementId);
                    if (e == null) continue;
                    linked.Add(new JObject { ["link"] = ld.Title, ["unique_id"] = e.UniqueId });
                    BoundingBoxXYZ bb = e.get_BoundingBox(null);
                    if (bb != null) picked.Add(link.GetTotalTransform().OfPoint((bb.Min + bb.Max) / 2));
                }
                if (picked.Count > 0) point = new XYZ(picked.Average(p => p.X), picked.Average(p => p.Y), picked.Average(p => p.Z));
            }
            else
            {
                Reference r = ui.Selection.PickObject(ObjectType.PointOnElement, "Click the place on a surface");
                point = r.GlobalPoint;
            }
            where["unique_ids"] = uids;
            if (ifc.Count > 0 && ifc.All(g => !string.IsNullOrEmpty(g.Value<string>()))) where["ifc_guids"] = ifc;
            if (linked.Count > 0) where["linked"] = linked;
            if (point != null) where["point_mm"] = Mm(point);
            View view = ui.ActiveView;
            where["view"] = view.Name;
            if (view is View3D v3)
            {
                ViewOrientation3D o = v3.GetOrientation();
                where["camera"] = new JObject { ["eye"] = Mm(o.EyePosition), ["direction"] = Vec(o.ForwardDirection), ["up"] = Vec(o.UpDirection), ["perspective"] = v3.IsPerspective };
                if (v3.IsSectionBoxActive)
                {
                    BoundingBoxXYZ box = v3.GetSectionBox();
                    Transform t = box.Transform;
                    where["section_box"] = new JObject { ["min"] = Mm(t.OfPoint(box.Min)), ["max"] = Mm(t.OfPoint(box.Max)) };
                }
            }
            string picture = Picture(doc, view);

            var form = Ask(folder);
            if (form == null) return;
            if (string.IsNullOrWhiteSpace(form.Value<string>("project_folder")))
            {
                TaskDialog.Show(Title, "Name the project folder (the one with 01_WIP): the ticket is kept in its review register.");
                return;
            }
            var args = new JObject
            {
                ["action"] = "mark", ["where"] = where, ["picture"] = picture ?? "", ["by"] = Environment.UserName,
                ["project_folder"] = form["project_folder"], ["to"] = form["to"], ["assignee"] = form["assignee"], ["description"] = form["text"],
                ["priority"] = form["priority"], ["lead"] = form["lead"],
            };
            // the server runs off Revit's thread, so Revit stays responsive while the ticket is written
            CliResult res = Task.Run(() => ServerCli.RunAsync("fmc_review", args)).GetAwaiter().GetResult();
            if (!res.Ok) { TaskDialog.Show(Title, "The ticket wasn't saved: " + string.Join(" ", res.Reasons())); return; }
            string id = (res.Body["item"] as JObject)?.Value<string>("id") ?? "";
            TaskDialog.Show(Title, $"Marked {id}: {(res.Body["item"] as JObject)?.Value<string>("title")}.\n\nIt is in the project's review register; "
                + "open it in the pane's Review board to add a voice note.");
        }

        /// <summary>The project folder: the nearest folder above the model that has 01_WIP; empty when there is none.</summary>
        public static string ProjectFolder(Document doc)
        {
            try
            {
                string p = doc.IsWorkshared ? ModelPathUtils.ConvertModelPathToUserVisiblePath(doc.GetWorksharingCentralModelPath()) : doc.PathName;
                var dir = string.IsNullOrEmpty(p) ? null : new DirectoryInfo(Path.GetDirectoryName(p));
                while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, "01_WIP"))) dir = dir.Parent;
                return dir?.FullName ?? "";
            }
            catch (Exception) { return ""; }
        }

        private static XYZ Centre(IEnumerable<Element> elements, View view)
        {
            var boxes = elements.Select(e => e.get_BoundingBox(null) ?? e.get_BoundingBox(view)).Where(b => b != null).ToList();
            if (boxes.Count == 0) return null;
            return new XYZ(boxes.Average(b => (b.Min.X + b.Max.X) / 2), boxes.Average(b => (b.Min.Y + b.Max.Y) / 2), boxes.Average(b => (b.Min.Z + b.Max.Z) / 2));
        }

        private static JArray Mm(XYZ p) => new JArray(Math.Round(p.X * 304.8, 1), Math.Round(p.Y * 304.8, 1), Math.Round(p.Z * 304.8, 1));
        private static JArray Vec(XYZ v) => new JArray(Math.Round(v.X, 6), Math.Round(v.Y, 6), Math.Round(v.Z, 6));

        /// <summary>The active view as a PNG in the temp folder (the server copies it beside the ticket); null when Revit won't export it.</summary>
        private static string Picture(Document doc, View view)
        {
            try
            {
                string stem = Path.Combine(Path.GetTempPath(), "fmc_mark_" + DateTime.Now.ToString("yyyyMMdd_HHmmss"));
                var o = new ImageExportOptions
                {
                    ExportRange = ExportRange.SetOfViews, FilePath = stem, HLRandWFViewsFileType = ImageFileType.PNG, ShadowViewsFileType = ImageFileType.PNG,
                    ImageResolution = ImageResolution.DPI_150, ZoomType = ZoomFitType.FitToPage, PixelSize = 1600, FitDirection = FitDirectionType.Horizontal,
                };
                o.SetViewsAndSheets(new List<ElementId> { view.Id });
                doc.ExportImage(o);
                return Directory.GetFiles(Path.GetTempPath(), Path.GetFileName(stem) + "*.png").FirstOrDefault();
            }
            catch (Exception) { return null; }
        }

        /// <summary>
        /// The element's IFC GUID (22 characters), as Revit writes it on IFC export, for BCF readers that match by IFC.
        /// Empty when Revit has no export id for it.
        /// </summary>
        public static string IfcGuid(Document doc, ElementId id)
        {
            try { return Compress(ExportUtils.GetExportId(doc, id)); } catch (Exception) { return ""; }
        }

        private const string Chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

        /// <summary>A GUID in IFC's 22-character base-64 form (buildingSMART's algorithm).</summary>
        public static string Compress(Guid guid)
        {
            byte[] b = guid.ToByteArray();
            // the GUID's bytes in big-endian order, as IFC reads them
            uint d1 = BitConverter.ToUInt32(b, 0); ushort d2 = BitConverter.ToUInt16(b, 4), d3 = BitConverter.ToUInt16(b, 6);
            var num = new uint[6];
            num[0] = d1 / 16777216;
            num[1] = d1 % 16777216;
            num[2] = (uint)(d2 * 256 + d3 / 256);
            num[3] = (uint)((d3 % 256) * 65536 + b[8] * 256 + b[9]);
            num[4] = (uint)(b[10] * 65536 + b[11] * 256 + b[12]);
            num[5] = (uint)(b[13] * 65536 + b[14] * 256 + b[15]);
            var s = new char[22];
            int pos = 0;
            for (int i = 0; i < 6; i++)
            {
                int digits = i == 0 ? 2 : 4;
                uint n = num[i];
                for (int k = digits - 1; k >= 0; k--) { s[pos + k] = Chars[(int)(n % 64)]; n /= 64; }
                pos += digits;
            }
            return new string(s);
        }

        /// <summary>The note window: what is wrong, who fixes it, the priority, the lead discipline and the project folder.</summary>
        private static JObject Ask(string folder)
        {
            var w = new Window { Title = Title, Width = 460, SizeToContent = SizeToContent.Height, WindowStartupLocation = WindowStartupLocation.CenterScreen, ResizeMode = ResizeMode.NoResize };
            var grid = new Grid { Margin = new Thickness(14) };
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(120) });
            grid.ColumnDefinitions.Add(new ColumnDefinition());
            int row = 0;
            void Add(string label, FrameworkElement control)
            {
                grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
                var l = new TextBlock { Text = label, Margin = new Thickness(0, 6, 8, 6), VerticalAlignment = VerticalAlignment.Top };
                Grid.SetRow(l, row); Grid.SetRow(control, row); Grid.SetColumn(control, 1);
                control.Margin = new Thickness(0, 4, 0, 4);
                grid.Children.Add(l); grid.Children.Add(control);
                row++;
            }
            var text = new TextBox { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, Height = 90, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            var to = new ComboBox { ItemsSource = new[] { "The AI modeller", "Anyone", "A person", "A discipline" }, SelectedIndex = 0 };
            var assignee = new TextBox { ToolTip = "The person's name, or the discipline (A, S, M, E, P, FP…)" };
            var priority = new ComboBox { ItemsSource = new[] { "Critical", "High", "Medium", "Low" }, SelectedIndex = 1 };
            var lead = new TextBox { Text = "", ToolTip = "The lead discipline that owns the fix (MAN 10.5); empty: BIM" };
            var project = new TextBox { Text = folder };
            Add("What is wrong", text);
            Add("Who fixes it", to);
            Add("Person / discipline", assignee);
            Add("Priority", priority);
            Add("Lead discipline", lead);
            Add("Project folder", project);
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 10, 0, 0) };
            var ok = new Button { Content = "Mark it", Width = 90, IsDefault = true, Margin = new Thickness(0, 0, 8, 0) };
            var cancel = new Button { Content = "Cancel", Width = 90, IsCancel = true };
            buttons.Children.Add(ok); buttons.Children.Add(cancel);
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            Grid.SetRow(buttons, row); Grid.SetColumnSpan(buttons, 2);
            grid.Children.Add(buttons);
            w.Content = grid;
            ok.Click += (s, e) =>
            {
                if (string.IsNullOrWhiteSpace(text.Text)) { MessageBox.Show(w, "Say what is wrong.", Title); return; }
                if (to.SelectedIndex >= 2 && string.IsNullOrWhiteSpace(assignee.Text)) { MessageBox.Show(w, "Name the person or the discipline.", Title); return; }
                w.DialogResult = true;
            };
            text.Focus();
            if (w.ShowDialog() != true) return null;
            return new JObject
            {
                ["text"] = text.Text.Trim(), ["to"] = new[] { "ai", "anyone", "person", "discipline" }[to.SelectedIndex], ["assignee"] = assignee.Text.Trim(),
                ["priority"] = priority.SelectedItem as string ?? "High", ["lead"] = lead.Text.Trim(), ["project_folder"] = project.Text.Trim(),
            };
        }
    }
}
