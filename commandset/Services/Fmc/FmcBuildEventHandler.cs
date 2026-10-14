using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Build (U26) on the Revit main thread, read-only: every element in the kit's categories, summed by its type's code
    /// (the kit's FMC_Keynote_Code) as count, area, volume and length; counted by status (FMC_Construction_Status) and by
    /// package (FMC_Trade_Package); elements with no code listed by category so nothing is dropped silently. The
    /// parameter names and categories come from the server, which reads them from the kit.
    /// </summary>
    public class FmcBuildEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double FtToM = 0.3048;
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public string GetName() => "FMC build";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using var target = FmcTarget.Resolve(app, Parameters, mayOpen: true);
                Document doc = target.Doc;
                if (doc.IsFamilyDocument) throw new InvalidOperationException("Build reads a project model.");
                Result = Facts(doc, Parameters);
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

        private static string Value(Element e, string name)
        {
            Parameter p = e.LookupParameter(name);
            if (p == null || !p.HasValue) return "";
            return (p.StorageType == StorageType.String ? p.AsString() : p.AsValueString())?.Trim() ?? "";
        }

        private static double Double(Element e, BuiltInParameter bip) =>
            e.get_Parameter(bip) is Parameter p && p.StorageType == StorageType.Double && p.HasValue ? p.AsDouble() : 0;

        private sealed class Sum { public int Count; public double Area, Volume, Length; public string Category = ""; }

        private static JObject Facts(Document doc, JObject p)
        {
            string codeParam = p.Value<string>("code_param") ?? "FMC_Keynote_Code";
            string statusParam = p.Value<string>("status_param") ?? "FMC_Construction_Status";
            string packageParam = p.Value<string>("package_param") ?? "FMC_Trade_Package";
            var cats = new List<BuiltInCategory>();
            foreach (string c in (p["categories"] as JArray ?? new JArray()).Select(x => x.ToString()))
                if (Enum.TryParse(c, out BuiltInCategory bic)) cats.Add(bic);
            if (cats.Count == 0) throw new InvalidOperationException("No categories to measure.");

            var byCode = new Dictionary<string, Sum>();
            var status = new Dictionary<string, int>();
            var package = new Dictionary<string, int>();
            var unmapped = new Dictionary<string, int>();
            int total = 0;
            bool hasCode = false, hasStatus = false, hasPackage = false;
            var typeCache = new Dictionary<long, (string Code, string Package)>();
            foreach (Element e in new FilteredElementCollector(doc).WherePasses(new ElementMulticategoryFilter(cats)).WhereElementIsNotElementType())
            {
                if (e.Category == null || e is ElementType) continue;
                total++;
                ElementId tid = e.GetTypeId();
                if (!typeCache.TryGetValue(tid.Value, out var t))
                {
                    Element type = doc.GetElement(tid);
                    t = (type == null ? "" : Value(type, codeParam), type == null ? "" : Value(type, packageParam));
                    if (type?.LookupParameter(codeParam) != null) hasCode = true;
                    if (type?.LookupParameter(packageParam) != null) hasPackage = true;
                    typeCache[tid.Value] = t;
                }
                string code = t.Code.Length > 0 ? t.Code : Value(e, codeParam);
                string st = Value(e, statusParam);
                if (e.LookupParameter(statusParam) != null) hasStatus = true;
                status[st.Length > 0 ? st : "(none)"] = (status.TryGetValue(st.Length > 0 ? st : "(none)", out int sc) ? sc : 0) + 1;
                string pk = t.Package.Length > 0 ? t.Package : Value(e, packageParam);
                package[pk.Length > 0 ? pk : "(none)"] = (package.TryGetValue(pk.Length > 0 ? pk : "(none)", out int pc) ? pc : 0) + 1;
                if (code.Length == 0)
                {
                    unmapped[e.Category.Name] = (unmapped.TryGetValue(e.Category.Name, out int u) ? u : 0) + 1;
                    continue;
                }
                if (!byCode.TryGetValue(code, out Sum s)) byCode[code] = s = new Sum { Category = e.Category.Name };
                s.Count++;
                s.Area += Double(e, BuiltInParameter.HOST_AREA_COMPUTED) * FtToM * FtToM;
                s.Volume += Double(e, BuiltInParameter.HOST_VOLUME_COMPUTED) * FtToM * FtToM * FtToM;
                double len = Double(e, BuiltInParameter.CURVE_ELEM_LENGTH);
                if (len == 0 && e.Location is LocationCurve lc && lc.Curve != null) len = lc.Curve.Length;
                s.Length += len * FtToM;
            }

            return new JObject
            {
                ["model"] = doc.Title,
                ["elements"] = total,
                ["params_in_model"] = new JObject { [codeParam] = hasCode, [statusParam] = hasStatus, [packageParam] = hasPackage },
                ["codes"] = new JObject(byCode.OrderBy(k => k.Key).Select(k => new JProperty(k.Key, new JObject
                {
                    ["count"] = k.Value.Count, ["area_m2"] = Math.Round(k.Value.Area, 2), ["volume_m3"] = Math.Round(k.Value.Volume, 3),
                    ["length_m"] = Math.Round(k.Value.Length, 2), ["category"] = k.Value.Category,
                }))),
                ["status"] = JObject.FromObject(status),
                ["package"] = JObject.FromObject(package),
                ["unmapped"] = JObject.FromObject(unmapped),
            };
        }
    }
}
