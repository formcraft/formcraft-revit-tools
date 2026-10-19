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
        /// <summary>Where its revision cloud is ("A-1001 Ground floor · rev P02"), empty until drawn.</summary>
        public string Cloud { get; set; } = "";

        // ---- Mark & Review tickets (PLAN_MARK_REVIEW R1/R2): empty To means a plain review item
        /// <summary>Who fixes it: ai, person, discipline or anyone; empty for a review item raised the MAN 10.5 way.</summary>
        public string To { get; set; } = "";
        /// <summary>mark, clash, review or bcf.</summary>
        public string Source { get; set; } = "";
        /// <summary>The thread: the first note and every reply, typed or spoken.</summary>
        public List<TicketNote> Notes { get; set; } = new List<TicketNote>();
        public bool HasPicture { get; set; }
        /// <summary>Elements it points at (UniqueIds, and in linked models).</summary>
        public int Elements { get; set; }
        public bool IsTicket => To.Length > 0;
        public bool HasVoice => Notes.Any(n => n.IsVoice);
        public string ToShown => To == "ai" ? "AI modeller" : To == "anyone" ? "Anyone" : To == "discipline" ? Owner : To == "person" ? Owner : To;
        public string LatestNote => Notes.Count == 0 ? Description : Notes[Notes.Count - 1].Shown;
        public string Media => HasVoice && HasPicture ? "voice · picture" : HasVoice ? "voice" : HasPicture ? "picture" : "—";
        public ChipKind Kind => Status == "Closed" ? ChipKind.Grey : Status == "Resolved" ? ChipKind.Good : Status == "Overdue" ? ChipKind.Bad : Status == "In progress" ? ChipKind.Warn : ChipKind.Info;
    }

    /// <summary>A note in a ticket's thread: typed, or a voice note with its offline transcript.</summary>
    public sealed class TicketNote
    {
        public string At { get; set; } = "";
        public string By { get; set; } = "";
        public string Text { get; set; } = "";
        /// <summary>The audio file, relative to 01_WIP\_Reviews (empty for a typed note).</summary>
        public string Audio { get; set; } = "";
        public string Transcript { get; set; } = "";
        /// <summary>e.g. "whisper small (offline)".</summary>
        public string TranscribedBy { get; set; } = "";
        public bool IsVoice => Audio.Length > 0;
        public bool NeedsTranscript => IsVoice && Transcript.Length == 0;
        /// <summary>What the thread shows: the typed words, else the transcript, else that it waits for one.</summary>
        public string Shown => Text.Length > 0 ? Text : Transcript.Length > 0 ? Transcript : IsVoice ? "(voice note, not transcribed yet)" : "";
        public string How => !IsVoice ? "typed" : Transcript.Length > 0 ? "voice · " + (TranscribedBy.Length > 0 ? TranscribedBy : "transcribed") : "voice";
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

    public sealed class PrintInfo
    {
        public PrintInfo(string sheet, string kind, string at, int items, string folder) { Sheet = sheet; Kind = kind; At = at; Items = items; Folder = folder; }
        public string Sheet { get; }
        public string Kind { get; }
        public string At { get; }
        public int Items { get; }
        public string Folder { get; }
    }

    /// <summary>Team › Review: fmc_review through the server (the project's review register, MAN 10.5).</summary>
    public interface IReviewTools
    {
        /// <summary>A revision cloud around the item's elements in the active view: dry run, then the real run (behind the lock).</summary>
        Task<ToolResult> CloudAsync(string projectFolder, string id, bool dryRun);
        /// <summary>The sheet's PDF and its items, "For review" or "As revised".</summary>
        Task<ToolResult> PrintAsync(string projectFolder, string sheet, string kind, string by);
        Task<List<PrintInfo>> PrintsAsync(string projectFolder, string sheet);
        Task<(bool Ok, string Message, List<ReviewItemInfo> Items)> ListAsync(string projectFolder, string filter, IReadOnlyList<string> myDisciplines);
        Task<(bool Ok, string Message, ReviewItemInfo? Item)> RaiseAsync(RaiseRequest q);
        /// <summary>answer (discipline, text, done), solve (text), check (accept, text), take (a ticket).</summary>
        Task<(bool Ok, string Message, ReviewItemInfo? Item)> ActAsync(string projectFolder, string action, string id, string by,
            string discipline = "", string text = "", bool done = true, bool accept = true);
        /// <summary>A reply in a ticket's thread (comment): typed words, or a voice note's WAV (copied beside the register).</summary>
        Task<(bool Ok, string Message, ReviewItemInfo? Item)> ReplyAsync(string projectFolder, string id, string by, string text, string audioPath);
        /// <summary>Offline Whisper on a note (1 = the first): small or medium, language auto or a code.</summary>
        Task<(bool Ok, string Message, ReviewItemInfo? Item)> TranscribeAsync(string projectFolder, string id, int note, string model, string language, string by);
        /// <summary>What Whisper has on this PC (dry run), or download what is missing (dryRun false).</summary>
        Task<ToolResult> WhisperSetupAsync(string model, bool dryRun);
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
            // Mark & Review tickets (R1): one marked by voice for the AI, one clash for a discipline
            new ReviewItemInfo { Id = "F26001-ISS-0016", Title = "Raise the ceiling to 2700 over the bed.", Description = "Raise the ceiling to 2700 over the bed. It is too low for the pendant.",
                Disciplines = new List<string> { "BIM" }, Lead = "BIM", Owner = "AI modeller", Priority = "High", Due = "2026-10-26", Status = "Open", RaisedBy = "[NAME A]",
                To = "ai", Source = "mark", HasPicture = true, Elements = 1,
                Notes = new List<TicketNote> { new TicketNote { At = "2026-10-19T09:00:00Z", By = "[NAME A]", Audio = @"media\F26001-ISS-0016\note-1.wav",
                    Transcript = "Raise the ceiling to 2700 over the bed. It is too low for the pendant.", TranscribedBy = "whisper small (offline)" } } },
            new ReviewItemInfo { Id = "F26001-ISS-0015", Title = "Duct vs beam at C/4", Description = "Clash 12 of Test 3: supply duct through beam B12",
                Disciplines = new List<string> { "M" }, Lead = "M", Owner = "M lead", Priority = "Medium", Due = "2026-11-02", Status = "In progress", RaisedBy = "Navisworks",
                To = "discipline", Source = "clash", Elements = 2,
                Notes = new List<TicketNote> { new TicketNote { At = "2026-10-18T15:20:00Z", By = "Navisworks", Text = "Clash 12 of Test 3: supply duct through beam B12" } } },
        };

        /// <summary>Whisper on this mock PC: the tool is there, the medium model isn't.</summary>
        public bool WhisperMedium { get; private set; }
        public List<(string Id, int Note, string Model, string Language)> Transcribed { get; } = new List<(string, int, string, string)>();

        public Task<(bool Ok, string Message, List<ReviewItemInfo> Items)> ListAsync(string projectFolder, string filter, IReadOnlyList<string> myDisciplines)
        {
            var list = Items.Where(i => filter == "All" || filter == "Open" && i.Status != "Closed" || filter == "Closed" && i.Status == "Closed"
                || filter == "Overdue" && i.Status == "Overdue" || filter == "My discipline" && i.Status != "Closed" && i.Disciplines.Intersect(myDisciplines).Any()).ToList();
            return Task.FromResult((true, list.Count + " items (" + filter + ").", list));
        }

        public List<(string Id, bool Dry)> Clouds { get; } = new List<(string, bool)>();
        public List<PrintInfo> PrintLog { get; } = new List<PrintInfo>();

        public Task<ToolResult> CloudAsync(string projectFolder, string id, bool dryRun)
        {
            Clouds.Add((id, dryRun));
            var i = Items.First(x => x.Id == id);
            var r = new ToolResult { Ok = true, Count = 1 };
            if (dryRun) r.Details.Add("On A-1001 Ground floor plan, revision P02 Review, around " + i.ElementIds.Count + " elements (2400 x 1800 mm)");
            else { i.Cloud = "A-1001 Ground floor plan · P02 Review"; r.Messages.Add(new ToolMessage(ChipKind.Good, "Clouded " + id + " on A-1001.")); }
            return Task.FromResult(r);
        }

        public Task<ToolResult> PrintAsync(string projectFolder, string sheet, string kind, string by)
        {
            var count = Items.Count(i => kind == "For review" ? i.Status != "Closed" && i.Status != "Resolved" : i.Status == "Closed" || i.Status == "Resolved");
            PrintLog.Insert(0, new PrintInfo(sheet, kind, "2026-10-14", count, projectFolder + @"\01_WIP\_Reviews\Prints\" + sheet));
            var r = new ToolResult { Ok = true, Count = 1 };
            r.Messages.Add(new ToolMessage(ChipKind.Good, kind + " print of " + sheet + " saved: PDF and " + count + " items."));
            return Task.FromResult(r);
        }

        public Task<List<PrintInfo>> PrintsAsync(string projectFolder, string sheet) => Task.FromResult(PrintLog.Where(p => p.Sheet == sheet).ToList());

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
                case "take":
                    if (i.To == "ai") return Task.FromResult<(bool, string, ReviewItemInfo?)>((false, i.Id + " is for the AI modeller: hand it to a person first", i));
                    if (i.To == "anyone") { i.Owner = by; i.To = "person"; }
                    i.Status = "In progress";
                    break;
            }
            return Task.FromResult<(bool, string, ReviewItemInfo?)>((true, i.Id + ": " + i.Status + ".", i));
        }

        public Task<(bool Ok, string Message, ReviewItemInfo? Item)> ReplyAsync(string projectFolder, string id, string by, string text, string audioPath)
        {
            var i = Items.First(x => x.Id == id);
            if (i.Status == "Closed") return Task.FromResult<(bool, string, ReviewItemInfo?)>((false, id + " is closed: reopen it first", i));
            if (text.Trim().Length == 0 && audioPath.Length == 0) return Task.FromResult<(bool, string, ReviewItemInfo?)>((false, "A reply needs words or a voice note", i));
            var n = i.Notes.Count + 1;
            i.Notes.Add(new TicketNote { At = "2026-10-19T10:0" + Math.Min(9, n) + ":00Z", By = by, Text = text.Trim(), Audio = audioPath.Length > 0 ? @"media\" + id + @"\note-" + n + ".wav" : "" });
            return Task.FromResult<(bool, string, ReviewItemInfo?)>((true, audioPath.Length > 0 ? "Voice reply added to " + id + "." : "Reply added to " + id + ".", i));
        }

        public Task<(bool Ok, string Message, ReviewItemInfo? Item)> TranscribeAsync(string projectFolder, string id, int note, string model, string language, string by)
        {
            var i = Items.First(x => x.Id == id);
            if (model == "medium" && !WhisperMedium) return Task.FromResult<(bool, string, ReviewItemInfo?)>((false, "The medium model isn't downloaded: check Whisper under Voice notes", i));
            var n = i.Notes[note - 1];
            n.Transcript = "Use the 1026 single door here, same as the other one.";
            n.TranscribedBy = "whisper " + model + " (offline)";
            Transcribed.Add((id, note, model, language));
            return Task.FromResult<(bool, string, ReviewItemInfo?)>((true, "Note " + note + " transcribed (whisper " + model + ", offline).", i));
        }

        public Task<ToolResult> WhisperSetupAsync(string model, bool dryRun)
        {
            var r = new ToolResult { Ok = true };
            if (model == "small" || WhisperMedium) { r.Messages.Add(new ToolMessage(ChipKind.Good, "Whisper is ready: voice notes transcribe offline (" + model + " model).")); return Task.FromResult(r); }
            if (dryRun) { r.Count = 1; r.Details.Add("The medium model, 1534 MB, from huggingface.co/ggerganov/whisper.cpp (SHA-256 checked)"); return Task.FromResult(r); }
            WhisperMedium = true;
            r.Messages.Add(new ToolMessage(ChipKind.Good, "Downloaded the medium model (SHA-256 checked)."));
            return Task.FromResult(r);
        }
    }
}
