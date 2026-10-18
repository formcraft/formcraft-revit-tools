using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Bridge;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// F-063 (QG4): many recipes in one Revit job. The server has checked every recipe and resolved its materials and family
    /// paths; for each item this starts a family from its template, applies the ops with the engine's own runner
    /// (FmcDocOps.Apply, one transaction group), flexes every type (and the size parameters it is given), moves an older
    /// staged file and its records to &lt;Role&gt;\_Archive (nothing is deleted), saves the new one to staging with its recipe
    /// beside it, and closes it. One JSON line per family goes to the results file, with local time and offset. A cancel
    /// (fmc_job cancel) or the time budget stops it between families; what was built stays built.
    /// </summary>
    public class FmcRecipeBatchEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public string GetName() => "FMC recipe batch";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                FmcAiJob.Enter(app, FmcAiJob.JobOf(Parameters));
                Result = Run(app, Parameters);
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _resetEvent.Set(); }
        }

        private static JObject Run(UIApplication app, JObject p)
        {
            // a pack is far bigger than one request: the server writes the checked items to a manifest and sends its path
            string itemsFile = p.Value<string>("items_file") ?? "";
            JArray source = itemsFile.Length > 0
                ? (File.Exists(itemsFile) ? (JObject.Parse(File.ReadAllText(itemsFile))["items"] as JArray) : throw new FileNotFoundException("No batch manifest at " + itemsFile))
                : p["items"] as JArray;
            var items = (source ?? new JArray()).OfType<JObject>().ToList();
            string spFile = p.Value<string>("shared_parameter_file") ?? "";
            string resultsFile = p.Value<string>("results_file") ?? throw new ArgumentException("results_file is needed");
            double budget = p.Value<double?>("max_seconds") ?? 0;
            int backups = Math.Max(1, p.Value<int?>("max_backups") ?? 3);
            Directory.CreateDirectory(Path.GetDirectoryName(resultsFile));

            var clock = Stopwatch.StartNew();
            int ok = 0, failed = 0;
            string stopped = "";
            foreach (JObject item in items)
            {
                try { FmcAiJob.ThrowIfCancelled(); }
                catch (OperationCanceledException) { stopped = "cancelled"; break; }
                if (budget > 0 && clock.Elapsed.TotalSeconds > budget) { stopped = "time budget"; break; }

                JObject line = BuildOne(app, item, spFile, backups);
                if (line.Value<bool>("ok")) ok++; else failed++;
                Append(resultsFile, line);
            }
            return new JObject
            {
                ["items"] = items.Count, ["built"] = ok, ["failed"] = failed, ["not_reached"] = items.Count - ok - failed,
                ["stopped"] = stopped, ["seconds"] = Math.Round(clock.Elapsed.TotalSeconds, 1), ["results_file"] = resultsFile,
            };
        }

        private static JObject BuildOne(UIApplication app, JObject item, string spFile, int backups)
        {
            string family = item.Value<string>("family") ?? "";
            var line = new JObject { ["family"] = family, ["at"] = DateTimeOffset.Now.ToString("o"), ["revision"] = item["revision"] };
            var clock = Stopwatch.StartNew();
            Document doc = null;
            try
            {
                string template = item.Value<string>("template") ?? "";
                string target = item.Value<string>("target") ?? throw new ArgumentException("target is needed");
                if (!File.Exists(template)) throw new FileNotFoundException("Template not found: " + template);
                doc = app.Application.NewFamilyDocument(template) ?? throw new InvalidOperationException("Revit could not start a family from " + template);

                var ops = item["ops"] as JArray ?? new JArray();
                JObject applied = FmcDocOps.Apply(doc, ops, false, spFile, "");
                line["ops"] = ops.Count;
                line["created"] = applied["created"]; line["updated"] = applied["updated"]; line["skipped"] = applied["skipped"];
                var warnings = applied["warnings"] as JArray ?? new JArray();
                line["warnings"] = warnings.Count;
                if (warnings.Count > 0) line["first_warnings"] = new JArray(warnings.Take(5));
                line["skipped_ops"] = new JArray((applied["ops"] as JArray ?? new JArray()).OfType<JObject>().Select((o, i) => (o, i))
                    .Where(x => x.o.Value<string>("result") == "skip")
                    .Take(50)
                    .Select(x => new JObject { ["op"] = x.i + 1, ["name"] = $"{x.o.Value<string>("op")} {x.o.Value<string>("name")}".Trim(),
                        ["why"] = string.IsNullOrWhiteSpace(x.o.Value<string>("detail")) ? "already as asked (nothing to change)" : x.o.Value<string>("detail") }));
                line["apply_s"] = Math.Round(clock.Elapsed.TotalSeconds, 1);

                JObject flex = FmcDocGeometry.Flex(doc, item["follow"] as JArray);
                bool flexOk = flex.Value<bool?>("ok") != false;
                line["flex_ok"] = flexOk;
                if (!flexOk) line["flex_errors"] = new JArray((flex["types"] as JArray ?? new JArray()).OfType<JObject>().Where(t => t.Value<bool?>("ok") == false)
                    .Take(5).Select(t => $"{t.Value<string>("type")}: {string.Join("; ", (t["errors"] as JArray ?? new JArray()).Select(e => e.ToString()))}"));
                if (flex["follow"] != null) line["follow"] = flex["follow"];

                // an older staged file and its records go to <Role>\_Archive first; nothing is ever deleted
                if (File.Exists(target))
                    line["archived"] = Archive(target, item.Value<string>("archive_dir") ?? Path.Combine(Path.GetDirectoryName(target), "_Archive"));
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                doc.SaveAs(target, FmcPreview.Options(doc, false, backups, target));
                string image = FmcPreview.ExportPng(doc, target, out string imageWhy);
                line["image"] = image.Length > 0 ? image : "none: " + imageWhy;
                if (item["recipe"] is JObject recipe)
                    File.WriteAllText(Path.ChangeExtension(target, null) + ".recipe.json", recipe.ToString(Formatting.Indented), new UTF8Encoding(false));
                line["saved"] = target;
                line["ok"] = true;
            }
            catch (Exception ex)
            {
                line["ok"] = false;
                line["error"] = ex.Message;
            }
            finally
            {
                try { doc?.Close(false); } catch (Exception) { /* closing a family that never saved */ }
                line["s"] = Math.Round(clock.Elapsed.TotalSeconds, 1);
            }
            return line;
        }

        /// <summary>Moves the staged family and its .recipe.json / .gate.json to the archive folder with a time stamp.</summary>
        private static JArray Archive(string target, string archiveDir)
        {
            Directory.CreateDirectory(archiveDir);
            string stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
            string stem = Path.GetFileNameWithoutExtension(target), dir = Path.GetDirectoryName(target);
            var moved = new JArray();
            foreach (string ext in new[] { ".rfa", ".recipe.json", ".gate.json" })
            {
                string from = Path.Combine(dir, stem + ext);
                if (!File.Exists(from)) continue;
                string to = Path.Combine(archiveDir, $"{stem}_{stamp}{ext}");
                File.Move(from, to);
                moved.Add(to);
            }
            return moved;
        }

        private static void Append(string file, JObject line)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(line.ToString(Formatting.None) + "\n");
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    using (var fs = new FileStream(file, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
                        fs.Write(bytes, 0, bytes.Length);
                    return;
                }
                catch (IOException) { Thread.Sleep(20); }
            }
        }
    }
}
