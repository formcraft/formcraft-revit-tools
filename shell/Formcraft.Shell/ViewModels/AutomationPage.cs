using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>One bar: a label, its share as a bar (0–100), the numbers beside it, and a tone that picks the colour.</summary>
    public sealed class ShareBar
    {
        public ShareBar(string label, double share, string value, string tone)
        {
            Label = label;
            Share = Math.Max(0, Math.Min(100, share));
            Value = value;
            Tone = tone;
        }

        public string Label { get; }
        public double Share { get; }
        public string Value { get; }
        /// <summary>ai, tool, addon, external or neutral.</summary>
        public string Tone { get; }
        /// <summary>The bar's filled and empty parts as star widths, so the bar needs no converter.</summary>
        public GridLength Fill => new GridLength(Share, GridUnitType.Star);
        public GridLength Rest => new GridLength(100 - Share, GridUnitType.Star);
    }

    /// <summary>Horizontal share bars (Check › Automation): the kinds, who started them, the weeks.</summary>
    public sealed class ShareBarsSetting : SettingItem
    {
        public ShareBarsSetting(IReadOnlyList<ShareBar> bars, string hint = "") : base("", hint) => Bars = bars;
        public IReadOnlyList<ShareBar> Bars { get; }
    }

    /// <summary>
    /// Check › Automation (F74, docs/AUTOMATION_BALANCE.md; board manage/PaneAutomation is a placeholder still to draw).
    /// The balance between AI-written code (send_code_to_revit) and saved automation (plugin tools, add-ons, pyRevit,
    /// Dynamo, Python, Grasshopper, JS…), from the server's local call ledger; and the move list: the AI code to turn into
    /// tools next, with each group's suggested home and its status. Counts calls and runs, never people (rule 9).
    /// </summary>
    public sealed class AutomationPage : SectionPage
    {
        public static readonly string[] Periods = { "Last 4 weeks", "Last 8 weeks", "Last 12 weeks" };
        public static readonly string[] Scopes = { "This project", "Every project" };

        private readonly IBalanceTools _tools;
        private readonly ProjectPage _project;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private BalanceSummary? _summary;
        private List<BacklogItem> _backlog = new List<BacklogItem>();
        private string _backlogMessage = "";
        private BacklogItem? _selected;

        public AutomationPage(IBalanceTools tools, ProjectPage project, IUserSettings settings, Action<string> status, Action<DialogViewModel> ask)
            : base("Check › Automation", "How much work runs as AI-written code, and what to move into saved tools next. Calls, never people.")
        {
            _tools = tools;
            _project = project;
            _store = new SettingStore(settings);
            _status = status;
            _ask = ask;
            RefreshCommand = new AsyncCommand(Refresh, status);
            ExportCommand = new AsyncCommand(AskExport, status);
            Rebuild();
        }

        public ICommand RefreshCommand { get; }
        public ICommand ExportCommand { get; }
        public MessagesSetting Messages => _messages;
        public BalanceSummary? Summary => _summary;
        public IReadOnlyList<BacklogItem> Backlog => _backlog;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("Export for Power BI", ExportCommand, primary: true),
            new FooterAction("Refresh", RefreshCommand),
        };

        public override void Opened() { if (_summary == null) _ = Refresh(); else Rebuild(); }

        public int Weeks => (_store.Get("automation.period") ?? Periods[0]) switch { "Last 8 weeks" => 8, "Last 12 weeks" => 12, _ => 4 };

        /// <summary>The project code the numbers are for, or "" for every project.</summary>
        public string Scope => (_store.Get("automation.scope") ?? Scopes[0]) == Scopes[1] ? "" : _project.Request().Code.Trim();

        private static string N(double v) => v.ToString("0.#", CultureInfo.InvariantCulture);

        private static string Time(long ms) => ms >= 60000 ? N(ms / 60000.0) + " min" : N(ms / 1000.0) + " s";

        private static string Day(string iso) =>
            DateTime.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var d)
                ? d.ToString("d MMM", CultureInfo.InvariantCulture) : iso;

        private static string Tone(string kind) => kind switch
        {
            "ai_code" => "ai", "plugin_tool" => "tool", "saved_addon" => "addon", "external" => "external", _ => "neutral",
        };

        private static string StartedBy(string key) => key switch
        {
            "ai" => "An AI (MCP client)", "pane" => "The pane", "job" => "A job or flow", "schedule" => "A schedule", "cli" => "Command line",
            "person" => "Run by hand", _ => key,
        };

        public void Rebuild()
        {
            Groups.Clear();
            var choose = new SettingItem[]
            {
                new ChoiceSetting(_store, "automation.period", "Period", Periods, changed: v => { _ = Refresh(); }),
                new ChoiceSetting(_store, "automation.scope", "Calls of", Scopes, changed: v => { _ = Refresh(); },
                    hint: _project.Request().Code.Length == 0 ? "No project set in Setup › Project: every project's calls are shown." : ""),
            };
            var s = _summary;
            if (s == null)
            {
                Groups.Add(new SettingsGroup("Balance", choose.Append(new NoteSetting("Reading the call ledger…", ChipKind.Grey)).ToArray()));
            }
            else if (!s.Ok)
            {
                Groups.Add(new SettingsGroup("Balance", choose.Append(new NoteSetting(s.Message, ChipKind.Warn)).ToArray()));
            }
            else
            {
                var items = new List<SettingItem>(choose);
                if (s.Total == 0) items.Add(new NoteSetting("No calls recorded in the period. Every call to the Formcraft server is recorded from now on.", ChipKind.Grey));
                else
                {
                    items.Add(new NoteSetting($"AI code: {N(s.AiShare)}% of {s.Total} calls ({Day(s.From)} to {Day(s.To)}). The goal is this share falling as saved tools take over.",
                        s.AiShare > 50 ? ChipKind.Warn : ChipKind.Info));
                    items.Add(new ShareBarsSetting(s.ByKind.Select(k => new ShareBar(k.Label, k.Share, $"{N(k.Share)}% · {k.Calls}", Tone(k.Key))).ToList(),
                        "AI code is send_code_to_revit; plugin tools are Formcraft's own; add-ons are saved scripts run by fmc_scripts; external is pyRevit, Dynamo, Python, Grasshopper, JS…"));
                }
                Groups.Add(new SettingsGroup("Balance by kind", items.ToArray()));

                if (s.PluginByStartedBy.Count > 0)
                    Groups.Add(new SettingsGroup("Who started the plugin tools",
                        new ShareBarsSetting(s.PluginByStartedBy.Select(k => new ShareBar(StartedBy(k.Key), k.Share, $"{N(k.Share)}% · {k.Calls}", k.Key == "ai" ? "ai" : "tool")).ToList(),
                            "Tools a pane button, a job or a schedule starts cost no AI credits."),
                        new NoteSetting("Counts calls by what started them, never by person (rule 9).", ChipKind.Grey)));

                if (s.Weeks.Count > 0)
                    Groups.Add(new SettingsGroup("Trend by week · AI code's share",
                        new ShareBarsSetting(s.Weeks.Select(w => new ShareBar("w/c " + Day(w.Week), w.AiShare, w.Total == 0 ? "no calls" : $"{N(w.AiShare)}% · {w.Total} calls", "ai")).ToList())));

                Groups.Add(new SettingsGroup("Outside scripts",
                    s.ExternalByKind.Count == 0
                        ? (SettingItem)new NoteSetting("No runs recorded from pyRevit, Dynamo, Python, Grasshopper, JS, PowerShell or batch yet.", ChipKind.Grey)
                        : new ShareBarsSetting(s.ExternalByKind.Select(k => new ShareBar(k.Label, k.Share, $"{N(k.Share)}% · {k.Calls}", "external")).ToList()),
                    new NoteSetting("A script counts once it records its runs: paste the one-line hook from resources\\hooks (docs/AUTOMATION_BALANCE.md). " +
                                    "It writes kind, script, ok and time to the same ledger on this PC; nothing is sent anywhere.", ChipKind.Info)));
            }

            var move = new List<SettingItem>();
            if (_backlog.Count == 0)
                move.Add(new NoteSetting(_backlogMessage.Length > 0 ? _backlogMessage : "No AI code in the period.", ChipKind.Grey));
            else
            {
                var table = new TableSetting("", new[] { "#", "Purpose", "Calls", "Time", "Suggested home", "Status" },
                    _backlog.Select(b => new TableRow(b, b.Rank.ToString(CultureInfo.InvariantCulture), b.Purpose, b.Calls.ToString(CultureInfo.InvariantCulture),
                        Time(b.Ms), b.Home, b.Status.Length > 0 ? b.Status : "-")), selectable: true,
                    hint: "Ranked by calls, then time: the top is what to move first. Click one for its detail.");
                if (_selected != null) table.Selected = table.Rows.FirstOrDefault(r => r.Tag == _selected);
                table.PropertyChanged += (_, e) =>
                {
                    if (e.PropertyName != nameof(TableSetting.Selected) || !(table.Selected?.Tag is BacklogItem b) || b == _selected) return;
                    _selected = b;
                    Rebuild();
                };
                move.Add(table);
                if (_backlog.Any(b => b.Purpose.StartsWith("(no purpose)", StringComparison.Ordinal)))
                    move.Add(new NoteSetting("Some AI code came without a purpose: send_code_to_revit takes a short `purpose`, so its calls group and find a home.", ChipKind.Warn));
            }
            Groups.Add(new SettingsGroup("Move list · AI code to turn into tools", move.ToArray()));

            if (_selected != null)
            {
                var b = _selected;
                var items = new List<SettingItem>
                {
                    new ReadOnlySetting("Purpose", b.Purpose),
                    new ReadOnlySetting("Calls", b.Calls + (b.Errors > 0 ? $" ({b.Errors} failed)" : "") + " · " + Time(b.Ms) + " in all"),
                    new ReadOnlySetting("Suggested home", b.Home),
                    new ReadOnlySetting("Status", b.Status.Length == 0 ? "No home yet" : b.Status + (b.TrackerStatus.Length > 0 ? $" (tracker {b.Feature}: {b.TrackerStatus})" : " (from the mapping)")),
                };
                if (b.Priority.Length > 0) items.Add(new ReadOnlySetting("Priority", b.Priority));
                if (b.Scripts.Length > 0) items.Add(new ReadOnlySetting("KISIC scripts that did this", b.Scripts, mono: true));
                if (b.Projects.Count > 0) items.Add(new ReadOnlySetting("Projects", string.Join(", ", b.Projects)));
                if (b.Last.Length > 0) items.Add(new ReadOnlySetting("Last sent", Day(b.Last)));
                Groups.Add(new SettingsGroup("Selected · " + b.Purpose, items.ToArray()));
            }

            Groups.Add(new SettingsGroup("Power BI",
                new NoteSetting("Export writes two tidy tables for Power BI: calls by week, project, kind and who started them, and the move list " +
                                "(01_WIP\\_Exchange\\Balance). A dry run shows what it writes first.", ChipKind.Grey),
                new ButtonsSetting("", new[] { new SettingButton("Refresh", RefreshCommand), new SettingButton("Export for Power BI", ExportCommand, primary: true) }),
                _messages));
        }

        private async Task Refresh()
        {
            var weeks = Weeks;
            var scope = Scope;
            _summary = await _tools.SummaryAsync(weeks, scope);
            var r = await _tools.BacklogAsync(weeks, scope);
            _backlog = r.Ok ? r.Items : new List<BacklogItem>();
            _backlogMessage = r.Message;
            _selected = _backlog.FirstOrDefault(b => b.Purpose == _selected?.Purpose);
            Rebuild();
            _status(_summary.Ok ? $"Automation balance: {_summary.Total} calls, AI code {N(_summary.AiShare)}%." : _summary.Message);
        }

        private async Task AskExport()
        {
            var folder = _project.Request().Folder;
            if (folder.Length == 0)
            {
                _messages.Show(ChipKind.Warn, "Set the project folder in Setup › Project: the export goes into its 01_WIP\\_Exchange\\Balance.");
                _status("Set the project folder in Setup › Project first.");
                return;
            }
            var weeks = Weeks;
            var dry = await _tools.ExportAsync(folder, weeks, true);
            if (!dry.Ok)
            {
                _messages.Show(dry.Messages);
                _status("Export refused.");
                return;
            }
            _ask(DialogViewModel.WithItems("Export for Power BI", "Writes these files; an older export moves to _Archive. Nothing in the model changes.",
                new SettingItem[] { new ReadOnlySetting("Files", string.Join(Environment.NewLine, dry.Details), mono: true) },
                "Export", async () =>
                {
                    var r = await _tools.ExportAsync(folder, weeks, false);
                    _messages.Show(r.Messages);
                    _status(r.Ok ? "Exported for Power BI." : "Export failed.");
                    return null;
                }));
        }
    }
}
