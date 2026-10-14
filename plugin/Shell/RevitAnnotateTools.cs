using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>Drawings › Annotate in Revit: fmc_annotate through the installed server.</summary>
    public sealed class RevitAnnotateTools : IAnnotateTools
    {
        public async Task<AnnotationStandardInfo> StandardAsync()
        {
            CliResult r = await ServerCli.RunAsync("fmc_annotate", new JObject { ["action"] = "standard" });
            var s = new AnnotationStandardInfo { Ok = r.Ok };
            if (!r.Ok) { s.Message = string.Join(" ", r.Reasons()); return s; }
            var b = r.Body;
            s.File = b.Value<string>("file") ?? "";
            s.Version = b.Value<string>("version") ?? "";
            s.Source = b.Value<string>("source") ?? "";
            s.TagPattern = b.Value<string>("tag_pattern") ?? "";
            foreach (JObject p in (b["pens"] as JArray ?? new JArray()).OfType<JObject>())
                s.Pens.Add((p.Value<int>("pen"), p.Value<double?>("width_mm") ?? 0, p.Value<string>("used_for") ?? "", p.Value<string>("status") ?? ""));
            s.LinePatterns.AddRange(RevitFamilyTools.Strings(b["line_patterns"]));
            foreach (JObject t in (b["text_types"] as JArray ?? new JArray()).OfType<JObject>())
                s.TextTypes.Add((t.Value<string>("name"), t.Value<string>("font") ?? "", t["size_mm"]?.Type == JTokenType.Null ? "—" : t.Value<double?>("size_mm") + " mm"));
            foreach (JObject d in (b["dimension_styles"] as JArray ?? new JArray()).OfType<JObject>())
                s.DimensionStyles.Add((d.Value<string>("name"), d.Value<string>("status") ?? ""));
            s.Symbols.AddRange(RevitFamilyTools.Strings(b["symbols"]));
            foreach (JObject c in (b["colours"] as JArray ?? new JArray()).OfType<JObject>()) s.Colours.Add((c.Value<string>("name"), c.Value<string>("hex") ?? ""));
            return s;
        }

        public async Task<(bool Ok, string Message, List<AnnotationCheckLine> Checks)> CheckAsync()
        {
            CliResult r = await ServerCli.RunAsync("fmc_annotate", new JObject { ["action"] = "check" });
            if (!r.Ok || r.Body["checks"] == null) return (false, "Check refused: " + string.Join(" ", r.Reasons()), new List<AnnotationCheckLine>());
            var checks = ((JArray)r.Body["checks"]).OfType<JObject>().Select(c => new AnnotationCheckLine(c.Value<string>("check"), c.Value<int?>("found") ?? 0,
                c.Value<string>("state") ?? "", RevitFamilyTools.Strings(c["items"]), (c["ids"] as JArray ?? new JArray()).Select(i => i.Value<long>()).ToList())).ToList();
            string note = r.Body.Value<string>("standard_problem");
            return (true, "Checked " + r.Body.Value<string>("model") + " against the standard." + (string.IsNullOrEmpty(note) ? "" : " " + note), checks);
        }

        public async Task<(bool Ok, string Message, List<string> Views, List<MissingTagLine> Lines)> MissingTagsAsync(string scope)
        {
            CliResult r = await ServerCli.RunAsync("fmc_annotate", new JObject { ["action"] = "missing_tags", ["scope"] = scope });
            if (!r.Ok || r.Body["categories"] == null) return (false, "Report refused: " + string.Join(" ", r.Reasons()), new List<string>(), new List<MissingTagLine>());
            var views = RevitFamilyTools.Strings(r.Body["views"]);
            var lines = ((JArray)r.Body["categories"]).OfType<JObject>().Select(c => new MissingTagLine(c.Value<string>("category"), c.Value<int?>("untagged") ?? 0,
                c.Value<string>("tag_family") ?? "", (c["ids"] as JArray ?? new JArray()).Select(i => i.Value<long>()).ToList())).ToList();
            return (true, $"Counted untagged elements in {views.Count} view{(views.Count == 1 ? "" : "s")}.", views, lines);
        }

        public async Task<string> RequestAsync(string text)
        {
            CliResult r = await ServerCli.RunAsync("fmc_annotate", new JObject { ["action"] = "request", ["text"] = text });
            return r.Ok ? "Change proposed. The BIM Manager approves changes into the standard." : "Request refused: " + string.Join(" ", r.Reasons());
        }
    }
}
