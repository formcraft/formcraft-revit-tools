using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>
    /// AI approvals (owner 26 Oct): its own page, open to everyone, from the header's "AI: N waiting" badge, not inside
    /// Admin (admins only). Each waiting batch with Approve (it runs now, through the same gate) or Reject; recent batches
    /// with their result. Refreshes itself when the queue changes (IAiTools.QueueChanged).
    /// </summary>
    public sealed class ApprovalsViewModel : ObservableObject
    {
        private readonly IAiTools _ai;
        private readonly Action<string> _status;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private List<AiQueueLine> _queue = new List<AiQueueLine>();
        private IReadOnlyList<SettingsGroup> _groups = Array.Empty<SettingsGroup>();
        private string _running = "";
        // Send to AI (owner 26 Oct): what the person types about the problem; the picture and ids come from Revit
        private readonly TextSetting _note = new TextSetting("What's wrong", placeholder: "e.g. this wall is doubled, the roof doesn't meet the gable");
        private readonly MessagesSetting _sendMessages = new MessagesSetting();

        public ApprovalsViewModel(IAiTools ai, Action<string> status)
        {
            _ai = ai;
            _status = status;
            Rebuild();
        }

        public IReadOnlyList<SettingsGroup> Groups { get => _groups; private set { _groups = value; OnPropertyChanged(); } }
        public int Waiting => _queue.Count(q => q.Status == "pending");

        public async Task RefreshAsync()
        {
            try { _queue = await _ai.QueueAsync(); }
            catch (Exception ex) { _status("The AI queue can't be read: " + ex.Message); }
            OnPropertyChanged(nameof(Waiting));
            Rebuild();
        }

        private void Rebuild()
        {
            var groups = new List<SettingsGroup>();
            var pending = _queue.Where(q => q.Status == "pending").ToList();
            var waiting = new List<SettingItem>();
            if (_running.Length > 0) waiting.Add(new NoteSetting("Running " + _running + "… The page updates when it's done.", ChipKind.Info));
            if (pending.Count == 0) waiting.Add(new NoteSetting("Nothing is waiting. When AI prepares a change, it waits here for your approval.", ChipKind.Grey));
            foreach (var q in pending.Take(20))
            {
                // What approving lets AI do (owner 26 Oct): types, levels, counts, the elements a delete removes, the code.
                if (q.Details.Count > 0) waiting.Add(new NoteSetting(string.Join(Environment.NewLine, q.Details), q.Details.Any(d => d.Contains("DELETE") || d.Contains("ON THEIR TYPE") || d.StartsWith("Runs Revit API code")) ? ChipKind.Warn : ChipKind.Info));
                waiting.Add(new ButtonsSetting(q.Summary + " · " + q.Model, new[]
                {
                    new SettingButton("Approve", new AsyncCommand(() => Decide(q, true), _status), primary: true),
                    new SettingButton("Reject", new AsyncCommand(() => Decide(q, false), _status)),
                }, hint: q.Id + " · " + q.Elements + " elements" + (q.EstimateS > 0 ? " · about " + q.EstimateS + " s" : "") + " · approving runs it now"));
            }
            waiting.Add(_messages);
            groups.Add(new SettingsGroup("Waiting for your approval", waiting.ToArray()));
            groups.Add(new SettingsGroup("Show the AI a problem", new SettingItem[]
            {
                new NoteSetting("Select the elements in Revit, say what's wrong, and send: the AI gets a picture of this view with them in red, their ids and your note.", ChipKind.Grey),
                _note,
                new ButtonsSetting("", new[] { new SettingButton("Send to AI", new AsyncCommand(SendAsync, _status), primary: true) }),
                _sendMessages,
            }));

            var done = _queue.Where(q => q.Status != "pending").Take(20).ToList();
            if (done.Count > 0)
                groups.Add(new SettingsGroup("Recent",
                    new TableSetting("", new[] { "Batch", "What", "Status", "Result" },
                        done.Select(q => new TableRow(q, q.Id, q.Summary, q.Status, q.Result.Length > 0 ? q.Result + (q.Detail.Length > 0 ? ": " + (q.Detail.Length > 160 ? q.Detail.Substring(0, 160) + "…" : q.Detail) : "") : "")))));
            groups.Add(new SettingsGroup("",
                new ButtonsSetting("", new[] { new SettingButton("Refresh", new AsyncCommand(RefreshAsync, _status)) })));
            Groups = groups;
        }

        private async Task SendAsync()
        {
            ToolResult r = await _ai.SendToAiAsync(_note.Value);
            _sendMessages.Show(r.Messages);
            _status(r.Messages.FirstOrDefault()?.Text ?? "");
            if (r.Ok) _note.Value = "";
        }

        private async Task Decide(AiQueueLine q, bool approve)
        {
            if (approve) { _running = q.Summary + (q.EstimateS > 0 ? " (about " + q.EstimateS + " s)" : ""); Rebuild(); }
            ToolResult r = await _ai.DecideAsync(q.Id, approve);
            _running = "";
            _messages.Show(r.Messages);
            _status(r.Messages.FirstOrDefault()?.Text ?? "");
            await RefreshAsync();
        }
    }
}
