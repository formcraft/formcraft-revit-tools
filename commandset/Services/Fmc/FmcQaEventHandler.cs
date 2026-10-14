using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// QA (U16) on the Revit main thread. facts reads what the kit's rules check (views, sheets, types, families, links,
    /// warnings) without changing anything, so it runs on live and shared models; select selects a result's elements
    /// and shows them (the Zoom on a QA row). The rules themselves are applied by the server (fmc_qa).
    /// </summary>
    public class FmcQaEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public string Action { get; set; } = "";
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                switch (Action)
                {
                    case "facts": Result = Facts(app); break;
                    case "select": Result = Select(app); break;
                    default: Error = $"Unknown FMC QA action '{Action}'"; break;
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

        public string GetName() => "FMC QA";

        private static string Value(Element e, string name)
        {
            Parameter p = e.LookupParameter(name);
            if (p == null || !p.HasValue) return "";
            return p.StorageType == StorageType.String ? p.AsString() ?? "" : p.AsValueString() ?? "";
        }

        private JObject Facts(UIApplication app)
        {
            Document doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("Open a model to run QA.");
            if (doc.IsFamilyDocument) throw new InvalidOperationException("QA runs on a project model.");
            var sheetParams = (Parameters["sheet"] as JArray)?.Select(x => x.ToString()).ToList() ?? new List<string>();
            var typeParams = (Parameters["type"] as JArray)?.Select(x => x.ToString()).ToList() ?? new List<string>();

            var views = new JArray();
            var sheets = new JArray();
            foreach (View v in new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>())
            {
                if (v is ViewSheet s)
                {
                    var values = new JObject();
                    foreach (string p in sheetParams) values[p] = Value(s, p);
                    sheets.Add(new JObject { ["id"] = s.Id.Value, ["number"] = s.SheetNumber, ["name"] = s.Name, ["parameters"] = values });
                }
                else views.Add(new JObject { ["id"] = v.Id.Value, ["name"] = v.Name, ["type"] = v.ViewType.ToString(), ["template"] = v.IsTemplate });
            }

            var types = new JArray();
            foreach (ElementType t in new FilteredElementCollector(doc).WhereElementIsElementType().Cast<ElementType>())
            {
                if (t.Category == null || t.Category.CategoryType != CategoryType.Model) continue;
                var values = new JObject();
                foreach (string p in typeParams) values[p] = Value(t, p);
                // bic: the BuiltInCategory name (OST_GenericModel), which the kit's rules name in applies_to.
                types.Add(new JObject { ["id"] = t.Id.Value, ["family"] = t.FamilyName, ["name"] = t.Name, ["category"] = t.Category.Name,
                    ["bic"] = ((BuiltInCategory)(int)t.Category.Id.Value).ToString(), ["parameters"] = values });
            }

            var families = new JArray(new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>()
                .Select(f => new JObject { ["id"] = f.Id.Value, ["name"] = f.Name, ["in_place"] = f.IsInPlace }));
            var links = new JArray(new FilteredElementCollector(doc).OfClass(typeof(RevitLinkInstance)).Cast<RevitLinkInstance>()
                .Select(l => new JObject { ["id"] = l.Id.Value, ["name"] = l.Name, ["pinned"] = l.Pinned }));

            return new JObject
            {
                ["model"] = doc.Title, ["views"] = views, ["sheets"] = sheets, ["types"] = types,
                ["families"] = families, ["links"] = links, ["warnings"] = doc.GetWarnings().Count,
            };
        }

        /// <summary>Selects the elements and shows them; selection never changes the model.</summary>
        private JObject Select(UIApplication app)
        {
            UIDocument ui = app.ActiveUIDocument ?? throw new InvalidOperationException("Open the model first.");
            var ids = (Parameters["element_ids"] as JArray)?.Select(x => new ElementId(x.Value<long>()))
                .Where(id => ui.Document.GetElement(id) != null).ToList() ?? new List<ElementId>();
            ui.Selection.SetElementIds(ids);
            try { if (ids.Count > 0) ui.ShowElements(ids); } catch { /* not visible in any view: the selection still holds */ }
            return new JObject { ["selected"] = ids.Count };
        }
    }
}
