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
    /// fmc_element_apply (docs/PLAN_MARK_REVIEW.md, R6): a ticket's planned fix applied to the marked elements, after a
    /// person said yes (the server checks that and sends it through the live-model lock). Steps are fmc_review plan_fix's:
    /// set_param, set_height, move, change_type, set_material, delete, add_clearance. All of them go in one transaction:
    /// if one step can't be done, nothing is changed and the answer says which step and why. A type parameter is never
    /// changed (it would change every element of that type): change the type instead. Lengths arrive in mm.
    /// </summary>
    public class FmcElementApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return _done.WaitOne(timeoutMilliseconds); }
        public string GetName() => "Formcraft apply a fix";

        private static readonly string[] HeightParams = { "Sill Height", "Elevation from Level", "Offset from Host", "Offset", "Base Offset", "Height Offset From Level" };
        private static double Ft(double mm) => mm / 304.8;

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try { Result = Apply(app.ActiveUIDocument ?? throw new InvalidOperationException("No model is open")); }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        private JObject Apply(UIDocument uidoc)
        {
            Document doc = uidoc.Document;
            if (doc.IsFamilyDocument) throw new InvalidOperationException("A ticket's fix is applied in a project model");
            var steps = (Parameters["steps"] as JArray ?? new JArray()).OfType<JObject>().ToList();
            if (steps.Count == 0) throw new InvalidOperationException("No steps to apply");
            string fallbackUid = Parameters.Value<string>("unique_id") ?? "";
            View view = FindView(doc, Parameters.Value<string>("view")) ?? uidoc.ActiveView;
            string ticket = Parameters.Value<string>("ticket") ?? "";
            var done = new JArray();
            using (var t = new Transaction(doc, "FMC fix " + ticket))
            {
                t.Start();
                for (int i = 0; i < steps.Count; i++)
                {
                    JObject s = steps[i];
                    string uid = s.Value<string>("unique_id") ?? fallbackUid;
                    Element e = string.IsNullOrEmpty(uid) ? null : doc.GetElement(uid);
                    try
                    {
                        if (e == null) throw new InvalidOperationException($"the element {uid} isn't in this model");
                        JObject r = Step(doc, e, s, view);
                        r["step"] = i + 1; r["op"] = s.Value<string>("op"); r["unique_id"] = uid;
                        done.Add(r);
                    }
                    catch (Exception ex)
                    {
                        t.RollBack();
                        return new JObject
                        {
                            ["applied"] = false,
                            ["failed_step"] = i + 1,
                            ["op"] = s.Value<string>("op"),
                            ["reason"] = ex.Message,
                            ["sentence"] = s.Value<string>("sentence") ?? "",
                            ["note"] = "Nothing was changed: the whole fix is one step in Undo, or none",
                        };
                    }
                }
                t.Commit();
            }
            return new JObject { ["applied"] = true, ["steps"] = done, ["undo"] = "One Undo in Revit takes the whole fix back: FMC fix " + ticket };
        }

        private static JObject Step(Document doc, Element e, JObject s, View view)
        {
            string op = s.Value<string>("op");
            switch (op)
            {
                case "set_param":
                {
                    Parameter p = Writable(e, s.Value<string>("param"));
                    JToken before = FmcElementFactsHandler.Value(p);
                    if (s["value_text"] != null && s["value_mm"] == null && s["by_mm"] == null) SetText(p, s.Value<string>("value_text"));
                    else
                    {
                        if (!FmcElementFactsHandler.IsLength(p)) throw new InvalidOperationException($"{p.Definition.Name} isn't a length: a value in mm doesn't fit it");
                        double mm = s["value_mm"] != null ? s.Value<double>("value_mm")
                            : UnitUtils.ConvertFromInternalUnits(p.AsDouble(), UnitTypeId.Millimeters) + s.Value<double>("by_mm");
                        if (!p.Set(Ft(mm))) throw new InvalidOperationException($"Revit refused {mm} mm for {p.Definition.Name}");
                    }
                    return Changed(p, before);
                }
                case "set_height":
                {
                    Parameter p = HeightParams.Select(n => e.LookupParameter(n)).FirstOrDefault(x => x != null && !x.IsReadOnly && x.StorageType == StorageType.Double)
                        ?? throw new InvalidOperationException("the element has no height or offset it can change (" + string.Join(", ", HeightParams) + ")");
                    JToken before = FmcElementFactsHandler.Value(p);
                    if (!p.Set(Ft(s.Value<double>("value_mm")))) throw new InvalidOperationException($"Revit refused the height for {p.Definition.Name}");
                    return Changed(p, before);
                }
                case "move":
                {
                    var v = s["vector_mm"] as JArray ?? throw new InvalidOperationException("a move needs vector_mm");
                    double x = v[0].Value<double>(), y = v[1].Value<double>(), z = v[2].Value<double>();
                    XYZ by = s.Value<string>("frame") == "view"
                        // the view's frame: x to the right of the screen, y up the screen, z towards the viewer
                        ? (view.RightDirection * Ft(x) + view.UpDirection * Ft(y) + view.ViewDirection * Ft(z))
                        : new XYZ(Ft(x), Ft(y), Ft(z));
                    if (e.Pinned) throw new InvalidOperationException("the element is pinned: a person unpins it first");
                    ElementTransformUtils.MoveElement(doc, e.Id, by);
                    return new JObject { ["moved_mm"] = new JArray(Math.Round(by.X * 304.8, 1), Math.Round(by.Y * 304.8, 1), Math.Round(by.Z * 304.8, 1)) };
                }
                case "change_type":
                {
                    string name = s.Value<string>("type_name");
                    string was = doc.GetElement(e.GetTypeId())?.Name ?? "";
                    ElementId id = e.GetValidTypes().FirstOrDefault(x => string.Equals(doc.GetElement(x)?.Name, name, StringComparison.OrdinalIgnoreCase))
                        ?? throw new InvalidOperationException($"{name} isn't a type this element can change to (load it first)");
                    e.ChangeTypeId(id);
                    return new JObject { ["was"] = was, ["now"] = doc.GetElement(id).Name };
                }
                case "set_material":
                {
                    string name = s.Value<string>("material");
                    Material m = new FilteredElementCollector(doc).OfClass(typeof(Material)).Cast<Material>()
                        .FirstOrDefault(x => string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase))
                        ?? throw new InvalidOperationException($"the material {name} isn't in this model (load it from the kit)");
                    Parameter p = e.Parameters.Cast<Parameter>().FirstOrDefault(x => !x.IsReadOnly && x.StorageType == StorageType.ElementId && IsMaterial(x))
                        ?? throw new InvalidOperationException("the element has no material parameter of its own (its type's material changes every element of the type: change the type instead)");
                    JToken before = FmcElementFactsHandler.Value(p);
                    p.Set(m.Id);
                    return Changed(p, before);
                }
                case "delete":
                {
                    if (e.Pinned) throw new InvalidOperationException("the element is pinned: a person unpins it first");
                    string what = $"{e.Category?.Name} {doc.GetElement(e.GetTypeId())?.Name}".Trim();
                    doc.Delete(e.Id);
                    return new JObject { ["deleted"] = what };
                }
                case "add_clearance":
                {
                    // the kit's families carry Show Clearance and a clearance depth; nothing else is drawn
                    Parameter show = e.LookupParameter("Show Clearance") ?? throw new InvalidOperationException("the family has no Show Clearance (a kit family shows its clearance zone)");
                    if (show.IsReadOnly) throw new InvalidOperationException("Show Clearance is the type's here: change the type");
                    show.Set(1);
                    var r = new JObject { ["show_clearance"] = true };
                    Parameter depth = new[] { "Clearance", "Clearance Depth", "Clearance Front" }.Select(n => e.LookupParameter(n))
                        .FirstOrDefault(x => x != null && !x.IsReadOnly && FmcElementFactsHandler.IsLength(x));
                    if (depth != null && s["value_mm"] != null) { depth.Set(Ft(s.Value<double>("value_mm"))); r["clearance_mm"] = s.Value<double>("value_mm"); r["param"] = depth.Definition.Name; }
                    else if (s["value_mm"] != null) r["note"] = "the family shows its own clearance size; it has no clearance length to set";
                    return r;
                }
                default: throw new InvalidOperationException($"{op} isn't a step this command applies");
            }
        }

        /// <summary>The instance's own parameter by name, writable; a type parameter is refused (it changes every element of the type).</summary>
        private static Parameter Writable(Element e, string name)
        {
            if (string.IsNullOrEmpty(name)) throw new InvalidOperationException("the step names no parameter");
            Parameter p = e.LookupParameter(name);
            if (p == null)
            {
                Element type = e.Document.GetElement(e.GetTypeId());
                if (type?.LookupParameter(name) != null) throw new InvalidOperationException($"{name} belongs to the type {type.Name}: changing it changes every one of them. Change the type, or a person edits the type");
                throw new InvalidOperationException($"the element has no parameter {name}");
            }
            if (p.IsReadOnly) throw new InvalidOperationException($"{name} is read-only (Revit works it out)");
            return p;
        }

        private static void SetText(Parameter p, string text)
        {
            bool ok;
            switch (p.StorageType)
            {
                case StorageType.String: ok = p.Set(text ?? ""); break;
                case StorageType.Integer:
                    string t = (text ?? "").Trim().ToLowerInvariant();
                    int n = t == "yes" || t == "on" || t == "true" ? 1 : t == "no" || t == "off" || t == "false" ? 0 : int.Parse(t);
                    ok = p.Set(n); break;
                default: ok = p.SetValueString(text ?? ""); break;
            }
            if (!ok) throw new InvalidOperationException($"Revit refused \"{text}\" for {p.Definition.Name}");
        }

        private static bool IsMaterial(Parameter p)
        {
            try { return p.Definition.GetDataType() == SpecTypeId.Reference.Material; } catch (Exception) { return false; }
        }

        private static JObject Changed(Parameter p, JToken before) =>
            new JObject { ["param"] = p.Definition.Name, ["was"] = before, ["now"] = FmcElementFactsHandler.Value(p) };

        private static View FindView(Document doc, string name) =>
            string.IsNullOrEmpty(name) ? null : new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>()
                .FirstOrDefault(v => !v.IsTemplate && string.Equals(v.Name, name, StringComparison.OrdinalIgnoreCase));
    }
}
