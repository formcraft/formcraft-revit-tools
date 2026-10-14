using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    public sealed class ReviewAnswer
    {
        public ReviewAnswer(string discipline, string by, string text, bool done) { Discipline = discipline; By = by; Text = text; Done = done; }
        public string Discipline { get; }
        public string By { get; }
        public string Text { get; }
        public bool Done { get; }
    }

    public sealed class ReviewItemInfo
    {
        public string Id { get; set; } = "";
        public string Title { get; set; } = "";
        public string Description { get; set; } = "";
        public List<string> Disciplines { get; set; } = new List<string>();
        public string Lead { get; set; } = "";
        public string Owner { get; set; } = "";
        public string Priority { get; set; } = "High";
        public string Due { get; set; } = "";
        /// <summary>Open, In progress, Resolved, Closed, or Overdue once the due date passes.</summary>
        public string Status { get; set; } = "Open";
        public string RaisedBy { get; set; } = "";
        public string View { get; set; } = "";
        public List<long> ElementIds { get; set; } = new List<long>();
        public List<ReviewAnswer> Answers { get; set; } = new List<ReviewAnswer>();
        public string Solution { get; set; } = "";
        public ChipKind Kind => Status == "Closed" ? ChipKind.Grey : Status == "Resolved" ? ChipKind.Good : Status == "Overdue" ? ChipKind.Bad : Status == "In progress" ? ChipKind.Warn : ChipKind.Info;
    }

    public sealed class RaiseRequest
    {
        public string ProjectFolder { get; set; } = "";
        public string ProjectCode { get; set; } = "";
        public string Title { get; set; } = "";
        public string Description { get; set; } = "";
        public List<string> Disciplines { get; set; } = new List<string>();
        public string Lead { get; set; } = "";
        public string Owner { get; set; } = "";
        public string Priority { get; set; } = "High";
        public string Due { get; set; } = "";
        public bool LinkSelection { get; set; } = true;
        public string By { get; set; } = "";
    }

    /// <summary>Team › Review: fmc_review through the server (the project's review register, MAN 10.5).</summary>
    public interface IReviewTools
    {
        Task<(bool Ok, string Message, List<ReviewItemInfo> Items)> ListAsync(string projectFolder, string filter, IReadOnlyList<string> myDisciplines);
        Task<(bool Ok, string Message, ReviewItemInfo? Item)> RaiseAsync(RaiseRequest q);
        /// <summary>answer (discipline, text, done), solve (text), check (accept, text).</summary>
        Task<(bool Ok, string Message, ReviewItemInfo? Item)> ActAsync(string projectFolder, string action, string id, string by,
            string discipline = "", string text = "", bool done = true, bool accept = true);
    }

    /// <summary>Sample values from board manage/PaneReview; keeps its own register in memory.</summary>
    public sealed class MockReviewTools : IReviewTools
    {
        public List<ReviewItemInfo> Items { get; } = new List<ReviewItemInfo>
        {
            new ReviewItemInfo { Id = "F26001-ISS-0014", Title = "Beam vs ceiling, C/4", Description = "600 mm downstand leaves 2.25 m clear", Disciplines = new List<string> { "S", "A" },
                Lead = "S", Owner = "[NAME F]", Priority = "High", Due = "2026-10-20", Status = "In progress", RaisedBy = "[NAME A]",
                ElementIds = new List<long> { 11, 12 }, Answers = new List<ReviewAnswer> { new ReviewAnswer("S", "[NAME F]", "Beam cut to 450 mm deep", true) } },
            new ReviewItemInfo { Id = "F26001-ISS-0013", Title = "Door swing into corridor", Description = "D12 opens into the escape route", Disciplines = new List<string> { "A" },
                Lead = "A", Owner = "[NAME A]", Priority = "Medium", Due = "2026-10-22", Status = "Open", RaisedBy = "[NAME E]" },
            new ReviewItemInfo { Id = "F26001-ISS-0011", Title = "Fire door rating, stair 1", Description = "FD30 shown, FD60 needed", Disciplines = new List<string> { "A", "FP" },
                Lead = "A", Owner = "[NAME A]", Priority = "Critical", Due = "2026-10-11", Status = "Overdue", RaisedBy = "[NAME E]" },
        };

        public Task<(bool Ok, string Message, List<ReviewItemInfo> Items)> ListAsync(string projectFolder, string filter, IReadOnlyList<string> myDisciplines)
        {
            var list = Items.Where(i => filter == "All" || filter == "Open" && i.Status != "Closed" || filter == "Closed" && i.Status == "Closed"
                || filter == "Overdue" && i.Status == "Overdue" || filter == "My discipline" && i.Status != "Closed" && i.Disciplines.Intersect(myDisciplines).Any()).ToList();
            return Task.FromResult((true, list.Count + " items (" + filter + ").", list));
        }

        public Task<(bool Ok, string Message, ReviewItemInfo? Item)> RaiseAsync(RaiseRequest q)
        {
            if (q.Title.Trim().Length == 0 || q.Owner.Trim().Length == 0 || q.Lead.Trim().Length == 0)
                return Task.FromResult<(bool, string, ReviewItemInfo?)>((false, "Give the item a title, a lead discipline and one owner (MAN 10.5).", null));
            var item = new ReviewItemInfo { Id = "F26001-ISS-" + (15 + Items.Count - 3).ToString("0000"), Title = q.Title, Description = q.Description,
                Disciplines = new[] { q.Lead }.Concat(q.Disciplines).Distinct().ToList(), Lead = q.Lead, Owner = q.Owner, Priority = q.Priority,
                Due = q.Due.Length > 0 ? q.Due : "2026-10-21", Status = "Open", RaisedBy = q.By };
            Items.Insert(0, item);
            return Task.FromResult<(bool, string, ReviewItemInfo?)>((true, "Raised " + item.Id + ".", item));
        }

        public Task<(bool Ok, string Message, ReviewItemInfo? Item)> ActAsync(string projectFolder, string action, string id, string by,
            string discipline = "", string text = "", bool done = true, bool accept = true)
        {
            var i = Items.First(x => x.Id == id);
            switch (action)
            {
                case "answer":
                    i.Answers.RemoveAll(a => a.Discipline == discipline);
                    i.Answers.Add(new ReviewAnswer(discipline, by, text, done));
                    if (i.Status == "Open") i.Status = "In progress";
                    break;
                case "solve":
                    var missing = i.Disciplines.Where(d => !i.Answers.Any(a => a.Discipline == d)).ToList();
                    if (missing.Count > 0) return Task.FromResult<(bool, string, ReviewItemInfo?)>((false, "Waiting for " + string.Join(", ", missing) + " to answer first.", i));
                    i.Solution = text; i.Status = "Resolved";
                    break;
                case "check":
                    if (!accept && text.Trim().Length == 0) return Task.FromResult<(bool, string, ReviewItemInfo?)>((false, "Say why you reopen it.", i));
                    i.Status = accept ? "Closed" : "In progress";
                    break;
            }
            return Task.FromResult<(bool, string, ReviewItemInfo?)>((true, i.Id + ": " + i.Status + ".", i));
        }
    }
}
