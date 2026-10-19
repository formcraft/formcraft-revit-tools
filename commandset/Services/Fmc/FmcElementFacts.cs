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
    /// fmc_element_facts (docs/PLAN_MARK_REVIEW.md, R3/R6): what a ticket's fix plan needs to know about marked elements,
    /// read-only. For each UniqueId: category, family, type, the instance's and its type's parameters (lengths in mm,
    /// others as numbers or text), which of them are read-only or belong to the type, the types it can change to, where
    /// it sits (mm) and the active view. Nothing in the model changes.
    /// </summary>
    public class FmcElementFactsHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return _done.WaitOne(timeoutMilliseconds); }
        public string GetName() => "Formcraft element facts";

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try
            {
                Document doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No model is open");
                var elements = new JArray();
                var missing = new JArray();
                foreach (string uid in (Parameters["unique_ids"] as JArray ?? new JArray()).Select(x => x.Value<string>()))
                {
                    Element e = string.IsNullOrEmpty(uid) ? null : doc.GetElement(uid);
                    if (e == null) { missing.Add(uid); continue; }
                    elements.Add(Facts(doc, e, app.ActiveUIDocument.ActiveView));
                }
                Result = new JObject { ["model"] = doc.Title, ["elements"] = elements, ["missing"] = missing };
            }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        public static JObject Facts(Document doc, Element e, View view)
        {
            ElementType type = doc.GetElement(e.GetTypeId()) as ElementType;
            var parms = new JObject();
            var readOnly = new JArray();
            var ofType = new JArray();
            foreach (Parameter p in e.Parameters.Cast<Parameter>().OrderBy(p => p.Definition?.Name))
                Add(p, parms, readOnly, null);
            if (type != null)
                foreach (Parameter p in type.Parameters.Cast<Parameter>().OrderBy(p => p.Definition?.Name))
                    Add(p, parms, readOnly, ofType);
            var types = new JArray();
            try
            {
                foreach (ElementId id in e.GetValidTypes())
                    if (doc.GetElement(id) is ElementType t) types.Add(t.Name);
            }
            catch (Exception) { /* some elements have no other types */ }
            var o = new JObject
            {
                ["unique_id"] = e.UniqueId,
                ["id"] = e.Id.Value,
                ["category"] = e.Category?.Name ?? "",
                ["family"] = (type as FamilySymbol)?.FamilyName ?? type?.FamilyName ?? "",
                ["type_name"] = type?.Name ?? "",
                ["params"] = parms,
                ["read_only"] = readOnly,
                ["type_params"] = ofType,
                ["types"] = new JArray(types.Select(t => t.Value<string>()).Distinct().OrderBy(t => t)),
                ["view"] = view?.Name ?? "",
            };
            if (e.Location is LocationPoint lp) o["point_mm"] = Mm(lp.Point);
            else if (e.Location is LocationCurve lc) { o["start_mm"] = Mm(lc.Curve.GetEndPoint(0)); o["end_mm"] = Mm(lc.Curve.GetEndPoint(1)); }
            if (e is FamilyInstance fi && fi.Host != null) o["host"] = fi.Host.Category?.Name ?? fi.Host.Name;
            return o;
        }

        /// <summary>A parameter's value as the plan reads it: lengths in mm, yes/no and integers as numbers, else text. The instance wins a name clash.</summary>
        private static void Add(Parameter p, JObject parms, JArray readOnly, JArray ofType)
        {
            string name = p.Definition?.Name;
            if (string.IsNullOrEmpty(name) || parms[name] != null) return;
            JToken v = Value(p);
            if (v == null) return;
            parms[name] = v;
            if (p.IsReadOnly) readOnly.Add(name);
            ofType?.Add(name);
        }

        public static JToken Value(Parameter p)
        {
            if (!p.HasValue) return JValue.CreateNull();
            switch (p.StorageType)
            {
                case StorageType.Double:
                    if (IsLength(p)) return Math.Round(UnitUtils.ConvertFromInternalUnits(p.AsDouble(), UnitTypeId.Millimeters), 1);
                    return p.AsValueString() ?? Math.Round(p.AsDouble(), 4).ToString(System.Globalization.CultureInfo.InvariantCulture);
                case StorageType.Integer: return p.AsInteger();
                case StorageType.String: return p.AsString() ?? "";
                case StorageType.ElementId:
                    ElementId id = p.AsElementId();
                    if (id == null || id == ElementId.InvalidElementId) return JValue.CreateNull();
                    return p.Element?.Document?.GetElement(id)?.Name ?? p.AsValueString() ?? "";
                default: return null;
            }
        }

        public static bool IsLength(Parameter p)
        {
            try { return p.Definition.GetDataType() == SpecTypeId.Length; } catch (Exception) { return false; }
        }

        private static JArray Mm(XYZ p) => new JArray(Math.Round(p.X * 304.8, 1), Math.Round(p.Y * 304.8, 1), Math.Round(p.Z * 304.8, 1));
    }
}
