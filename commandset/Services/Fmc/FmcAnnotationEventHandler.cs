using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Annotation (U19) on the Revit main thread, read-only. facts lists the text types, line patterns, dimension types
    /// and tag families the server checks against the kit's annotation standard; missing_tags counts the doors, windows,
    /// rooms and electrical fixtures with no tag in the current view or the views on the current sheet.
    /// </summary>
    public class FmcAnnotationEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public string Action { get; set; } = "";
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return FmcBusy.Wait(_resetEvent, timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using var target = FmcTarget.Resolve(app, Parameters, mayOpen: true);
                switch (Action)
                {
                    case "facts": Result = Facts(target.Doc); break;
                    case "missing_tags": Result = MissingTags(target); break;
                    default: Error = $"Unknown FMC annotation action '{Action}'"; break;
                }
            }
            catch (Exception ex)
            {
                Error = ex.Message;
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public string GetName() => "FMC annotation";

        private static JObject Facts(Document doc)
        {
            var text = new JArray(new FilteredElementCollector(doc).OfClass(typeof(TextNoteType)).Cast<TextNoteType>().Select(t => new JObject
            {
                ["id"] = t.Id.Value, ["name"] = t.Name, ["font"] = t.get_Parameter(BuiltInParameter.TEXT_FONT)?.AsString() ?? "",
                ["size_mm"] = Math.Round(UnitUtils.ConvertFromInternalUnits(t.get_Parameter(BuiltInParameter.TEXT_SIZE)?.AsDouble() ?? 0, UnitTypeId.Millimeters), 2),
            }));
            var patterns = new JArray(new FilteredElementCollector(doc).OfClass(typeof(LinePatternElement)).Cast<LinePatternElement>()
                .Select(p => new JObject { ["id"] = p.Id.Value, ["name"] = p.Name }));
            var dims = new JArray(new FilteredElementCollector(doc).OfClass(typeof(DimensionType)).Cast<DimensionType>()
                .Where(d => d.StyleType == DimensionStyleType.Linear || d.StyleType == DimensionStyleType.Angular || d.StyleType == DimensionStyleType.Radial
                         || d.StyleType == DimensionStyleType.Diameter || d.StyleType == DimensionStyleType.ArcLength)
                .Select(d => new JObject { ["id"] = d.Id.Value, ["name"] = d.Name }));
            var tags = new JArray(new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>()
                .Where(f => f.FamilyCategory != null && f.FamilyCategory.CategoryType == CategoryType.Annotation && f.FamilyCategory.Name.EndsWith("Tags"))
                .Select(f => new JObject { ["id"] = f.Id.Value, ["name"] = f.Name, ["category"] = f.FamilyCategory.Name }));
            return new JObject { ["model"] = doc.Title, ["text_types"] = text, ["line_patterns"] = patterns, ["dimension_types"] = dims, ["tag_families"] = tags };
        }

        private static readonly (string Name, BuiltInCategory Category, BuiltInCategory TagCategory)[] Tagged =
        {
            ("Doors", BuiltInCategory.OST_Doors, BuiltInCategory.OST_DoorTags),
            ("Windows", BuiltInCategory.OST_Windows, BuiltInCategory.OST_WindowTags),
            ("Rooms", BuiltInCategory.OST_Rooms, BuiltInCategory.OST_RoomTags),
            ("Electrical fixtures", BuiltInCategory.OST_ElectricalFixtures, BuiltInCategory.OST_ElectricalFixtureTags),
        };

        /// <summary>
        /// The views in scope: the active view, or every view on the active sheet (or on the sheet that holds the active
        /// view). In the background there is no active view, so a sheet number (<c>sheet</c>) names the sheet.
        /// </summary>
        private List<View> Views(FmcTarget target)
        {
            Document doc = target.Doc;
            string sheetNumber = (Parameters.Value<string>("sheet") ?? "").Trim();
            if (target.Ui == null || sheetNumber.Length > 0)
            {
                if (sheetNumber.Length == 0) throw new InvalidOperationException($"{doc.Title} is open in the background, so there is no current view: pass sheet (a sheet number) to check the views on it.");
                ViewSheet named = new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>()
                    .FirstOrDefault(s => string.Equals(s.SheetNumber, sheetNumber, StringComparison.OrdinalIgnoreCase))
                    ?? throw new InvalidOperationException($"No sheet {sheetNumber} in {doc.Title}.");
                return named.GetAllPlacedViews().Select(id => doc.GetElement(id) as View)
                    .Where(v => v != null && !v.IsTemplate && !(v is ViewSchedule) && v.ViewType != ViewType.Legend).ToList();
            }
            UIDocument ui = target.Ui;
            View active = ui.ActiveView;
            bool sheet = (Parameters.Value<string>("scope") ?? "current_view") == "sheet_views";
            ViewSheet onSheet = active as ViewSheet;
            if (sheet && onSheet == null)
                onSheet = new FilteredElementCollector(doc).OfClass(typeof(Viewport)).Cast<Viewport>()
                    .Where(v => v.ViewId == active.Id).Select(v => doc.GetElement(v.SheetId) as ViewSheet).FirstOrDefault();
            var views = sheet && onSheet != null ? onSheet.GetAllPlacedViews().Select(id => doc.GetElement(id) as View).ToList() : new List<View> { active };
            return views.Where(v => v != null && !v.IsTemplate && !(v is ViewSheet) && !(v is ViewSchedule) && v.ViewType != ViewType.Legend).ToList();
        }

        private JObject MissingTags(FmcTarget target)
        {
            Document doc = target.Doc;
            var views = Views(target);
            var rows = new JArray();
            foreach (var (name, category, tagCategory) in Tagged)
            {
                var untagged = new HashSet<long>();
                foreach (View v in views)
                {
                    var tagged = new HashSet<long>();
                    if (category == BuiltInCategory.OST_Rooms)
                        foreach (RoomTag t in new FilteredElementCollector(doc, v.Id).OfCategory(BuiltInCategory.OST_RoomTags).WhereElementIsNotElementType().OfType<RoomTag>())
                            tagged.Add(t.TaggedLocalRoomId.Value);
                    else
                        foreach (IndependentTag t in new FilteredElementCollector(doc, v.Id).OfClass(typeof(IndependentTag)).Cast<IndependentTag>())
                            foreach (ElementId id in t.GetTaggedLocalElementIds()) tagged.Add(id.Value);
                    foreach (Element e in new FilteredElementCollector(doc, v.Id).OfCategory(category).WhereElementIsNotElementType())
                    {
                        if (category == BuiltInCategory.OST_Rooms && e is Room r && r.Area <= 0) continue;
                        if (!tagged.Contains(e.Id.Value)) untagged.Add(e.Id.Value);
                    }
                }
                var tagFamily = new FilteredElementCollector(doc).OfCategory(tagCategory).WhereElementIsElementType().Cast<FamilySymbol>()
                    .Select(s => s.FamilyName).Distinct().OrderBy(n => n.StartsWith("FMC_TAG_") ? 0 : 1).FirstOrDefault() ?? "none loaded";
                rows.Add(new JObject { ["category"] = name, ["untagged"] = untagged.Count, ["tag_family"] = tagFamily, ["ids"] = new JArray(untagged.Take(500)) });
            }
            return new JObject { ["views"] = new JArray(views.Select(v => v.Name)), ["categories"] = rows };
        }
    }
}
