using System;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Revit's design options for options side by side (docs/PLAN_OPTIONS.md, O3), read-only. Revit's API reads design
    /// options but can't create one or move an element into one: a person makes the option set "FMC &lt;node&gt;" with an
    /// option per variant (Manage › Design Options) and makes one active; new elements go into the active option. This
    /// lists the sets and options and which one is active, so a build lands only where it was asked to.
    /// </summary>
    public static class FmcDesignOption
    {
        /// <summary>The active option's set and name; null in the main model.</summary>
        public static (string set, string option, bool primary)? Active(Document doc)
        {
            ElementId id = DesignOption.GetActiveDesignOptionId(doc);
            if (id == null || id == ElementId.InvalidElementId) return null;
            return Describe(doc, doc.GetElement(id) as DesignOption);
        }

        public static (string set, string option, bool primary)? Describe(Document doc, DesignOption o)
        {
            if (o == null) return null;
            ElementId setId = o.get_Parameter(BuiltInParameter.OPTION_SET_ID)?.AsElementId();
            string set = setId != null && setId != ElementId.InvalidElementId ? doc.GetElement(setId)?.Name ?? "" : "";
            string name = o.get_Parameter(BuiltInParameter.OPTION_NAME)?.AsString() ?? o.Name ?? "";
            // the UI shows "(primary)" after the primary option's name; the name itself is without it
            name = name.Replace("(primary)", "").Trim();
            return (set, name, o.IsPrimary);
        }

        /// <summary>Refuses unless the active option is the one asked for (or, asked for none, the main model is active).</summary>
        public static void Check(Document doc, string wanted)
        {
            var a = Active(doc);
            if (string.IsNullOrWhiteSpace(wanted))
            {
                if (a != null) throw new InvalidOperationException($"The design option {a.Value.set} : {a.Value.option} is active: switch to the main model first, or build into this option on purpose (design_option)");
                return;
            }
            if (a == null) throw new InvalidOperationException($"The main model is active: make the option {wanted} active first (Manage › Design Options)");
            if (!string.Equals(a.Value.option, wanted.Trim(), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"The active option is {a.Value.set} : {a.Value.option}, not {wanted}: make {wanted} active first");
        }
    }

    public class FmcDesignOptionsHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return _done.WaitOne(timeoutMilliseconds); }
        public string GetName() => "Formcraft design options";

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try
            {
                Document doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No model is open");
                var options = new JArray();
                foreach (DesignOption o in new FilteredElementCollector(doc).OfClass(typeof(DesignOption)).Cast<DesignOption>())
                {
                    var d = FmcDesignOption.Describe(doc, o);
                    if (d != null) options.Add(new JObject { ["set"] = d.Value.set, ["option"] = d.Value.option, ["primary"] = d.Value.primary });
                }
                var a = FmcDesignOption.Active(doc);
                Result = new JObject
                {
                    ["options"] = options,
                    ["active"] = a == null ? (JToken)JValue.CreateNull() : new JObject { ["set"] = a.Value.set, ["option"] = a.Value.option, ["primary"] = a.Value.primary },
                };
            }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }
    }
}
