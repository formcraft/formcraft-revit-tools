using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// One selection and one search across the apps (docs/PLAN_ENGINEERING_HUB.md, X1 and X3), on the Revit main thread.
    /// get reads the current selection (UniqueIds, element ids, categories, the model, and elements picked through links);
    /// show selects elements by UniqueId or element id and zooms to them, and says which it couldn't find; find looks for
    /// elements by mark, number or name and, with touching, what touches them. None of them opens a transaction: the
    /// selection and the view are the person's, the model never changes.
    /// </summary>
    public class FmcSelectionEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public string Action { get; set; } = "";
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft selection";

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try
            {
                switch (Action)
                {
                    case "get": Result = Get(app); break;
                    case "show": Result = Show(app); break;
                    case "find": Result = Find(app); break;
                    default: Error = $"Unknown selection action '{Action}'"; break;
                }
            }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        /// <summary>What every reply says about one element: enough for the identity map and for Navisworks (id + model).</summary>
        private static JObject Describe(Document doc, Element e) => new JObject
        {
            ["unique_id"] = e.UniqueId, ["element_id"] = e.Id.Value, ["category"] = e.Category?.Name ?? "",
            ["name"] = e.Name ?? "", ["mark"] = e.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString() ?? "",
            ["model"] = doc.Title, ["path"] = doc.PathName ?? "",
        };

        private JObject Get(UIApplication app)
        {
            using var target = FmcTarget.Resolve(app, Parameters, mayOpen: false);
            UIDocument ui = target.RequireUi("Reading the selection");
            Document doc = ui.Document;
            int limit = Math.Max(1, Math.Min(Parameters.Value<int?>("limit") ?? 500, 5000));
            var ids = ui.Selection.GetElementIds().ToList();
            var elements = new JArray(ids.Take(limit).Select(id => doc.GetElement(id)).Where(e => e != null).Select(e => Describe(doc, e)));
            var linked = new JArray();
#if REVIT2023_OR_GREATER
            // elements picked inside a link (Tab-select): their own model's ids, so Navisworks finds them in that model's NWC
            foreach (Reference r in ui.Selection.GetReferences().Where(r => r.LinkedElementId != ElementId.InvalidElementId).Take(limit))
            {
                if (!(doc.GetElement(r.ElementId) is RevitLinkInstance inst) || inst.GetLinkDocument() == null) continue;
                Element le = inst.GetLinkDocument().GetElement(r.LinkedElementId);
                if (le == null) continue;
                JObject o = Describe(inst.GetLinkDocument(), le);
                o["link"] = inst.GetLinkDocument().Title;
                linked.Add(o);
            }
#endif
            return new JObject { ["model"] = doc.Title, ["path"] = doc.PathName ?? "", ["count"] = ids.Count, ["elements"] = elements, ["linked"] = linked };
        }

        /// <summary>
        /// Selects by UniqueId, and by element id when the id came from this model (a Navisworks item names its source
        /// model; one from another model is reported, never guessed). Zooms to them unless zoom is false.
        /// </summary>
        private JObject Show(UIApplication app)
        {
            using var target = FmcTarget.Resolve(app, Parameters, mayOpen: false);
            // select false only looks them up (the hub needs an element's id and model for Navisworks): no view needed
            bool select = Parameters.Value<bool?>("select") != false;
            UIDocument ui = select ? target.RequireUi("Selecting elements") : null;
            Document doc = target.Doc;
            var found = new List<Element>();
            var missing = new JArray();
            var elsewhere = new JArray();
            foreach (string u in (Parameters["unique_ids"] as JArray ?? new JArray()).Select(t => t.Value<string>()).Where(s => !string.IsNullOrEmpty(s)))
            {
                if (doc.GetElement(u) is Element e) found.Add(e); else missing.Add(u);
            }
            foreach (JToken t in Parameters["element_ids"] as JArray ?? new JArray())
            {
                // an id alone, or { id, model }
                string id = t is JObject o ? o.Value<string>("id") : t.Value<string>();
                string model = t is JObject m ? m.Value<string>("model") ?? "" : "";
                if (model.Length > 0 && !SameModel(doc, model)) { elsewhere.Add(new JObject { ["id"] = id, ["model"] = model }); continue; }
                if (long.TryParse(id, out long n) && doc.GetElement(new ElementId(n)) is Element e) found.Add(e); else missing.Add(id);
            }
            found = found.GroupBy(e => e.Id.Value).Select(g => g.First()).ToList();
            var ids = found.Select(e => e.Id).ToList();
            if (select) ui.Selection.SetElementIds(ids);
            bool zoomed = false;
            if (select && ids.Count > 0 && Parameters.Value<bool?>("zoom") != false)
            {
                try { ui.ShowElements(ids); zoomed = true; } catch { /* not visible in any open view: the selection still holds */ }
            }
            return new JObject
            {
                ["model"] = doc.Title, ["selected"] = select ? ids.Count : 0, ["zoomed"] = zoomed,
                ["found"] = new JArray(found.Select(e => Describe(doc, e))), ["missing"] = missing, ["in_other_models"] = elsewhere,
            };
        }

        /// <summary>A Navisworks source file (an .nwc or .rvt path) is this model when its name starts with this model's title.</summary>
        public static bool SameModel(Document doc, string model)
        {
            string a = System.IO.Path.GetFileNameWithoutExtension(model ?? "");
            string b = System.IO.Path.GetFileNameWithoutExtension(doc.Title ?? "");
            if (a.Length == 0 || b.Length == 0) return true;
            return a.StartsWith(b, StringComparison.OrdinalIgnoreCase) || b.StartsWith(a, StringComparison.OrdinalIgnoreCase);
        }

        private static readonly (string Field, BuiltInParameter Bip)[] Fields =
        {
            ("mark", BuiltInParameter.ALL_MODEL_MARK), ("type mark", BuiltInParameter.ALL_MODEL_TYPE_MARK),
            ("number", BuiltInParameter.ROOM_NUMBER), ("room name", BuiltInParameter.ROOM_NAME),
            ("sheet number", BuiltInParameter.SHEET_NUMBER), ("comments", BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS),
        };

        /// <summary>
        /// Elements whose mark, type mark, number, room name, sheet number or name is the query (or contains it, with
        /// partial); comments match when they hold it (the recipe tree's FMC:&lt;node&gt; mark). With touching, the model
        /// elements whose boxes meet the first few matches' boxes (25 mm apart at most): what a coordinator asks next.
        /// </summary>
        private JObject Find(UIApplication app)
        {
            using var target = FmcTarget.Resolve(app, Parameters, mayOpen: true);
            Document doc = target.Doc;
            string q = (Parameters.Value<string>("query") ?? "").Trim();
            if (q.Length == 0) throw new ArgumentException("query is needed: a mark, a number or a name");
            bool partial = Parameters.Value<bool?>("partial") == true;
            int limit = Math.Max(1, Math.Min(Parameters.Value<int?>("limit") ?? 50, 500));
            bool Hit(string v, bool contains) => !string.IsNullOrEmpty(v) &&
                (contains || partial ? v.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0 : string.Equals(v.Trim(), q, StringComparison.OrdinalIgnoreCase));

            var matches = new List<(Element E, string Field)>();
            // Owner 26 Oct: an element id or UniqueId is looked up directly (ids made minutes ago were "not found")
            Element byId = long.TryParse(q, out long idValue) ? doc.GetElement(new ElementId(idValue)) : q.Length > 30 ? doc.GetElement(q) : null;
            if (byId != null && byId.Category != null) matches.Add((byId, "element id"));
            foreach (Element e in byId != null ? Enumerable.Empty<Element>() : new FilteredElementCollector(doc).WhereElementIsNotElementType())
            {
                if (e.Category == null) continue;
                string field = null;
                foreach (var f in Fields)
                {
                    Parameter p = e.get_Parameter(f.Bip) ?? (f.Field == "type mark" ? doc.GetElement(e.GetTypeId())?.get_Parameter(BuiltInParameter.ALL_MODEL_TYPE_MARK) : null);
                    if (p != null && p.StorageType == StorageType.String && Hit(p.AsString(), f.Field == "comments")) { field = f.Field; break; }
                }
                if (field == null && Hit(e.Name, false)) field = "name";
                if (field == null) continue;
                matches.Add((e, field));
                if (matches.Count >= limit) break;
            }

            var touching = new JArray();
            if (Parameters.Value<bool?>("touching") != false)
            {
                double gap = 25 / 304.8;
                foreach (var m in matches.Take(5))
                {
                    BoundingBoxXYZ b = m.E.get_BoundingBox(null);
                    if (b == null || m.E is View) continue;
                    var outline = new Outline(b.Min - new XYZ(gap, gap, gap), b.Max + new XYZ(gap, gap, gap));
                    var near = new FilteredElementCollector(doc).WhereElementIsNotElementType()
                        .WherePasses(new BoundingBoxIntersectsFilter(outline))
                        .Where(x => x.Id != m.E.Id && x.Category != null && x.Category.CategoryType == CategoryType.Model)
                        .Take(50).Select(x => Describe(doc, x));
                    touching.Add(new JObject { ["of"] = m.E.UniqueId, ["elements"] = new JArray(near) });
                }
            }
            var found = new JArray(matches.Select(m => { JObject o = Describe(doc, m.E); o["matched"] = m.Field; return o; }));
            return new JObject { ["model"] = doc.Title, ["path"] = doc.PathName ?? "", ["query"] = q, ["found"] = found, ["touching"] = touching, ["truncated"] = matches.Count >= limit };
        }
    }
}
