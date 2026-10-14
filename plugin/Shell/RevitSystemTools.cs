using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>Engineer › Systems and Structural in Revit: fmc_systems through the installed server (read-only).</summary>
    public sealed class RevitSystemTools : ISystemTools
    {
        public Task<SystemsCheck> ElectricalAsync(string projectFolder, bool save) =>
            Run(new JObject { ["action"] = "electrical", ["project_folder"] = projectFolder, ["save"] = save });

        public Task<SystemsCheck> StructuralAsync(string kitFolder, string projectFolder, bool save) =>
            Run(new JObject { ["action"] = "structural", ["kit_folder"] = kitFolder, ["project_folder"] = projectFolder, ["save"] = save });

        private static async Task<SystemsCheck> Run(JObject args)
        {
            CliResult r = await ServerCli.RunAsync("fmc_systems", args);
            var c = new SystemsCheck { Ok = r.Ok && r.Body["checks"] != null };
            if (!c.Ok) { c.Message = "Check refused: " + string.Join(" ", r.Reasons()); return c; }
            var b = r.Body;
            c.Model = b.Value<string>("model") ?? "";
            c.Saved = b.Value<string>("saved") ?? "";
            foreach (JObject x in ((JArray)b["checks"]).OfType<JObject>())
                c.Checks.Add(new CheckLine(x.Value<string>("check") ?? "", x.Value<string>("found") ?? "", x.Value<string>("state") ?? ""));
            foreach (JObject x in (b["boards"] as JArray ?? new JArray()).OfType<JObject>())
                c.Boards.Add(new BoardLine
                {
                    Name = x.Value<string>("name") ?? "", ConnectedVa = x.Value<double?>("connected_va") ?? 0, DemandVa = x.Value<double?>("demand_va") ?? 0,
                    Circuits = x.Value<int?>("circuits") ?? 0, FedBy = x.Value<string>("fed_by") ?? "", Check = x.Value<string>("check") ?? "", Note = x.Value<string>("note") ?? "",
                });
            foreach (JObject x in (b["results"] as JArray ?? new JArray()).OfType<JObject>())
                c.Results.Add(new ResultLine { Mark = x.Value<string>("mark") ?? "", Type = x.Value<string>("type") ?? "", Utilisation = x.Value<double?>("utilisation") ?? 0, Run = x.Value<string>("run") ?? "" });
            c.NotInKit.AddRange(RevitFamilyTools.Strings(b["not_in_kit"]));
            if (b["members"] is JObject m)
                c.Members = $"{m.Value<int?>("columns") ?? 0} columns, {m.Value<int?>("framing") ?? 0} beams, {m.Value<int?>("foundations") ?? 0} foundations";
            int warn = c.Checks.Count(x => x.State == "Warn"), fail = c.Checks.Count(x => x.State == "Fail");
            c.Message = $"{c.Model}: {fail} fail, {warn} warn. Read-only, nothing changed.";
            return c;
        }
    }
}
