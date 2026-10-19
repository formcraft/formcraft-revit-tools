using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Newtonsoft.Json.Linq;
using Rhino;
using Rhino.DocObjects;
using Rhino.Geometry;

namespace Formcraft.Rhino
{
    /// <summary>
    /// One selection across the apps (docs/PLAN_ENGINEERING_HUB.md, X1), in the person's open drawing. Unlike the parts
    /// commands, these touch the drawing's selection and view, so they run on Rhino's window thread and give up after
    /// 30 s when Rhino is busy (a command or a dialog open). rhino_select selects objects by id, or by a user text value
    /// (fmc.id holds the Formcraft id), and zooms to them; rhino_selection reads the selection back. Neither adds, moves
    /// or deletes an object, and nothing is saved.
    /// </summary>
    public static class RhinoSelection
    {
        private static T OnUi<T>(Func<T> f)
        {
            T result = default;
            Exception error = null;
            var done = new ManualResetEventSlim(false); // not disposed: a late run after a timeout still sets it
            RhinoApp.InvokeOnUiThread(new Action(() =>
            {
                try { result = f(); } catch (Exception e) { error = e; } finally { done.Set(); }
            }));
            if (!done.Wait(30000)) throw new TimeoutException("Rhino's window is busy (a command or a dialog is open): try again when it is free");
            if (error != null) throw error;
            return result;
        }

        private static RhinoDoc Doc() => RhinoDoc.ActiveDoc ?? throw new InvalidOperationException("No drawing is open in Rhino");

        private static JObject Describe(RhinoDoc doc, RhinoObject o)
        {
            var text = new JObject();
            var strings = o.Attributes.GetUserStrings();
            foreach (string k in strings.AllKeys.Take(20)) text[k] = strings[k];
            int li = o.Attributes.LayerIndex;
            return new JObject
            {
                ["id"] = o.Id.ToString(), ["name"] = o.Attributes.Name ?? "", ["type"] = o.ObjectType.ToString(),
                ["layer"] = li >= 0 && li < doc.Layers.Count ? doc.Layers[li].FullPath : "", ["user_text"] = text,
            };
        }

        public static JObject Select(JObject p) => OnUi(() =>
        {
            RhinoDoc doc = Doc();
            var ids = (p["ids"] as JArray ?? new JArray()).Select(t => t.Value<string>()).Where(s => !string.IsNullOrEmpty(s)).ToList();
            string key = p.Value<string>("key") ?? "fmc.id";
            var values = new HashSet<string>((p["values"] as JArray ?? new JArray()).Select(t => t.Value<string>()).Where(s => !string.IsNullOrEmpty(s)), StringComparer.OrdinalIgnoreCase);
            var found = new List<RhinoObject>();
            var missing = new JArray();
            foreach (string s in ids)
            {
                RhinoObject o = Guid.TryParse(s, out Guid g) ? doc.Objects.FindId(g) : null;
                if (o != null) found.Add(o); else missing.Add(s);
            }
            if (values.Count > 0)
            {
                var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (RhinoObject o in doc.Objects.GetObjectList(ObjectType.AnyObject))
                {
                    string v = o.Attributes.GetUserString(key);
                    if (v == null || !values.Contains(v)) continue;
                    found.Add(o);
                    seen.Add(v);
                }
                foreach (string v in values.Where(v => !seen.Contains(v))) missing.Add(key + "=" + v);
            }
            found = found.GroupBy(o => o.Id).Select(x => x.First()).ToList();
            doc.Objects.UnselectAll();
            int selected = found.Count(o => o.Select(true) > 0);
            bool zoomed = false;
            if (p.Value<bool?>("zoom") != false && found.Count > 0 && doc.Views.ActiveView != null)
            {
                BoundingBox box = BoundingBox.Empty;
                foreach (RhinoObject o in found) box.Union(o.Geometry.GetBoundingBox(true));
                if (box.IsValid) { doc.Views.ActiveView.ActiveViewport.ZoomBoundingBox(box); zoomed = true; }
            }
            doc.Views.Redraw();
            return new JObject
            {
                ["document"] = doc.Name ?? "", ["selected"] = selected, ["zoomed"] = zoomed,
                ["found"] = new JArray(found.Select(o => Describe(doc, o))), ["missing"] = missing,
            };
        });

        public static JObject Selection(JObject p) => OnUi(() =>
        {
            RhinoDoc doc = Doc();
            int limit = Math.Max(1, Math.Min(p.Value<int?>("limit") ?? 500, 5000));
            var objects = doc.Objects.GetSelectedObjects(false, false).ToList();
            return new JObject { ["document"] = doc.Name ?? "", ["count"] = objects.Count, ["objects"] = new JArray(objects.Take(limit).Select(o => Describe(doc, o))) };
        });
    }
}
