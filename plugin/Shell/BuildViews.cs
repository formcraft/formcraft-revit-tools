using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace revit_mcp_plugin.Shell
{
    /// <summary>
    /// Build's views on the model (U26, board build/B_RevitViews): colour the active view by progress
    /// (FMC_Construction_Status) or package (FMC_Trade_Package) with view filters, so the view zooms, prints, goes on
    /// sheets and works with Flow touch. A person runs it from the pane; it says what it will do first and is one Undo.
    /// It changes the view's filters only, never an element.
    /// </summary>
    public static class BuildViews
    {
        private const string Title = "Formcraft Build";
        private const string Prefix = "FMC_Build_";
        public static readonly IReadOnlyDictionary<string, string> Params = new Dictionary<string, string>
        {
            ["Progress"] = "FMC_Construction_Status",
            ["Package"] = "FMC_Trade_Package",
        };

        private static ExternalEvent _event;
        private static readonly Handler _handler = new Handler();

        public static void Register() => _event = ExternalEvent.Create(_handler);

        public static void Request(string mode)
        {
            _handler.Mode = mode;
            _event?.Raise();
        }

        private sealed class Handler : IExternalEventHandler
        {
            public string Mode = "Nothing";
            public void Execute(UIApplication app)
            {
                try { Colour(app.ActiveUIDocument, Mode); }
                catch (Exception e) { TaskDialog.Show(Title, "Colouring stopped: " + e.Message + "\n\nNothing was changed."); }
            }
            public string GetName() => "Formcraft Build: colour the view";
        }

        private static readonly Dictionary<string, Color> ProgressColours = new Dictionary<string, Color>(StringComparer.OrdinalIgnoreCase)
        {
            ["Done"] = new Color(27, 175, 122), ["Complete"] = new Color(27, 175, 122), ["Completed"] = new Color(27, 175, 122),
            ["In progress"] = new Color(232, 168, 56), ["Late"] = new Color(214, 69, 65), ["Delayed"] = new Color(214, 69, 65),
            ["Not started"] = new Color(170, 176, 186),
        };

        private static readonly Color[] Palette =
        {
            new Color(42, 120, 214), new Color(235, 104, 52), new Color(27, 175, 122), new Color(142, 92, 196), new Color(214, 69, 65),
            new Color(232, 168, 56), new Color(0, 150, 170), new Color(120, 120, 60), new Color(200, 90, 150), new Color(90, 110, 140),
            new Color(160, 120, 80), new Color(60, 160, 60), new Color(110, 70, 40), new Color(150, 150, 200),
        };

        public static void Colour(UIDocument ui, string mode)
        {
            if (ui == null) { TaskDialog.Show(Title, "Open a model first."); return; }
            Document doc = ui.Document;
            View view = ui.ActiveView;
            if (!view.AreGraphicsOverridesAllowed()) { TaskDialog.Show(Title, view.Name + " can't be coloured: open a plan, section, elevation or 3D view."); return; }
            if (view.ViewTemplateId != ElementId.InvalidElementId && doc.GetElement(view.ViewTemplateId) is View template
                && template.GetTemplateParameterIds().Contains(new ElementId(BuiltInParameter.VIS_GRAPHICS_FILTERS))
                && !template.GetNonControlledTemplateParameterIds().Contains(new ElementId(BuiltInParameter.VIS_GRAPHICS_FILTERS)))
            {
                TaskDialog.Show(Title, $"{view.Name} takes its filters from the view template {template.Name}. Use a view without one, or one made for Build.");
                return;
            }
            var ours = view.GetFilters().Where(id => (doc.GetElement(id)?.Name ?? "").StartsWith(Prefix)).ToList();

            if (mode == "Nothing")
            {
                if (ours.Count == 0) { TaskDialog.Show(Title, view.Name + " has no Build colours."); return; }
                using (var t = new Transaction(doc, "Formcraft Build: colours off"))
                {
                    t.Start();
                    foreach (var id in ours) view.RemoveFilter(id);
                    t.Commit();
                }
                return;
            }

            if (!Params.TryGetValue(mode, out string param)) return;
            Definition def = null;
            ElementBinding binding = null;
            var it = doc.ParameterBindings.ForwardIterator();
            while (it.MoveNext())
                if (it.Key?.Name == param) { def = it.Key; binding = it.Current as ElementBinding; break; }
            var shared = new FilteredElementCollector(doc).OfClass(typeof(SharedParameterElement)).Cast<SharedParameterElement>().FirstOrDefault(s => s.Name == param);
            if (def == null || binding == null || shared == null)
            {
                TaskDialog.Show(Title, $"{param} isn't in this model: it comes with the kit's shared parameters (the template binds them).");
                return;
            }

            var filterable = new HashSet<ElementId>(ParameterFilterUtilities.GetAllFilterableCategories());
            var cats = binding.Categories.Cast<Category>().Select(c => c.Id).Where(filterable.Contains).ToList();
            var counts = new Dictionary<string, int>();
            foreach (Element e in new FilteredElementCollector(doc, view.Id).WhereElementIsNotElementType())
            {
                if (e.Category == null || !cats.Contains(e.Category.Id)) continue;
                Parameter p = e.LookupParameter(param) ?? doc.GetElement(e.GetTypeId())?.LookupParameter(param);
                string v = p?.AsString()?.Trim() ?? "";
                if (v.Length == 0) continue;
                counts[v] = (counts.TryGetValue(v, out int n) ? n : 0) + 1;
            }
            if (counts.Count == 0) { TaskDialog.Show(Title, $"Nothing in {view.Name} has a value in {param} yet."); return; }

            var values = counts.OrderBy(k => k.Key).ToList();
            var d = new TaskDialog(Title)
            {
                MainInstruction = $"Colour {view.Name} by {mode.ToLowerInvariant()}?",
                MainContent = $"{values.Count} values of {param}: " + string.Join(", ", values.Take(12).Select(v => $"{v.Key} ({v.Value})")) + (values.Count > 12 ? ", …" : "") +
                              ".\nView filters only: no element changes. One Undo puts the view back.",
                CommonButtons = TaskDialogCommonButtons.Cancel,
            };
            d.AddCommandLink(TaskDialogCommandLinkId.CommandLink1, "Colour the view");
            if (d.Show() != TaskDialogResult.CommandLink1) return;

            ElementId solid = new FilteredElementCollector(doc).OfClass(typeof(FillPatternElement)).Cast<FillPatternElement>()
                .FirstOrDefault(f => f.GetFillPattern().IsSolidFill)?.Id ?? ElementId.InvalidElementId;
            using (var t = new Transaction(doc, "Formcraft Build: colour by " + mode.ToLowerInvariant()))
            {
                t.Start();
                foreach (var id in ours) view.RemoveFilter(id);
                var existing = new FilteredElementCollector(doc).OfClass(typeof(ParameterFilterElement)).Cast<ParameterFilterElement>()
                    .Where(f => f.Name.StartsWith(Prefix)).ToDictionary(f => f.Name, f => f);
                int k = 0;
                foreach (var v in values)
                {
                    string name = Prefix + mode + "_" + Safe(v.Key);
                    var rule = ParameterFilterRuleFactory.CreateEqualsRule(shared.Id, v.Key);
                    var filter = new ElementParameterFilter(rule);
                    if (!existing.TryGetValue(name, out ParameterFilterElement pfe)) pfe = ParameterFilterElement.Create(doc, name, cats, filter);
                    else { pfe.SetCategories(cats); pfe.SetElementFilter(filter); }
                    Color colour = mode == "Progress" && ProgressColours.TryGetValue(v.Key, out Color c) ? c : Palette[k++ % Palette.Length];
                    var ogs = new OverrideGraphicSettings()
                        .SetSurfaceForegroundPatternColor(colour).SetCutForegroundPatternColor(colour);
                    if (solid != ElementId.InvalidElementId) ogs.SetSurfaceForegroundPatternId(solid).SetCutForegroundPatternId(solid);
                    view.AddFilter(pfe.Id);
                    view.SetFilterOverrides(pfe.Id, ogs);
                }
                t.Commit();
            }
        }

        private static string Safe(string v)
        {
            var chars = v.Select(ch => char.IsLetterOrDigit(ch) || ch == '-' || ch == '_' ? ch : '_').ToArray();
            string s = new string(chars);
            return s.Length > 60 ? s.Substring(0, 60) : s;
        }
    }
}
