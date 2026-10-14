using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>
    /// Ask Claude in the pane (board core/PaneAsk, U27; the old Browser's "ask …" command carried over). Claude answers
    /// questions about the open model with read-only Revit tools and the firm's own API key; it can't change anything
    /// here. Every answer says what it read and what it cost. The log keeps tools and tokens, never the text.
    /// </summary>
    public sealed class AskPage : SectionPage
    {
        private const int Remember = 6;
        private readonly IAskTools _tools;
        private readonly Action<string> _status;
        private readonly List<(string Role, string Text, string Meta)> _turns = new List<(string, string, string)>();
        private readonly TextSetting _input = new TextSetting("Your question", "", "e.g. which views aren't on a sheet? (or type ask … in search)");
        private readonly MessagesSetting _messages = new MessagesSetting();
        private AskStatus? _state;
        private bool _busy;

        public AskPage(IAskTools tools, Action<string> status)
            : base("Ask Claude · test build", "Questions about the open model, answered with read-only tools. Nothing is changed.")
        {
            _tools = tools;
            _status = status;
            SendCommand = new AsyncCommand(() => Ask(_input.Value), status);
            ResetCommand = new RelayCommand(Reset);
            Rebuild();
        }

        public ICommand SendCommand { get; }
        public ICommand ResetCommand { get; }
        public TextSetting Input => _input;
        public IReadOnlyList<(string Role, string Text, string Meta)> Turns => _turns;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("ask reset", ResetCommand),
            new FooterAction("Send", SendCommand, primary: true),
        };

        public override void Opened() => _ = LoadStatus();

        /// <summary>"ask …" or "? …" typed in the pane's search box (the old command box's syntax). True when it was one.</summary>
        public static string? QuestionIn(string text)
        {
            var t = text.TrimStart();
            if (t.StartsWith("?")) return t.Substring(1).Trim();
            if (t.Length > 4 && t.StartsWith("ask ", StringComparison.OrdinalIgnoreCase)) return t.Substring(4).Trim();
            return null;
        }

        public void Rebuild()
        {
            Groups.Clear();
            var talk = new List<SettingItem>();
            if (_turns.Count == 0) talk.Add(new NoteSetting("Ask about the open model, e.g. \"how many sheets and views are in this model?\"", ChipKind.Grey));
            foreach (var t in _turns) talk.Add(new ReadOnlySetting(t.Role, t.Text, t.Meta));
            if (_busy) talk.Add(new NoteSetting("Claude is reading the model…", ChipKind.Info));
            talk.Add(_input);
            talk.Add(new ButtonsSetting("", new[] { new SettingButton("Send", SendCommand, primary: true), new SettingButton("ask reset", ResetCommand) }));
            talk.Add(_messages);
            talk.Add(new NoteSetting("Claude can read the open model but not change it. Changes go through the sections' buttons and their dry run.", ChipKind.Info));
            Groups.Add(new SettingsGroup("Conversation", talk.ToArray()));

            var read = new List<SettingItem>();
            if (_state != null && _state.Ok)
                read.Add(new TableSetting("", new[] { "Claude can read", "Access" },
                    _state.Tools.Select(x => new TableRow(x, x.Description, "Read")).Concat(new[] { new TableRow(null, "Change, create or delete anything", "Not in this build") })));
            else read.Add(new NoteSetting("Open documents, the active view, the selection, elements in the view, model statistics and material quantities. Nothing that changes the model.", ChipKind.Grey));
            Groups.Add(new SettingsGroup("What Claude can read", read.ToArray()));

            if (_state != null && _state.Ok)
            {
                Groups.Add(new SettingsGroup("Key and budget (admin)",
                    new ReadOnlySetting("API key", _state.KeySaved ? "Saved on this PC · " + _state.KeyFile + " · never logged"
                        : "Not saved: create one in the Claude Console and save it as the first line of " + _state.KeyFile),
                    new ReadOnlySetting("Model", _state.Model, "FMC_ASK_MODEL on this PC changes it"),
                    new ReadOnlySetting("Used today", $"{N(_state.UsedToday)} of {N(_state.DailyTokens)} tokens · {_state.QuestionsToday} questions", "FMC_ASK_DAILY_TOKENS on this PC changes the budget"),
                    new NoteSetting("Billed per token on the key's Claude Console account (Max and Team plans include monthly API credits once linked). Not the Claude app plan or its usage credits.", ChipKind.Warn)));
                Groups.Add(new SettingsGroup("Log",
                    _state.Log.Count == 0 ? (SettingItem)new NoteSetting("No questions yet.")
                        : new TableSetting("FMC_Ask_Log.csv · tools and tokens only, never the text", new[] { "Time", "Read", "Tokens", "Result" },
                            _state.Log.Select(l => new TableRow(l, Time(l.Time), l.Tools, N(l.Tokens), l.Result)))));
            }
            else if (_state != null)
                Groups.Add(new SettingsGroup("Key and budget (admin)", new NoteSetting(_state.Message, ChipKind.Warn)));
        }

        private static string N(int v) => v.ToString("N0", CultureInfo.InvariantCulture);
        private static string Time(string iso) => DateTime.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal, out var d) ? d.ToLocalTime().ToString("d MMM HH:mm") : iso;

        private async Task LoadStatus()
        {
            _state = await _tools.StatusAsync();
            Rebuild();
        }

        public async Task Ask(string question)
        {
            question = (question ?? "").Trim();
            if (question.Length == 0) { _status("Type a question first."); return; }
            if (_busy) return;
            var prior = _turns.Where(t => t.Role != "Formcraft").ToList();
            var history = prior.Skip(Math.Max(0, prior.Count - Remember)).Select(t => (t.Role == "You" ? "user" : "assistant", t.Text)).ToList();
            _turns.Add(("You", question, ""));
            _input.Value = "";
            _busy = true;
            Rebuild();
            AskAnswer a;
            try { a = await _tools.AskAsync(question, history); }
            finally { _busy = false; }
            if (a.Ok)
            {
                _turns.Add(("Claude", a.Text, $"Read: {(a.ToolsUsed.Count > 0 ? string.Join(", ", a.ToolsUsed.Distinct()) : "nothing")} · {N(a.Tokens)} tokens · {a.Model}"));
                _status($"Claude answered · {N(a.BudgetLeft)} tokens left today.");
            }
            else
            {
                _turns.Add(("Formcraft", a.Text, ""));
                _status(a.Text);
            }
            await LoadStatus();
        }

        private void Reset()
        {
            _turns.Clear();
            _messages.Show(ChipKind.Info, "Follow-up memory cleared.");
            _status("Ask: follow-up memory cleared.");
            Rebuild();
        }
    }
}
