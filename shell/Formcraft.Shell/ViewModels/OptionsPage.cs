using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>One measure on an option card; Differs when it isn't the same for every option (the server's differs).</summary>
    public sealed class OptionMeasureRow
    {
        public OptionMeasureRow(string label, string value, bool differs) { Label = label; Value = value; Differs = differs; }
        public string Label { get; }
        public string Value { get; }
        public bool Differs { get; }
    }

    /// <summary>One option as a card: its numbers, what fails, and Make active, Choose this one and the plan sketch.</summary>
    public sealed class OptionCard
    {
        public OptionCard(OptionMeasures m, bool active, IReadOnlyList<string> differs, IReadOnlyList<OptionMeasures> all,
                          ICommand makeActive, ICommand choose, ICommand openPlan)
        {
            Measures = m;
            IsActive = active;
            bool D(params string[] keys) => keys.Any(differs.Contains);
            Rows = new[]
            {
                new OptionMeasureRow("Rooms", m.Rooms.ToString(CultureInfo.InvariantCulture), D("rooms")),
                new OptionMeasureRow("Area", N(m.AreaM2) + " m² · brief " + (m.TargetM2 > 0 ? N(m.TargetM2) + " m²" : "not set"), D("area_m2")),
                new OptionMeasureRow("Walls", N(m.WallsM2) + " m²", D("walls_m2")),
                new OptionMeasureRow("Ceilings", N(m.CeilingsM2) + " m²", D("ceilings_m2")),
                new OptionMeasureRow("Doors", m.Doors.ToString(CultureInfo.InvariantCulture), D("doors")),
                new OptionMeasureRow("Windows", m.Windows.ToString(CultureInfo.InvariantCulture), D("windows")),
                new OptionMeasureRow("Daylight proxy", m.DaylightPct is double pct ? N(pct) + "% glazing to floor" : "n/a: " + m.DaylightNote, D("glazing_m2", "daylight_pct")),
            };
            // a family type is marked when its count isn't the same in every option (missing counts as 0)
            Families = m.Families.Select(f => new OptionMeasureRow(f.Key, f.Value.ToString(CultureInfo.InvariantCulture),
                D("families") && all.Any(o => (o.Families.TryGetValue(f.Key, out var n) ? n : 0) != f.Value))).ToList();
            Fails = m.OffTarget.Select(o => "Off the brief: " + o).Concat(m.Problems).ToList();
            MakeActiveCommand = makeActive;
            ChooseCommand = choose;
            OpenPlanCommand = openPlan;
        }

        private static string N(double v) => v.ToString("0.##", CultureInfo.InvariantCulture);

        public OptionMeasures Measures { get; }
        public string Variant => Measures.Variant;
        public string Name => Measures.Name;
        /// <summary>"base" is the node as it is; the others are its variants.</summary>
        public string Subtitle => Variant == "base" ? "The node as it is" : "Variant " + Variant;
        public bool IsActive { get; }
        public bool CanMakeActive => !IsActive;
        /// <summary>The node as it is has nothing to choose: it is the node already.</summary>
        public bool CanChoose => Variant != "base";
        public IReadOnlyList<OptionMeasureRow> Rows { get; }
        public IReadOnlyList<OptionMeasureRow> Families { get; }
        public bool HasFamilies => Families.Count > 0;
        public IReadOnlyList<string> Fails { get; }
        public bool HasFails => Fails.Count > 0;
        public bool Passes => !HasFails;
        public ICommand MakeActiveCommand { get; }
        public ICommand ChooseCommand { get; }
        public ICommand OpenPlanCommand { get; }
    }

    /// <summary>The option cards side by side, in the server's order (never sorted).</summary>
    public sealed class OptionCardsSetting : SettingItem
    {
        public OptionCardsSetting(IReadOnlyList<OptionCard> cards) : base("", "Highlighted: the measures that differ between the options.") => Cards = cards;
        public IReadOnlyList<OptionCard> Cards { get; }
    }

    /// <summary>
    /// Engineer › Options (docs/PLAN_OPTIONS.md, O2): a recipe-tree node's options side by side, measured from the recipes
    /// without Revit. Trade-offs, never a ranking: nothing is sorted by cost ("value, not cheapest"), and a person chooses.
    /// Make active changes the tree only (dry run first); building and Revit's "accept primary" stay people's steps.
    /// </summary>
    public sealed class OptionsPage : SectionPage
    {
        private readonly IOptionsTools _tools;
        private readonly ProjectPage _project;
        private readonly SettingStore _store;
        private readonly Func<string> _me;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private List<OptionNode>? _nodes;
        private string _nodesMessage = "";
        private OptionsComparison? _comparison;
        /// <summary>Where the last saved comparison went (the plan sketches are there).</summary>
        private string? _saved;

        public OptionsPage(IOptionsTools tools, ProjectPage project, IUserSettings settings, Func<string> me, Action<string> status, Action<DialogViewModel> ask)
            : base("Engineer › Options", "Two or three answers to one design question, measured from the recipes and shown side by side. A person chooses.")
        {
            _tools = tools;
            _project = project;
            _store = new SettingStore(settings);
            _me = me;
            _status = status;
            _ask = ask;
            RefreshCommand = new AsyncCommand(Refresh, status);
            SaveCommand = new AsyncCommand(Save, status);
            Rebuild();
        }

        public ICommand RefreshCommand { get; }
        public ICommand SaveCommand { get; }
        public MessagesSetting Messages => _messages;
        public OptionsComparison? Comparison => _comparison;
        public string? SavedFolder => _saved;
        /// <summary>Opens a folder or file in its default app (recorded in tests).</summary>
        public Action<string> OpenPath { get; set; } = OpenInShell;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("Save the comparison", SaveCommand, primary: true),
            new FooterAction("Refresh", RefreshCommand),
        };

        public override void Opened() { if (_nodes == null) _ = Refresh(); else Rebuild(); }

        private string Folder => _project.Request().Folder;

        /// <summary>The node picked in the list (the first when none is).</summary>
        public OptionNode? Node
        {
            get
            {
                if (_nodes == null || _nodes.Count == 0) return null;
                var shown = _store.Get("options.node");
                return _nodes.FirstOrDefault(n => n.Shown == shown) ?? _nodes[0];
            }
        }

        public IReadOnlyList<OptionCard> Cards =>
            Groups.SelectMany(g => g.Items).OfType<OptionCardsSetting>().FirstOrDefault()?.Cards ?? new OptionCard[0];

        public void Rebuild()
        {
            Groups.Clear();
            if (Folder.Length == 0)
            {
                Groups.Add(new SettingsGroup("Options", new NoteSetting("Set the project folder in Setup › Project: the recipe tree lives in its 01_WIP\\_Tree.", ChipKind.Warn)));
                return;
            }
            var pick = new List<SettingItem>();
            if (_nodes == null) pick.Add(new NoteSetting("Reading the recipe tree…"));
            else if (_nodes.Count == 0)
                pick.Add(new NoteSetting(_nodesMessage.Length > 0 ? _nodesMessage : "No node has options yet. Ask Claude to add one (fmc_tree options op=add), e.g. the ICU bay at 4500 wide.", ChipKind.Info));
            else
                pick.Add(new ChoiceSetting(_store, "options.node", "Design question (a node with options)", _nodes.Select(n => n.Shown).ToList(), dropdown: true,
                    changed: _ => { _comparison = null; _saved = null; var compare = Compare(); }));
            pick.Add(new NoteSetting("Trade-offs, never a ranking: quantities only, no rates, and the daylight figure is a glazing proxy, not a simulation. A person chooses.", ChipKind.Info));
            Groups.Add(new SettingsGroup("Options", pick.ToArray()));
            if (Node == null) return;

            var side = new List<SettingItem>();
            if (_comparison == null) side.Add(new NoteSetting("Measuring the options…"));
            else if (!_comparison.Ok) side.Add(new NoteSetting(_comparison.Message, ChipKind.Warn));
            else
            {
                // the server's order: the node as it is first, then its variants as they were added
                var cards = _comparison.Options.Select(o =>
                {
                    var active = o.Variant == _comparison.Active;
                    return new OptionCard(o, active, _comparison.Differs, _comparison.Options,
                        new AsyncCommand(() => MakeActive(o), _status), new AsyncCommand(() => Choose(o), _status), new RelayCommand(() => OpenPlan(o)));
                }).ToList();
                side.Add(new OptionCardsSetting(cards));
                side.Add(new ReadOnlySetting("Differs in", _comparison.Differs.Count == 0 ? "Nothing: the options measure the same." : string.Join(", ", _comparison.Differs.Select(Shown))));
            }
            side.Add(new ButtonsSetting("", new[] { new SettingButton("Save the comparison", SaveCommand, primary: true), new SettingButton("Refresh", RefreshCommand) },
                _saved != null ? "Saved to " + _saved + "." : "Keeps a sheet, a CSV for Power BI and a plan sketch per option in " + Folder + "\\01_WIP\\_Options."));
            side.Add(_messages);
            Groups.Add(new SettingsGroup("Side by side", side.ToArray()));
            Groups.Add(new SettingsGroup("Who does what",
                new NoteSetting("Make active changes the recipe tree only: the dry run shows what would rebuild, and nothing is built until you build it (dry run first).", ChipKind.Info),
                new NoteSetting("Choose this one is recorded under your name. In Revit, accepting the primary design option deletes the others, so a person does that step.", ChipKind.Warn)));
        }

        /// <summary>The server's measure names in plain English.</summary>
        public static string Shown(string key)
        {
            switch (key)
            {
                case "rooms": return "rooms";
                case "area_m2": return "area";
                case "walls_m2": return "walls";
                case "ceilings_m2": return "ceilings";
                case "doors": return "doors";
                case "windows": return "windows";
                case "glazing_m2": return "glazing";
                case "daylight_pct": return "daylight proxy";
                case "families": return "families";
                default: return key;
            }
        }

        private async Task Refresh()
        {
            if (Folder.Length == 0) { Rebuild(); return; }
            var (ok, message, nodes) = await _tools.NodesAsync(Folder);
            _nodes = ok ? nodes : new List<OptionNode>();
            _nodesMessage = ok ? "" : message;
            _comparison = null;
            Rebuild();
            if (Node == null) { _status(ok ? "No node has options yet." : message); return; }
            await Compare();
        }

        private async Task Compare()
        {
            var node = Node;
            if (node == null) return;
            Rebuild();
            _comparison = await _tools.CompareAsync(Folder, node.Id);
            Rebuild();
            _status(_comparison.Ok ? _comparison.Options.Count + " options of " + node.Id + " side by side." : _comparison.Message);
        }

        private static string Rebuilds(ToolResult dry) =>
            dry.Details.Count == 0 ? "Nothing: the tree builds the same." : string.Join(Environment.NewLine, dry.Details);

        private async Task MakeActive(OptionMeasures o)
        {
            var node = Node;
            if (node == null || _comparison == null) return;
            if (o.Variant == _comparison.Active) { _status(o.Name + " is the active option already."); return; }
            var variant = o.Variant == "base" ? "" : o.Variant;
            var dry = await _tools.ActivateAsync(Folder, node.Id, variant, dryRun: true);
            if (!dry.Ok) { _messages.Show(dry.Messages); _status(dry.Messages.FirstOrDefault()?.Text ?? "Refused."); return; }
            _ask(DialogViewModel.WithItems("Make " + o.Name + " active · dry run",
                "Only the recipe tree changes (archived first). Nothing is built until you build it, dry run first. Logged in FMC_MCP_FileLog.csv.",
                new SettingItem[] { new ReadOnlySetting("Would rebuild", Rebuilds(dry), mono: true) }, "Make active", async () =>
                {
                    var r = await _tools.ActivateAsync(Folder, node.Id, variant, dryRun: false);
                    _messages.Show(r.Messages);
                    _status(r.Messages.FirstOrDefault()?.Text ?? "Done.");
                    if (r.Ok) await Refresh();
                    return null;
                }));
        }

        private async Task Choose(OptionMeasures o)
        {
            var node = Node;
            if (node == null || o.Variant == "base") return;
            var by = _me().Trim();
            if (by.Length == 0)
            {
                const string why = "Sign in first: choosing an option is a person's decision, recorded under their name.";
                _messages.Show(ChipKind.Warn, why);
                _status(why);
                return;
            }
            var dry = await _tools.ChooseAsync(Folder, node.Id, o.Variant, by, dryRun: true);
            if (!dry.Ok) { _messages.Show(dry.Messages); _status(dry.Messages.FirstOrDefault()?.Text ?? "Refused."); return; }
            _ask(DialogViewModel.WithItems("Choose " + o.Name + "?",
                $"{o.Name} becomes {node.Id}. The node as it is now is kept as a variant, so it can come back. Recorded as chosen by {by}. " +
                "If the options were built into Revit design options, accepting the primary there is a person's step: it deletes the others.",
                new SettingItem[] { new ReadOnlySetting("Would rebuild", Rebuilds(dry), mono: true) }, "Choose this one", async () =>
                {
                    var r = await _tools.ChooseAsync(Folder, node.Id, o.Variant, by, dryRun: false);
                    _messages.Show(r.Messages);
                    _status(r.Messages.FirstOrDefault()?.Text ?? "Done.");
                    if (r.Ok) { _saved = null; await Refresh(); }
                    return null;
                }));
        }

        private async Task Save()
        {
            var node = Node;
            if (node == null) { _status("No node has options to compare."); return; }
            var (ok, message, folder) = await _tools.SaveAsync(Folder, node.Id);
            if (!ok) { _messages.Show(ChipKind.Bad, message); _status(message); return; }
            _saved = folder;
            Rebuild();
            _messages.Show(ChipKind.Good, message + " " + folder);
            _status(message);
            OpenPath(folder);
        }

        private void OpenPlan(OptionMeasures o)
        {
            if (_saved == null)
            {
                const string why = "Save the comparison first: the plan sketches are drawn into its folder.";
                _messages.Show(ChipKind.Info, why);
                _status(why);
                return;
            }
            OpenPath(System.IO.Path.Combine(_saved, "Plan_" + o.Variant + ".svg"));
        }

        private static void OpenInShell(string path)
        {
            try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(path) { UseShellExecute = true }); }
            catch (Exception) { }
        }
    }
}
