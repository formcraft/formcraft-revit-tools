using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>Build in Revit: fmc_build through the installed server, and the view colours (BuildViews).</summary>
    public sealed class RevitBuildTools : IBuildTools
    {
        public async Task<BuildQuantities> MeasureAsync(string kitFolder, string projectFolder)
        {
            CliResult r = await ServerCli.RunAsync("fmc_build", new JObject { ["action"] = "quantities", ["kit_folder"] = kitFolder, ["project_folder"] = projectFolder });
            var q = new BuildQuantities { Ok = r.Ok && r.Body["items"] != null };
            if (!q.Ok) { q.Message = "Measure refused: " + string.Join(" ", r.Reasons()); return q; }
            var b = r.Body;
            q.Model = b.Value<string>("model") ?? "";
            q.Elements = b.Value<int?>("elements") ?? 0;
            var saved = (b["baseline"] as JObject)?.Value<string>("saved") ?? "";
            q.Baseline = DateTime.TryParse(saved, out var when) ? when.ToLocalTime().ToString("d MMM HH:mm") : saved;
            foreach (JObject x in ((JArray)b["items"]).OfType<JObject>())
                q.Items.Add(new BoqLine
                {
                    Code = x.Value<string>("code") ?? "", Description = x.Value<string>("description") ?? "", Unit = x.Value<string>("unit") ?? "",
                    Bill = x.Value<string>("group") ?? "", Package = x.Value<string>("package") ?? "", Count = x.Value<int?>("count") ?? 0,
                    Qty = x.Value<double?>("qty"), Previous = x.Value<double?>("previous"), Changed = x.Value<bool?>("changed") ?? false,
                });
            foreach (JObject x in (b["bills"] as JArray ?? new JArray()).OfType<JObject>())
                q.Bills.Add(new BillLine(x.Value<string>("bill") ?? "", x.Value<string>("package") ?? "", x.Value<int?>("items") ?? 0, x.Value<int?>("changed") ?? 0, x.Value<int?>("unmeasured") ?? 0));
            foreach (JObject x in (b["unmapped"] as JArray ?? new JArray()).OfType<JObject>()) q.Unmapped.Add((x.Value<string>("category") ?? "", x.Value<int?>("count") ?? 0));
            foreach (JObject x in (b["unknown_codes"] as JArray ?? new JArray()).OfType<JObject>()) q.UnknownCodes.Add((x.Value<string>("code") ?? "", x.Value<int?>("count") ?? 0));
            foreach (JObject x in (b["progress"] as JArray ?? new JArray()).OfType<JObject>()) q.Progress.Add((x.Value<string>("value") ?? "", x.Value<int?>("count") ?? 0));
            foreach (JObject x in (b["packages"] as JArray ?? new JArray()).OfType<JObject>()) q.Packages.Add((x.Value<string>("value") ?? "", x.Value<int?>("count") ?? 0));
            if (b["params_in_model"] is JObject pm)
                q.MissingParams.AddRange(pm.Properties().Where(p => p.Value.Type == JTokenType.Boolean && !(bool)p.Value).Select(p => p.Name));
            q.Message = $"{q.Bills.Count} bills, {q.Items.Count} items, {q.Items.Count(i => i.Changed)} changed" + (q.Baseline.Length > 0 ? " since the baseline." : " (no baseline yet).");
            return q;
        }

        public async Task<ToolResult> BaselineAsync(string kitFolder, string projectFolder)
        {
            CliResult r = await ServerCli.RunAsync("fmc_build", new JObject { ["action"] = "baseline", ["kit_folder"] = kitFolder, ["project_folder"] = projectFolder });
            if (!r.Ok) return ToolResult.Refused("Baseline refused: " + string.Join(" ", r.Reasons()));
            var result = new ToolResult { Ok = true };
            result.Messages.Add(new ToolMessage(ChipKind.Good, $"Baseline saved ({r.Body.Value<int?>("items") ?? 0} items): {r.Body.Value<string>("baseline")}. Logged."));
            return result;
        }

        public void ColourView(string mode) => BuildViews.Request(mode);
    }
}
