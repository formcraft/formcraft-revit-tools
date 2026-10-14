using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>Setup › Materials in Revit: fmc_material through the installed server.</summary>
    public sealed class RevitMaterialTools : IMaterialTools
    {
        public async Task<MaterialDatabase> DatabaseAsync(string cls, string query)
        {
            CliResult r = await ServerCli.RunAsync("fmc_material", new JObject { ["action"] = "database", ["class"] = cls, ["query"] = query });
            var db = new MaterialDatabase { Ok = r.Ok };
            if (!r.Ok) { db.Message = string.Join(" ", r.Reasons()); return db; }
            db.File = r.Body.Value<string>("file") ?? "";
            db.Version = r.Body.Value<string>("version") ?? "";
            db.Count = r.Body.Value<int?>("count") ?? 0;
            db.Classes.AddRange(RevitFamilyTools.Strings(r.Body["classes"]));
            foreach (JObject m in (r.Body["materials"] as JArray ?? new JArray()).OfType<JObject>())
            {
                var g = m["graphics"] as JObject ?? new JObject();
                var item = new DbMaterial
                {
                    Name = m.Value<string>("name"), Class = m.Value<string>("class") ?? "", Sub = m.Value<string>("sub") ?? "",
                    Keynote = m.Value<string>("keynote") ?? "", CostCode = m.Value<string>("cost_code") ?? "", Supplier = m.Value<string>("supplier") ?? "",
                    Graphics = string.Join(" · ", new[] { ("Shaded ", g.Value<string>("shaded")), ("surface ", g.Value<string>("surface")), ("cut ", g.Value<string>("cut")) }
                        .Where(x => !string.IsNullOrEmpty(x.Item2)).Select(x => x.Item1 + x.Item2)),
                };
                foreach (JObject x in (m["maps"] as JArray ?? new JArray()).OfType<JObject>())
                    item.Maps.Add((x.Value<string>("map") ?? "", x.Value<string>("file") ?? "", x["size_mm"]?.Type == JTokenType.Null ? "—" : x.Value<double?>("size_mm") + " mm"));
                db.Materials.Add(item);
            }
            return db;
        }

        public async Task<(bool Ok, string Message, List<MaterialCheck> Checks)> AuditAsync()
        {
            CliResult r = await ServerCli.RunAsync("fmc_material", new JObject { ["action"] = "audit" });
            if (!r.Ok || r.Body["checks"] == null) return (false, "Audit refused: " + string.Join(" ", r.Reasons()), new List<MaterialCheck>());
            var checks = ((JArray)r.Body["checks"]).OfType<JObject>()
                .Select(c => new MaterialCheck(c.Value<string>("check"), c.Value<int?>("found") ?? 0, c.Value<string>("result") ?? "", RevitFamilyTools.Strings(c["items"]))).ToList();
            string note = r.Body.Value<string>("database_problem");
            return (true, "Audited " + r.Body.Value<string>("model") + "." + (string.IsNullOrEmpty(note) ? "" : " " + note), checks);
        }

        public async Task<AssignPlan> AssignAsync(string material, string target, string category, string contains, string parameter, bool dryRun)
        {
            CliResult r = await ServerCli.RunAsync("fmc_material", new JObject
            {
                ["action"] = "assign", ["material"] = material, ["target"] = target, ["category"] = category, ["contains"] = contains,
                ["parameter"] = parameter, ["dry_run"] = dryRun,
            });
            var plan = new AssignPlan { Ok = r.Ok };
            if (!r.Ok) { plan.Message = (dryRun ? "Assign refused: " : "Assign failed: ") + string.Join(" ", r.Reasons()); return plan; }
            var types = (dryRun ? r.Body["would_change"] : r.Body["changed"]) as JArray ?? new JArray();
            foreach (JObject t in types.OfType<JObject>()) plan.Types.Add((t.Value<string>("type"), t.Value<int?>("elements") ?? 0, t.Value<string>("change") ?? ""));
            plan.CreatesMaterial = (dryRun ? r.Body.Value<bool?>("creates_material") : r.Body.Value<bool?>("created")) ?? false;
            plan.Message = dryRun ? "Plan only: nothing changed."
                : $"Assigned {material} to {plan.Types.Count(t => !t.Change.StartsWith("skipped"))} types. Logged in FMC_MCP_FileLog.csv.";
            return plan;
        }

        public async Task<(bool Ok, string Message, List<string> Materials)> PurgeAsync(bool dryRun)
        {
            CliResult r = await ServerCli.RunAsync("fmc_material", new JObject { ["action"] = "purge", ["dry_run"] = dryRun });
            if (!r.Ok) return (false, (dryRun ? "Purge refused: " : "Purge failed: ") + string.Join(" ", r.Reasons()), new List<string>());
            var list = RevitFamilyTools.Strings(dryRun ? r.Body["would_purge"] : r.Body["purged"]);
            return (true, dryRun ? $"Would purge {list.Count} unused materials." : $"Purged {list.Count} unused materials. Logged in FMC_MCP_FileLog.csv.", list);
        }

        public async Task<string> RequestAsync(string name, string text)
        {
            CliResult r = await ServerCli.RunAsync("fmc_material", new JObject { ["action"] = "request", ["name"] = name, ["text"] = text });
            return r.Ok ? "Requested " + name + ". The BIM Manager adds it to the database with its textures." : "Request refused: " + string.Join(" ", r.Reasons());
        }

        public async Task<string> UpdatesAsync()
        {
            CliResult r = await ServerCli.RunAsync("fmc_material", new JObject { ["action"] = "updates" });
            if (!r.Ok) return "Can't check: " + string.Join(" ", r.Reasons());
            return r.Body.Value<bool?>("changed") == true
                ? $"The material database moved from v{r.Body.Value<string>("previous")} to v{r.Body.Value<string>("version")}."
                : $"The material database is v{r.Body.Value<string>("version")}: no update since you last checked.";
        }
    }
}
