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
            View = i.Value<string>("view") ?? "",
            ElementIds = (i["element_ids"] as JArray ?? new JArray()).Select(x => x.Value<long>()).ToList(),
            Answers = (i["answers"] as JArray ?? new JArray()).OfType<JObject>()
                .Select(a => new ReviewAnswer(a.Value<string>("discipline") ?? "", a.Value<string>("by") ?? "", a.Value<string>("text") ?? "", a.Value<string>("status") == "Done")).ToList(),
            Solution = i.Value<string>("solution") ?? "",
        };

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
