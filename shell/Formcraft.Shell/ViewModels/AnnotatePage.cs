using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>
    /// Drawings › Annotate (board manage/PaneAnnotate, U19): the kit's annotation standard, the model checked against it,
    /// and the missing-tags report, all read-only. Click a line, then Zoom to select what it found. The neat-tags
    /// choices are kept for Formcraft Flow's Tag Tidy and Tag Assist, which act on them (U22, Phase 2).
    /// </summary>
    public sealed class AnnotatePage : SectionPage
    {
        public static readonly string[] Tabs = { "Lines", "Text", "Dimensions", "Tags", "Symbols", "Colours" };
        public static readonly string[] Scopes = { "Current view", "Views on the current sheet" };
        public static readonly string[] TidyActions = { "Align in a row", "Align in a column", "Distribute evenly", "Leaders never cross", "Straight or one elbow",
            "Clear of geometry and dimension text", "Same offset from the element", "Leader only when away from the element", "Keep text horizontal",
            "Pull in from crop edges", "Remove duplicate tags", "Room tags at room centre" };
        public static readonly string[] Speed = { "Tag one, tag all of that type in the view", "Copy a neat layout to typical floors", "Match tag type to view scale", "Re-tidy after model changes" };

        private readonly IAnnotateTools _tools;
        private readonly IQaTools _select;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private AnnotationStandardInfo? _standard;
        private List<AnnotationCheckLine>? _checks;
        private (List<string> Views, List<MissingTagLine> Lines)? _missing;
        private IReadOnlyList<long> _zoom = new long[0];

        public AnnotatePage(IAnnotateTools tools, IQaTools select, IUserSettings settings, Action<string> status, Action<DialogViewModel> ask)
            : base("Drawings › Annotate", "One annotation standard, read everywhere: the template builder, the audit, this pane and Tag Tidy.")
        {
            _tools = tools;
            _select = select;
            _store = new SettingStore(settings);
            _status = status;
            _ask = ask;
            CheckCommand = new AsyncCommand(Check, status);
            MissingCommand = new AsyncCommand(Missing, status);
            ZoomCommand = new AsyncCommand(Zoom, status);
            ProposeCommand = new RelayCommand(AskPropose);
            Rebuild();
        }

        public ICommand CheckCommand { get; }
        public ICommand MissingCommand { get; }
        public ICommand ZoomCommand { get; }
        public ICommand ProposeCommand { get; }
        public MessagesSetting Messages => _messages;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("Check", CheckCommand, primary: true),
            new FooterAction("Missing tags", MissingCommand),
            new FooterAction("Zoom", ZoomCommand),
        };

        public override void Opened() { if (_standard == null) _ = Load(); }

        public async Task Load()
        {
            _standard = await _tools.StandardAsync();
            Rebuild();
        }

        public void Rebuild()
        {
            Groups.Clear();
            Groups.Add(StandardGroup());
            Groups.Add(CheckGroup());
            Groups.Add(MissingGroup());
            Groups.Add(new SettingsGroup("Neat tags · Formcraft Flow (Tag Tidy and Tag Assist)",
                new MultiSetting(_store, "annotate.tidy", "Tidy actions", TidyActions, TidyActions.Take(9)),
                new MultiSetting(_store, "annotate.speed", "Speed", Speed, Speed.Take(3)),
                new ChoiceSetting(_store, "annotate.moves", "Moves", new[] { "Only tags the plugin placed", "Also tags I select now" },
                    hint: "Tags a person placed are never moved unless that person selects them for tidying now. Every move is previewed and can be undone in one step."),
                new NoteSetting("These choices drive Tag Tidy, which arrives with Formcraft Flow's on-view tools (U22).")));
            Groups.Add(new SettingsGroup("Placing tags · Phase 2 via Tag Assist",
                new NoteSetting("Only missing tags are added, one view first, then the set; placed tags are marked FMC_AutoPlaced. Live shared models: Leads and Admins, own " +
                                "discipline, after a preview. Moving existing tags in bulk: test copy only.")));
            Groups.Add(new SettingsGroup("Dimensions",
                new NoteSetting("Dimension styles come from the standard once approved. Automatic dimension strings are deferred.")));
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "annotate.considerations", _status)));
        }

        private SettingsGroup StandardGroup()
        {
            if (_standard == null) return new SettingsGroup("Annotation standard", new NoteSetting("Reading the kit's annotation standard…"));
            if (!_standard.Ok) return new SettingsGroup("Annotation standard", new NoteSetting(_standard.Message, ChipKind.Warn));
            var s = _standard;
            var tab = _store.Get("annotate.tab") ?? Tabs[0];
            var items = new List<SettingItem>
            {
                new ReadOnlySetting("File", $"{s.File} · v{s.Version}" + (s.Source.Length > 0 ? " · from " + s.Source : ""), mono: true),
                new ChoiceSetting(_store, "annotate.tab", "Show", Tabs, changed: _ => Rebuild()),
            };
            switch (tab)
            {
                case "Lines":
                    items.Add(new TableSetting("", new[] { "Pen", "Width", "Used for" }, s.Pens.Select(p => new TableRow(p, "Pen " + p.Pen + (p.Status == "proposed" ? " (proposed)" : ""), p.Width.ToString("0.00") + " mm", p.UsedFor))));
                    items.Add(new ReadOnlySetting("Line patterns", s.LinePatterns.Count > 0 ? string.Join(" · ", s.LinePatterns) : "None in the standard"));
                    break;
                case "Text":
                    items.Add(s.TextTypes.Count == 0 ? (SettingItem)new NoteSetting("The standard names no text types.")
                        : new TableSetting("", new[] { "Text type", "Font", "Size" }, s.TextTypes.Select(t => new TableRow(t, t.Name, t.Font, t.Size))));
                    break;
                case "Dimensions":
                    items.Add(s.DimensionStyles.Count == 0 ? (SettingItem)new NoteSetting("Dimension styles aren't in the standard yet.", ChipKind.Warn)
                        : new TableSetting("", new[] { "Dimension style", "Status" }, s.DimensionStyles.Select(d => new TableRow(d, d.Name, d.Status))));
                    break;
                case "Tags":
                    items.Add(new ReadOnlySetting("Tag families", s.TagPattern, mono: true));
                    break;
                case "Symbols":
                    items.Add(new ReadOnlySetting("Symbols", s.Symbols.Count > 0 ? string.Join(" · ", s.Symbols) : "None in the standard"));
                    break;
                default:
                    items.Add(s.Colours.Count == 0 ? (SettingItem)new NoteSetting("No colours in the standard.")
                        : new TableSetting("", new[] { "Colour", "Value" }, s.Colours.Select(c => new TableRow(c, c.Name, c.Hex))));
                    break;
            }
            if (s.DimensionStyles.Any(d => d.Status == "proposed") || s.Pens.Any(p => p.Status == "proposed"))
                items.Add(new NoteSetting("Proposed values wait for the BIM Manager's approval; they're shown, never enforced.", ChipKind.Warn));
            items.Add(new ButtonsSetting("", new[]
            {
                new SettingButton("Open the full standard", new RelayCommand(() => Open(s.File))),
                new SettingButton("Propose a change", ProposeCommand),
            }, "Print as A3 sheet comes with the template builder."));
            return new SettingsGroup("Annotation standard · FMC_Annotation_Standard", items.ToArray());
        }

        private SettingsGroup CheckGroup()
        {
            var items = new List<SettingItem>();
            if (_checks != null)
            {
                var table = new TableSetting("", new[] { "Check", "Found", "State" }, _checks.Select(c => new TableRow(c, c.Check, c.Found.ToString(), c.State)), selectable: true,
                    hint: "Report only: click a row, then Zoom. Swapping types to the standard will be a safe fix after a dry run.");
                table.PropertyChanged += (_, e) =>
                {
                    if (e.PropertyName == nameof(TableSetting.Selected) && table.Selected?.Tag is AnnotationCheckLine c)
                    {
                        _zoom = c.Ids;
                        _status(c.Check + ": " + string.Join(", ", c.Items.Take(8)) + (c.Found > 8 ? "…" : ""));
                    }
                };
                items.Add(table);
            }
            items.Add(new ButtonsSetting("", new[] { new SettingButton(_checks == null ? "Check against the standard" : "Check again", CheckCommand, primary: true),
                                                     new SettingButton("Zoom", ZoomCommand) }));
            items.Add(_messages);
            return new SettingsGroup("Check against the standard", items.ToArray());
        }

        private SettingsGroup MissingGroup()
        {
            var items = new List<SettingItem>
            {
                new ChoiceSetting(_store, "annotate.scope", "Where", Scopes),
                new ButtonsSetting("", new[] { new SettingButton("Report missing tags", MissingCommand) }),
            };
            if (_missing != null)
            {
                var table = new TableSetting("", new[] { "Category", "Untagged", "Tag family" },
                    _missing.Value.Lines.Select(l => new TableRow(l, l.Category, l.Untagged.ToString(), l.TagFamily)), selectable: true,
                    hint: "In " + string.Join(", ", _missing.Value.Views.Take(4)) + (_missing.Value.Views.Count > 4 ? "…" : "") + ". Click a row, then Zoom.");
                table.PropertyChanged += (_, e) =>
                {
                    if (e.PropertyName == nameof(TableSetting.Selected) && table.Selected?.Tag is MissingTagLine l) _zoom = l.Ids;
                };
                items.Add(table);
            }
            return new SettingsGroup("Missing tags · report", items.ToArray());
        }

        private async Task Check()
        {
            var (ok, message, checks) = await _tools.CheckAsync();
            _checks = ok ? checks : null;
            _messages.Show(ok ? ChipKind.Info : ChipKind.Bad, message);
            _status(message);
            Rebuild();
        }

        private async Task Missing()
        {
            var scope = (_store.Get("annotate.scope") ?? Scopes[0]) == Scopes[1] ? "sheet_views" : "current_view";
            var (ok, message, views, lines) = await _tools.MissingTagsAsync(scope);
            _missing = ok ? (views, lines) : ((List<string>, List<MissingTagLine>)?)null;
            _messages.Show(ok ? ChipKind.Info : ChipKind.Bad, message);
            _status(message);
            Rebuild();
        }

        /// <summary>Selects what the clicked line found.</summary>
        public void ZoomTo(IReadOnlyList<long> ids) => _zoom = ids;

        private async Task Zoom()
        {
            if (_zoom.Count == 0) { _messages.Show(ChipKind.Warn, "Click a line with something to select first."); return; }
            _status(await _select.SelectAsync(_zoom));
        }

        private void AskPropose()
        {
            var form = new InMemoryUserSettings();
            var text = new TextSetting("Proposed change and why", "", store: new SettingStore(form, ""), key: "text");
            _ask(DialogViewModel.WithItems("Propose a change to the standard", "The BIM Manager approves changes into the standard.", new SettingItem[] { text }, "Send", async () =>
            {
                if ((form.Get("text") ?? "").Trim().Length == 0) return "Describe the change.";
                var m = await _tools.RequestAsync(form.Get("text")!.Trim());
                _messages.Show(ChipKind.Good, m);
                _status(m);
                return null;
            }));
        }

        private void Open(string path)
        {
            try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(path) { UseShellExecute = true }); }
            catch (Exception e) { _status("Couldn't open the standard: " + e.Message); }
        }
    }
}
