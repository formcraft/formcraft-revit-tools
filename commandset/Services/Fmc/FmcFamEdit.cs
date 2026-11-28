using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Bridge;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Family editor tools (server/src/tools/fmc_fam_*.ts checks every change first). Works on the call's document, which
    /// must be a family document: a project is refused. <b>read</b> has no transaction. <b>apply</b> runs the tool's change
    /// in one transaction: the dry run (and any failed step) rolls it back, so the dry run is the real change undone.
    /// </summary>
    public class FmcFamEditHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public string Tool { get; set; } = "";
        public string Action { get; set; } = "";
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft family editor";

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try
            {
                using var target = FmcTarget.Resolve(app, Parameters, mayOpen: false);
                Document doc = target.Doc;
                if (!doc.IsFamilyDocument)
                    throw new InvalidOperationException($"{doc.Title} is a project; the family editor tools work on family documents only (open the family, or an fmc_doc session)");
                if (doc.IsReadOnly) throw new InvalidOperationException($"{doc.Title} is read-only");
                JObject body = Action == "read" ? Read(doc) : Apply(doc);
                body["resolved_document"] = FmcTarget.Resolved(doc);
                Result = body;
            }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        private JObject Read(Document doc) => Tool switch
        {
            "nested" => FmcFamNested.Read(doc),
            "hosting" => FmcFamHosting.Read(doc),
            "connector" => FmcFamConnector.Read(doc),
            _ => throw new InvalidOperationException($"Unknown family editor tool '{Tool}'"),
        };

        private JObject Change(Document doc) => Tool switch
        {
            "nested" => FmcFamNested.Apply(doc, Parameters),
            "hosting" => FmcFamHosting.Apply(doc, Parameters),
            "connector" => FmcFamConnector.Apply(doc, Parameters),
            _ => throw new InvalidOperationException($"Unknown family editor tool '{Tool}'"),
        };

        private JObject Apply(Document doc)
        {
            bool dry = Parameters.Value<bool?>("dry_run") ?? true;
            string runId = Parameters.Value<string>("run_id") ?? "";
            var failures = new FmcFailures();
            JObject step;
            bool failed;
            using (var t = new Transaction(doc, $"Formcraft: family {Tool} ({Parameters.Value<string>("action")})"))
            {
                failures.Attach(t);
                t.Start();
                try { step = Change(doc); failed = step["error"] != null; }
                catch (Exception e) { step = new JObject { ["action"] = Parameters.Value<string>("action"), ["error"] = e.Message }; failed = true; }
                // one Undo, all or nothing: the dry run, and a step that failed, roll back
                if (dry || failed) t.RollBack();
                else if (t.Commit() != TransactionStatus.Committed) { failed = true; step["error"] ??= "Revit didn't commit the change"; }
            }
            return new JObject
            {
                ["run_id"] = runId, ["dry_run"] = dry, ["results"] = new JArray(step), ["failed"] = failed,
                ["rolled_back"] = dry || failed || failures.RolledBack,
                ["warnings"] = new JArray(failures.Warnings), ["errors"] = new JArray(failures.Errors),
            };
        }

        // ---------------------------------------------------------------------------------------------------------
        // shared helpers

        public static double Mm(double ft) => Math.Round(ft * 304.8, 3);
        public static double Ft(double mm) => mm / 304.8;
        public static ElementId Id(long id) => new ElementId(id);
        public static long IdOf(ElementId id) => id?.Value ?? -1;

        /// <summary>Revit's spec type id for a parameter definition (e.g. autodesk.spec.aec:length-2.0.0).</summary>
        public static string Spec(Definition d)
        {
            try { return d?.GetDataType()?.TypeId ?? ""; } catch (Exception) { return ""; }
        }

        /// <summary>The category a &lt;Family Type&gt; parameter takes, or null for any other parameter.</summary>
        public static string FamilyTypeCategory(Document doc, Definition d)
        {
            try
            {
                ForgeTypeId t = d?.GetDataType();
                if (t == null || !Category.IsBuiltInCategory(t)) return null;
                return Category.GetCategory(doc, Category.GetBuiltInCategory(t))?.Name;
            }
            catch (Exception) { return null; }
        }

        public static JArray HostParameters(Document doc)
        {
            var list = new JArray();
            foreach (FamilyParameter p in doc.FamilyManager.Parameters)
                list.Add(new JObject
                {
                    ["name"] = p.Definition.Name, ["spec"] = Spec(p.Definition), ["is_instance"] = p.IsInstance,
                    ["formula"] = string.IsNullOrEmpty(p.Formula) ? null : p.Formula, ["family_type_category"] = FamilyTypeCategory(doc, p.Definition),
                });
            return list;
        }

        public static string Joined(IEnumerable<string> parts) => string.Join("; ", parts.Where(s => !string.IsNullOrEmpty(s)));
    }
}
