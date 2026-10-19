using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>Team › Review in Revit: fmc_review through the installed server (the project's review register).</summary>
    public sealed class RevitReviewTools : IReviewTools
    {
        private static ReviewItemInfo Item(JObject i) => new ReviewItemInfo
        {
            Id = i.Value<string>("id") ?? "", Title = i.Value<string>("title") ?? "", Description = i.Value<string>("description") ?? "",
            Disciplines = RevitFamilyTools.Strings(i["disciplines"]), Lead = i.Value<string>("lead") ?? "", Owner = i.Value<string>("owner") ?? "",
            Priority = i.Value<string>("priority") ?? "", Due = i.Value<string>("due") ?? "",
            Status = i.Value<string>("shown_status") ?? i.Value<string>("status") ?? "", RaisedBy = i.Value<string>("raised_by") ?? "",
            View = i.Value<string>("view") is string v && v.Length > 0 ? v : (i["where"] as JObject)?.Value<string>("view") ?? "",
            ElementIds = (i["element_ids"] as JArray ?? new JArray()).Select(x => x.Value<long>()).ToList(),
            Answers = (i["answers"] as JArray ?? new JArray()).OfType<JObject>()
                .Select(a => new ReviewAnswer(a.Value<string>("discipline") ?? "", a.Value<string>("by") ?? "", a.Value<string>("text") ?? "", a.Value<string>("status") == "Done")).ToList(),
            Solution = i.Value<string>("solution") ?? "",
            Cloud = i["cloud"] is JObject c ? (c.Value<string>("view") ?? "") + " · " + (c.Value<string>("revision") ?? "") : "",
            // Mark & Review tickets (R1): absent on plain review items
            To = i.Value<string>("to") ?? "", Source = i.Value<string>("source") ?? "",
            Notes = (i["notes"] as JArray ?? new JArray()).OfType<JObject>().Select(n => new TicketNote
            {
                At = n.Value<string>("at") ?? "", By = n.Value<string>("by") ?? "", Text = n.Value<string>("text") ?? "", Audio = n.Value<string>("audio") ?? "",
                Transcript = n.Value<string>("transcript") ?? "", TranscribedBy = n.Value<string>("transcribed_by") ?? "",
            }).ToList(),
            HasPicture = !string.IsNullOrEmpty((i["pictures"] as JObject)?.Value<string>("raised")),
            Elements = Count(i["where"]?["unique_ids"]) + Count(i["where"]?["linked"]),
        };

        private static int Count(JToken t) => (t as JArray)?.Count ?? 0;

        public async Task<(bool Ok, string Message, ReviewItemInfo? Item)> ReplyAsync(string projectFolder, string id, string by, string text, string audioPath)
        {
            CliResult r = await ServerCli.RunAsync("fmc_review", new JObject
            {
                ["action"] = "comment", ["project_folder"] = projectFolder, ["id"] = id, ["by"] = by, ["text"] = text, ["audio"] = audioPath ?? "",
            });
            if (!r.Ok || !(r.Body["item"] is JObject i)) return (false, string.Join(" ", r.Reasons()), null);
            return (true, (string.IsNullOrEmpty(audioPath) ? "Reply added to " : "Voice reply added to ") + id + ".", Item(i));
        }

        public async Task<(bool Ok, string Message, ReviewItemInfo? Item)> TranscribeAsync(string projectFolder, string id, int note, string model, string language, string by)
        {
            // whisper runs in the server's child process at below-normal priority; a minute of speech takes about a minute on the small model
            CliResult r = await ServerCli.RunAsync("fmc_review", new JObject
            {
                ["action"] = "transcribe", ["project_folder"] = projectFolder, ["id"] = id, ["note"] = note, ["model"] = model, ["language"] = language, ["by"] = by,
            });
            if (!r.Ok || !(r.Body["item"] is JObject i)) return (false, string.Join(" ", r.Reasons()), null);
            var item = Item(i);
            var n = note >= 1 && note <= item.Notes.Count ? item.Notes[note - 1] : null;
            return (true, $"Note {note} transcribed ({n?.TranscribedBy ?? "whisper " + model + " (offline)"}).", item);
        }

        public async Task<ToolResult> WhisperSetupAsync(string model, bool dryRun)
        {
            CliResult r = await ServerCli.RunAsync("fmc_review", new JObject { ["action"] = "whisper_setup", ["model"] = model, ["dry_run"] = dryRun });
            if (!r.Ok) return ToolResult.Refused("Whisper: " + string.Join(" ", r.Reasons()));
            var result = new ToolResult { Ok = true };
            if (r.Body.Value<bool?>("ready") == true)
                result.Messages.Add(new ToolMessage(ChipKind.Good, $"Whisper is ready: voice notes transcribe offline ({model} model)."));
            else if (r.Body["would_download"] is JArray steps)
            {
                result.Count = steps.Count;
                foreach (var s in steps.OfType<JObject>())
                    result.Details.Add($"{s.Value<string>("what")}, {s.Value<int?>("mb")} MB, into {s.Value<string>("to")}");
            }
            else
                foreach (var line in (r.Body["installed"] as JArray ?? new JArray()).Select(x => x.ToString()))
                    result.Messages.Add(new ToolMessage(ChipKind.Good, "Installed " + line + "."));
            return result;
        }

        public async Task<ToolResult> CloudAsync(string projectFolder, string id, bool dryRun)
        {
            CliResult r = await ServerCli.RunAsync("fmc_review", new JObject { ["action"] = "cloud", ["project_folder"] = projectFolder, ["id"] = id, ["dry_run"] = dryRun });
            if (!r.Ok) return ToolResult.Refused("Cloud refused: " + string.Join(" ", r.Reasons()));
            var result = new ToolResult { Ok = true, Count = 1 };
            if (dryRun && r.Body["would"] is JObject w)
                result.Details.Add($"On {w.Value<string>("view")}, revision {w.Value<string>("revision")}, around {w.Value<int?>("elements")} elements ({w.Value<string>("size_mm")} mm)");
            else result.Messages.Add(new ToolMessage(ChipKind.Good, "Clouded " + id + ". Logged in FMC_MCP_FileLog.csv."));
            return result;
        }

        public async Task<ToolResult> PrintAsync(string projectFolder, string sheet, string kind, string by)
        {
            CliResult r = await ServerCli.RunAsync("fmc_review", new JObject { ["action"] = "print", ["project_folder"] = projectFolder, ["sheet"] = sheet, ["kind"] = kind, ["by"] = by });
            if (!r.Ok) return ToolResult.Refused("Print refused: " + string.Join(" ", r.Reasons()));
            var result = new ToolResult { Ok = true, Count = 1 };
            int n = (r.Body["items"] as JArray)?.Count ?? 0;
            string pdf = r.Body.Value<string>("pdf") ?? "";
            result.Messages.Add(new ToolMessage(pdf == "exported" ? ChipKind.Good : ChipKind.Warn, $"{kind} print of {sheet}: {n} items, PDF {pdf}. Saved to {r.Body.Value<string>("folder")}."));
            return result;
        }

        public async Task<List<PrintInfo>> PrintsAsync(string projectFolder, string sheet)
        {
            CliResult r = await ServerCli.RunAsync("fmc_review", new JObject { ["action"] = "prints", ["project_folder"] = projectFolder, ["sheet"] = sheet });
            return (r.Body["prints"] as JArray ?? new JArray()).OfType<JObject>().Select(p => new PrintInfo(p.Value<string>("sheet") ?? "", p.Value<string>("kind") ?? "",
                (p.Value<string>("at") ?? "").Length >= 10 ? p.Value<string>("at").Substring(0, 10) : "", (p["items"] as JArray)?.Count ?? 0, p.Value<string>("folder") ?? "")).ToList();
        }

        public async Task<(bool Ok, string Message, List<ReviewItemInfo> Items)> ListAsync(string projectFolder, string filter, IReadOnlyList<string> myDisciplines)
        {
            // One call: the pane shows answers and solutions, so it asks for whole items.
            CliResult r = await ServerCli.RunAsync("fmc_review", new JObject
            {
                ["action"] = "list", ["project_folder"] = projectFolder, ["filter"] = filter, ["my_disciplines"] = JArray.FromObject(myDisciplines), ["full"] = true,
            });
            if (!r.Ok || r.Body["items"] == null) return (false, "Review register: " + string.Join(" ", r.Reasons()), new List<ReviewItemInfo>());
            var items = ((JArray)r.Body["items"]).OfType<JObject>().Select(Item).ToList();
            int overdue = r.Body.Value<int?>("overdue") ?? 0;
            return (true, $"{items.Count} items ({filter})" + (overdue > 0 ? $", {overdue} overdue." : "."), items);
        }

        public async Task<(bool Ok, string Message, ReviewItemInfo? Item)> RaiseAsync(RaiseRequest q)
        {
            CliResult r = await ServerCli.RunAsync("fmc_review", new JObject
            {
                ["action"] = "raise", ["project_folder"] = q.ProjectFolder, ["project_code"] = q.ProjectCode, ["title"] = q.Title,
                ["description"] = q.Description, ["disciplines"] = JArray.FromObject(q.Disciplines), ["lead"] = q.Lead, ["owner"] = q.Owner,
                ["priority"] = q.Priority, ["due"] = q.Due, ["link_selection"] = q.LinkSelection, ["by"] = q.By,
            });
            if (!r.Ok || !(r.Body["item"] is JObject i)) return (false, string.Join(" ", r.Reasons()), null);
            var item = Item(i);
            return (true, $"Raised {item.Id}, due {item.Due}" + (item.ElementIds.Count > 0 ? $", {item.ElementIds.Count} elements linked." : "."), item);
        }

        public async Task<(bool Ok, string Message, ReviewItemInfo? Item)> ActAsync(string projectFolder, string action, string id, string by,
            string discipline = "", string text = "", bool done = true, bool accept = true)
        {
            CliResult r = await ServerCli.RunAsync("fmc_review", new JObject
            {
                ["action"] = action, ["project_folder"] = projectFolder, ["id"] = id, ["by"] = by, ["discipline"] = discipline,
                ["text"] = text, ["done"] = done, ["accept"] = accept,
            });
            if (!r.Ok || !(r.Body["item"] is JObject i)) return (false, string.Join(" ", r.Reasons()), null);
            var item = Item(i);
            return (true, item.Id + ": " + item.Status + ".", item);
        }
    }
}
