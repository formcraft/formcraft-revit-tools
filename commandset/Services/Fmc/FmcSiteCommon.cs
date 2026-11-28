using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Shared handler body for the site and analysis tools (fmc_sun, fmc_avf, fmc_survey): one Revit call, the document
    /// named in the parameters (never the active document), and the write refusals every apply checks again in the add-in.
    /// </summary>
    public abstract class FmcSiteHandlerBase : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; protected set; } = new JObject();
        public string Error { get; private set; } = "";
        protected abstract string Tool { get; }
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft " + Tool;

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] " + Tool + " needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    Result = Run(app, doc) ?? new JObject();
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        protected abstract JObject Run(UIApplication app, Document doc);

        /// <summary>HEBERT HOSTELS, a central model and a protected path are never written.</summary>
        protected void Refuse(Document doc)
        {
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (Regex.IsMatch(blob, "hebert hostels", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("HEBERT HOSTELS is not written by " + Tool + ".");
            if (FmcPhaseIds.IsCentral(doc)) throw new InvalidOperationException("A central model is not written by " + Tool + ".");
            if (FmcTarget.IsProtected(doc.PathName ?? "", FmcTarget.Roots(Parameters)))
                throw new InvalidOperationException("The document is under a protected path.");
        }

        protected static JObject DocFacts(Document doc)
        {
            return new JObject
            {
                ["read_only"] = true,
                ["title"] = doc.Title ?? "",
                ["path"] = doc.PathName ?? "",
                ["is_central"] = FmcPhaseIds.IsCentral(doc),
            };
        }

        protected static double Mm(double feet) => Math.Round(feet * 304.8, 3);
        protected static double Ft(double mm) => mm / 304.8;
        protected static double Deg(double rad) => rad * 180.0 / Math.PI;

        /// <summary>A view by element id or by name (case-insensitive).</summary>
        protected static T FindView<T>(Document doc, string key) where T : View
        {
            key = (key ?? "").Trim();
            if (key.Length == 0) return null;
            if (long.TryParse(key, out long id) && doc.GetElement(new ElementId(id)) is T byId) return byId;
            return new FilteredElementCollector(doc).OfClass(typeof(T)).Cast<T>()
                .FirstOrDefault(v => string.Equals(v.Name, key, StringComparison.OrdinalIgnoreCase));
        }

        protected static bool SetYesNo(Element e, BuiltInParameter bip, bool on)
        {
            try
            {
                Parameter p = e.get_Parameter(bip);
                if (p == null || p.IsReadOnly || p.StorageType != StorageType.Integer) return false;
                return p.Set(on ? 1 : 0);
            }
            catch (Exception) { return false; }
        }
    }
}
