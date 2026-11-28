using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Analysis;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// gbXML export for fmc_energy mode export (GAP-23). Writes ONE file, &lt;name&gt;.xml, directly in the folder that holds
    /// the open .rvt (Document.PathName's directory). Refuses an unsaved, cloud or Revit Server model, a name that leaves
    /// that folder, the model's own path, and any file that already exists. Never saves, syncs or relinquishes.
    /// The export is tried with no transaction first. Only if Revit refuses it outside a transaction is it run again inside
    /// a TransactionGroup (creating the energy analytical model first when there is none) and the group is rolled back.
    /// The server (server/src/fmc/energyexport.ts) plans the same name and checks the same rules before this runs.
    /// </summary>
    public class FmcEnergyExportHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft energy gbXML export";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_energy_export needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    string file = PlanFile(doc, Parameters);
                    string folder = Path.GetDirectoryName(file);
                    var before = new HashSet<string>(Directory.GetFiles(folder), StringComparer.OrdinalIgnoreCase);
                    bool modifiedBefore = doc.IsModified;
                    string name = Path.GetFileNameWithoutExtension(file);
                    string used = "none";
                    bool created = false;
                    bool ok;
                    try
                    {
                        ok = doc.Export(folder, name, Options(Parameters));
                    }
                    catch (Exception first) when (NeedsTransaction(first) && !File.Exists(file))
                    {
                        used = "group_rolled_back";
                        ok = ExportInRolledBackGroup(doc, folder, name, Parameters, out created);
                    }
                    if (!ok || !File.Exists(file))
                        throw new InvalidOperationException("[FMC-ENERGY-EXPORT] Revit did not write " + file + ".");
                    var added = new JArray();
                    foreach (string f in Directory.GetFiles(folder))
                        if (!before.Contains(f)) added.Add(f);
                    Result = new JObject
                    {
                        ["read_only"] = false,
                        ["applied"] = true,
                        ["saved"] = false,
                        ["synced"] = false,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                        ["file"] = file,
                        ["folder"] = folder,
                        ["bytes"] = new FileInfo(file).Length,
                        ["transaction_used"] = used,
                        ["energy_model_created"] = created,
                        ["energy_model_kept"] = false,
                        ["is_modified_before"] = modifiedBefore,
                        ["is_modified_after"] = doc.IsModified,
                        ["new_files"] = added,
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        /// <summary>The same rules as planGbxmlExport on the server, checked again against Revit's own PathName.</summary>
        internal static string PlanFile(Document doc, JObject parameters)
        {
            string rvt = doc.PathName ?? "";
            if (rvt.Length == 0)
                throw new InvalidOperationException("[FMC-ENERGY-UNSAVED] " + doc.Title + " has never been saved: there is no project folder to export into.");
            if (FmcEnergyHandler.InCloud(doc) || FmcTarget.IsCloud(rvt))
                throw new InvalidOperationException("[FMC-ENERGY-CLOUD] " + doc.Title + " is a cloud or Revit Server model. gbXML export goes only beside a local .rvt.");
            if (doc.IsFamilyDocument || !string.Equals(Path.GetExtension(rvt), ".rvt", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("[FMC-ENERGY-NOT-PROJECT] " + doc.Title + " is not a project (.rvt).");
            if (doc.IsModifiable)
                throw new InvalidOperationException("[FMC-DOC-BUSY] " + doc.Title + " has an open transaction. Export waits until it closes.");
            string folder = Path.GetDirectoryName(Path.GetFullPath(rvt)).TrimEnd('\\', '/');
            string expected = (parameters?.Value<string>("expected_folder") ?? "").Trim().TrimEnd('\\', '/');
            if (expected.Length > 0 && !string.Equals(Path.GetFullPath(expected).TrimEnd('\\', '/'), folder, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("[FMC-ENERGY-OUTSIDE] The server planned " + expected + " but the model is in " + folder + ".");
            string asked = (parameters?.Value<string>("file_name") ?? "").Trim();
            string name = Sanitize(asked.Length > 0 ? asked : Sanitize(Path.GetFileNameWithoutExtension(rvt)) + "_gbXML_" + DateTime.Now.ToString("yyyyMMdd-HHmm"));
            if (name.Length == 0) throw new InvalidOperationException("[FMC-ENERGY-NAME] The file name has no usable characters.");
            string file = Path.GetFullPath(Path.Combine(folder, name + ".xml"));
            if (!string.Equals(Path.GetDirectoryName(file).TrimEnd('\\', '/'), folder, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("[FMC-ENERGY-OUTSIDE] " + file + " is not directly in " + folder + ".");
            if (string.Equals(file, Path.GetFullPath(rvt), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("[FMC-ENERGY-NAME] The export would replace the model.");
            if (File.Exists(file))
                throw new InvalidOperationException("[FMC-ENERGY-EXISTS] " + file + " already exists. Nothing is overwritten.");
            return file;
        }

        internal static string Sanitize(string raw)
        {
            string s = Regex.Replace((raw ?? "").Trim(), @"\.xml$", "", RegexOptions.IgnoreCase);
            s = Regex.Replace(s, @"[^A-Za-z0-9._-]+", "_");
            s = Regex.Replace(s, @"\.{2,}", ".");
            s = Regex.Replace(s, @"_+", "_");
            s = Regex.Replace(s, @"^[._-]+|[._-]+$", "");
            if (s.Length > 120) s = Regex.Replace(s.Substring(0, 120), @"[._-]+$", "");
            return s;
        }

        private static GBXMLExportOptions Options(JObject parameters)
        {
            var options = new GBXMLExportOptions();
            string type = (parameters?.Value<string>("model_type") ?? "default").Trim().ToLowerInvariant();
            try
            {
                if (type == "spaces") options.ExportEnergyModelType = ExportEnergyModelType.SpatialElement;
                else if (type == "building_elements") options.ExportEnergyModelType = ExportEnergyModelType.BuildingElement;
            }
            catch (Exception) { /* left at Revit's export setting */ }
            return options;
        }

        private static bool NeedsTransaction(Exception ex)
        {
            if (ex is Autodesk.Revit.Exceptions.ModificationOutsideTransactionException) return true;
            string m = ex.Message ?? "";
            return m.IndexOf("transaction", StringComparison.OrdinalIgnoreCase) >= 0 || m.IndexOf("modifiable", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        /// <summary>Everything Revit needs for the export is undone: the group is always rolled back, never assimilated.</summary>
        private static bool ExportInRolledBackGroup(Document doc, string folder, string name, JObject parameters, out bool created)
        {
            created = false;
            using (var group = new TransactionGroup(doc, "FMC gbXML export (rolled back)"))
            {
                group.Start();
                try
                {
                    using (var t = new Transaction(doc, "FMC energy model for gbXML (rolled back)"))
                    {
                        t.Start();
                        if (EnergyAnalysisDetailModel.GetMainEnergyAnalysisDetailModel(doc) == null)
                        {
                            EnergyAnalysisDetailModel.Create(doc, new EnergyAnalysisDetailModelOptions { Tier = EnergyAnalysisDetailModelTier.Final, EnergyModelType = EnergyModelType.SpatialElement });
                            created = true;
                        }
                        t.Commit();
                    }
                    return doc.Export(folder, name, Options(parameters));
                }
                finally
                {
                    group.RollBack();
                }
            }
        }
    }
}
