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
    /// Engineer › Casework (+Model, CW3; boards CW_Pane, CW_Overview, CW_Outputs): five steps from a room to a workshop pack.
    /// Every number comes from the engine (fmc_casework); the pane only shows and asks. The workshop standards come from
    /// the kit, or with the run while the kit has none: nothing is filled in here (rules 5 and 7). Placing units in Revit
    /// is CW2 (fmc_casework place): a dry run places and rolls back, a yes places them in one Undo; when the add-in can't,
    /// the Place button says so and stays disabled; nothing is ever faked.
    /// </summary>
    public sealed class CaseworkPage : SectionPage
    {
        public static readonly string[] StepNames = { "Room", "Layouts", "Check", "Units", "Outputs" };
        public static readonly string[] Widths = { "300", "450", "600", "900" };
        public static readonly string[] FrontNames = { "Door", "2 doors", "2 drawers", "3 drawers", "4 drawers" };
        private static readonly string[] FrontCodes = { "door", "2door", "2drawer", "3drawer", "4drawer" };

        private readonly ICaseworkTools _tools;
        private readonly ProjectPage _project;
        private readonly IFilePicker _picker;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly Action<string>? _askClaude;
        private readonly MessagesSetting _messages = new MessagesSetting();
        // The unit editor's changes, until Apply sends them to the engine (not saved: they belong to this layout).
        private readonly InMemoryUserSettings _edits = new InMemoryUserSettings();
        private readonly Dictionary<string, string> _fronts = new Dictionary<string, string>();
        private readonly Dictionary<string, int> _widths = new Dictionary<string, int>();
        private readonly TextSetting _question = new TextSetting("", "", "Ask about this unit…");
        private bool _sampleRan;

        public CaseworkPage(ICaseworkTools tools, ProjectPage project, IFilePicker picker, IUserSettings settings, Action<string> status,
                            Action<DialogViewModel> ask, Action<string>? askClaude = null)
            : base("Casework", "From a room to cabinets and a workshop pack: real panels, real boards, real checks.")
        {
            _tools = tools;
            _project = project;
            _picker = picker;
            _store = new SettingStore(settings);
            _status = status;
            _ask = ask;
            _askClaude = askClaude;
            LayOutCommand = new AsyncCommand(LayOut, status);
            ApplyCommand = new AsyncCommand(Apply, status);
            PackCommand = new AsyncCommand(Pack, status);
            PlaceCommand = new RelayCommand(_ => Place(), _ => _tools.CanPlace && Last != null && Last.Ok && Last.Problems.Count == 0);
            ReadRoomCommand = new RelayCommand(_ => { }, _ => false);
            ChooseRunCommand = new RelayCommand(ChooseRun);
            AskCommand = new RelayCommand(AskClaude);
            NotYetCommand = new RelayCommand(_ => { }, _ => false);
            BackCommand = new RelayCommand(() => Go(Step - 1));
            NextCommand = new RelayCommand(() => Go(Step + 1));
            Rebuild();
        }

        public ICommand LayOutCommand { get; }
        public ICommand ApplyCommand { get; }
        public ICommand PackCommand { get; }
        public RelayCommand PlaceCommand { get; }
        public RelayCommand ReadRoomCommand { get; }
        public ICommand ChooseRunCommand { get; }
        public ICommand AskCommand { get; }
        public RelayCommand NotYetCommand { get; }
        public ICommand BackCommand { get; }
        public ICommand NextCommand { get; }
        public CaseworkLayout? Last { get; private set; }
        public TextSetting Question => _question;

        public int Step
        {
            get => int.TryParse(_store.Get("casework.step"), out var s) && s >= 0 && s < StepNames.Length ? s : 0;
        }

        /// <summary>The person's run file; in the preview, the boards' kitchen until one is chosen.</summary>
        public string RunFile => (_store.Get("casework.runfile") ?? _tools.SampleRunFile ?? "").Trim();
        public string Label => (_store.Get("casework.label") ?? (_tools.SampleRunFile != null ? "K-01 Kitchen" : "")).Trim();
        public string SelectedMark
        {
            get
            {
                var marks = EditableUnits.Select(u => u.Mark).ToList();
                var m = _store.Get("casework.unit");
                return m != null && marks.Contains(m) ? m : marks.Contains("K02") ? "K02" : marks.FirstOrDefault() ?? "";
            }
        }

        private IEnumerable<CaseworkUnit> EditableUnits => Last?.Units.Where(u => !u.IsGap) ?? Enumerable.Empty<CaseworkUnit>();
        private bool HasLayout => Last != null && Last.Ok;
        private int Placeable => Last?.UnitCount ?? 0;

        public override IEnumerable<FooterAction> Footer
        {
            get
            {
                switch (Step)
                {
                    case 0: return new[] { new FooterAction("Lay out the run", LayOutCommand, primary: true) };
                    case 1: return new[] { new FooterAction("Back", BackCommand), new FooterAction("Use this layout", NextCommand, primary: true) };
                    case 2: return new[] { new FooterAction("Back", BackCommand), new FooterAction(PlaceText, PlaceCommand, primary: true) };
                    case 3: return new[] { new FooterAction("Back", BackCommand), new FooterAction("Apply", ApplyCommand, primary: true) };
                    default: return new[] { new FooterAction("Back", BackCommand), new FooterAction("Make workshop pack", PackCommand, primary: true) };
                }
            }
        }

        private string PlaceText => "Place " + (Placeable > 0 ? Placeable + " units" : "units");

        /// <summary>The preview opens on the boards' kitchen; in Revit nothing runs until the person asks.</summary>
        public override void Opened()
        {
            if (_tools.SampleRunFile == null || _sampleRan || Last != null) return;
            _sampleRan = true;
            _ = LayOut(stay: true);
        }

        public void Go(int step)
        {
            step = Math.Max(0, Math.Min(step, StepNames.Length - 1));
            if (step == Step) { Rebuild(); return; }
            _store.Set("casework.step", step.ToString(CultureInfo.InvariantCulture));
            Rebuild();
        }

        public void Rebuild()
        {
            Top.Clear();
            Top.Add(new StepBarSetting(StepNames, Step, Go));
            Groups.Clear();
            switch (Step)
            {
                case 0: RoomStep(); break;
                case 1: LayoutStep(); break;
                case 2: CheckStep(); break;
                case 3: UnitStep(); break;
                default: OutputStep(); break;
            }
        }

        // ---------- 1 Room and brief ----------

        private void RoomStep()
        {
            Groups.Add(new SettingsGroup("Room",
                new TextSetting("Room and pack name", Label, "e.g. K-01 Kitchen", "The workshop pack's file names come from it.", _store, "casework.label"),
                new ButtonsSetting("", new[] { new SettingButton("Read the room from the model", ReadRoomCommand) },
                    "Coming with CW2: walls, openings, water, waste, gas and sockets read from the room under the cursor. Until then the run comes from a file."),
                new TextSetting("Run file (JSON)", RunFile, @"e.g. Z:\Projects\F26001\01_WIP\_Casework\K-01_run.json", "", _store, "casework.runfile", mono: true),
                new ButtonsSetting("", new[] { new SettingButton("Choose…", ChooseRunCommand) },
                    "A run: walls with lengths, window and door openings, the sink and appliance gaps, the corner and tall units, and the unit widths to fill with. The engine's example is server\\src\\fmc\\fixtures\\cw_kitchen.json.")));

            Groups.Add(new SettingsGroup("Describe it",
                new TextSetting("", "", "e.g. L-shaped kitchen, sink under the window, gas cooker on the short wall with a hood, tall larder at the end…", "",
                                _store, "casework.brief"),
                new NoteSetting("Layouts from a sentence, a sketch or a template (L-shape, U-shape, galley, island, wardrobe wall, vanity…) come later (board CW_Overview). Today the engine lays out the run you give it.", ChipKind.Grey)));

            var standards = new List<SettingItem>();
            if (Last != null && Last.Standards.Count > 0)
                standards.AddRange(Last.Standards.Select(s => (SettingItem)new ReadOnlySetting(s.Label, s.Value)));
            if (Last != null && Last.StandardsFrom.Length > 0)
                standards.Add(new NoteSetting("From " + Last.StandardsFrom + ".", ChipKind.Info));
            if (Last != null && Last.Missing.Count > 0)
                standards.Add(new NoteSetting("Missing, so nothing was laid out: " + string.Join(", ", Last.Missing) + ". They are design inputs: the pane never fills them in (rules 5 and 7).", ChipKind.Warn));
            if (standards.Count == 0)
                standards.Add(new NoteSetting("Sizes, boards, construction allowances and hardware rules come from the kit's 03_Master_Data\\FMC_Casework_Standards.json. The kit has none yet, so they travel with the run file (\"standards\"). Nothing is filled in here.", ChipKind.Grey));
            Groups.Add(new SettingsGroup("Workshop standards (kit)", standards.ToArray()));

            Groups.Add(new SettingsGroup("Style",
                new NoteSetting("Design movement, handles, front style and worktop come with the kit's design-movement profile sets (later). Boards are the workshop standards' kit materials.", ChipKind.Grey)));
            Groups.Add(new SettingsGroup("Lay out",
                new ButtonsSetting("", new[] { new SettingButton("Lay out the run", LayOutCommand, primary: true) }),
                _messages));
        }

        // ---------- 2 Layouts ----------

        private bool NeedsLayout()
        {
            if (HasLayout) return false;
            Groups.Add(new SettingsGroup(StepNames[Step],
                new NoteSetting(Last == null ? "Lay out the run first (step 1)." : Last.Message, Last == null ? ChipKind.Grey : ChipKind.Warn),
                new ButtonsSetting("", new[] { new SettingButton("Go to step 1", new RelayCommand(() => Go(0))) }),
                _messages));
            return true;
        }

        private void LayoutStep()
        {
            if (NeedsLayout()) return;
            var l = Last!;
            var items = new List<SettingItem>
            {
                new ReadOnlySetting("Option A · from the run", $"{l.UnitCount} units · worktop {Num(l.WorktopM)} m{(l.Worktop.Count > 0 ? " (" + string.Join(", ", l.Worktop) + ")" : "")}"),
                new TableSetting("", new[] { "Mark", "Unit", "Wall", "Fronts" },
                    l.Units.Select(u => new TableRow(u, u.Mark, UnitName(u), u.Wall.Length > 0 ? u.Wall + " at " + u.Offset : "—", u.IsGap ? "—" : FrontsName(u.Fronts)))),
            };
            if (l.Fillers.Count > 0) items.Add(new ReadOnlySetting("Fillers", string.Join("; ", l.Fillers), "Scribed on site from offcuts, not in the cut list."));
            items.AddRange(l.Problems.Select(p => (SettingItem)new NoteSetting(p, ChipKind.Bad)));
            items.AddRange(l.Notes.Select(n => (SettingItem)new NoteSetting(n, n.Contains("rule 5") ? ChipKind.Warn : ChipKind.Info)));
            Groups.Add(new SettingsGroup("Layout from your run", items.ToArray()));

            Groups.Add(new SettingsGroup("On the plan view",
                new ToggleSetting(_store, "casework.overlay", "Show the layout on the plan view", false, "Ghosted in blue on the view with the Flow overlay: comes later.",
                                  locked: true, lockedWhy: "Not built yet: Place puts the units in the model"),
                new NoteSetting("Three layouts from a brief, with the work triangle, storage and routes, and mixing options in a sentence, come later (board CW_Overview).", ChipKind.Grey),
                new ButtonsSetting("", new[] { new SettingButton("More options", NotYetCommand, ai: true) })));
            AskGroup("Ask about this layout…");
        }

        // ---------- 3 Checks and dry run ----------

        private void CheckStep()
        {
            if (NeedsLayout()) return;
            var l = Last!;
            var rows = new List<CheckRow>();
            foreach (var p in l.Problems) rows.Add(new CheckRow(new HealthCheck(p, "Fix", ChipKind.Bad), null));
            foreach (var n in l.Notes)
                rows.Add(new CheckRow(new HealthCheck(n, n.Contains("rule 5") ? "Decide" : "Info", n.Contains("rule 5") ? ChipKind.Warn : ChipKind.Info), null));
            if (l.Problems.Count == 0) rows.Add(new CheckRow(new HealthCheck("The run fits: no unit overlaps or runs past a wall", "OK", ChipKind.Good), null));
            rows.Add(new CheckRow(new HealthCheck("Services and window sills in the model", "Ask Claude", ChipKind.Grey,
                detail: "fmc_casework check reads the room in Revit (waste and water at the sink, gas at the cooker, sockets behind tall units or over the cooker, window sills) and flags each with its rule. It flags; you decide. Not on this screen yet."), null));
            Groups.Add(new SettingsGroup("Checks before anything is placed", new CheckListSetting(rows)));

            Groups.Add(new SettingsGroup("Counts",
                new TableSetting("", new[] { "Units", "Panels", "Sheets", "Edging" },
                    new[] { new TableRow(l, l.UnitCount.ToString(CultureInfo.InvariantCulture), l.Pieces.ToString(CultureInfo.InvariantCulture),
                                         l.Sheets.ToString(CultureInfo.InvariantCulture), Num(l.EdgeM) + " m") })));

            Groups.Add(new SettingsGroup("Place in the model",
                new NoteSetting(_tools.CanPlace
                    ? "The dry run places the units in Revit and rolls back, so the counts are real. Nothing is in the model until you place them; one Undo takes it all out."
                    : "Placing units comes with CW2 (fmc_casework_place). Then the dry run places them in Revit and rolls back, you say yes, and one Undo takes it all out. Nothing is placed from here yet.",
                    _tools.CanPlace ? ChipKind.Info : ChipKind.Warn),
                new ButtonsSetting("", new[] { new SettingButton(PlaceText, PlaceCommand, primary: true) },
                    _tools.CanPlace ? "Behind the live-model lock: families, new files, _Staging and _ChainTests only." : "Disabled until the add-in can place units (CW2)."),
                _messages));
        }

        // ---------- 4 Unit editor ----------

        private void UnitStep()
        {
            if (NeedsLayout()) return;
            var l = Last!;
            var mark = SelectedMark;
            var unit = l.Units.FirstOrDefault(u => u.Mark == mark);
            if (unit == null)
            {
                Groups.Add(new SettingsGroup("Unit editor", new NoteSetting("This layout has no units to edit.", ChipKind.Grey)));
                return;
            }
            var es = new SettingStore(_edits, "");
            int width = _widths.TryGetValue(mark, out var w) ? w : unit.Width;
            string fronts = _fronts.TryGetValue(mark, out var f) ? f : unit.Fronts;
            var widthOptions = Widths.Contains(width.ToString(CultureInfo.InvariantCulture)) ? Widths : Widths.Concat(new[] { width.ToString(CultureInfo.InvariantCulture) }).ToArray();
            es.Set(mark + ".width", width.ToString(CultureInfo.InvariantCulture));
            var frontIndex = Array.IndexOf(FrontCodes, fronts);
            var frontOptions = frontIndex >= 0 ? FrontNames : FrontNames.Concat(new[] { FrontsName(fronts) }).ToArray();
            es.Set(mark + ".fronts", frontIndex >= 0 ? FrontNames[frontIndex] : FrontsName(fronts));
            var changed = PendingEdits;

            Groups.Add(new SettingsGroup("Selected unit · " + mark,
                new ChoiceSetting(_store, "casework.unit", "Unit", EditableUnits.Select(u => u.Mark).ToList(), Math.Max(0, EditableUnits.Select(u => u.Mark).ToList().IndexOf(mark)),
                                  dropdown: true, changed: _ => Rebuild()),
                new ReadOnlySetting("Unit", UnitName(unit) + " · " + FrontsName(unit.Fronts) + " · wall " + unit.Wall + " at " + unit.Offset),
                new ChoiceSetting(es, mark + ".width", "Width", widthOptions, Array.IndexOf(widthOptions, width.ToString(CultureInfo.InvariantCulture)),
                                  changed: v => { Edit(mark, unit, width: int.Parse(v, CultureInfo.InvariantCulture)); }),
                new ChoiceSetting(es, mark + ".fronts", "Fronts", frontOptions, Math.Max(0, Array.IndexOf(frontOptions, es.Get(mark + ".fronts"))),
                                  changed: v => { var i = Array.IndexOf(FrontNames, v); if (i >= 0) Edit(mark, unit, fronts: FrontCodes[i]); }),
                new ReadOnlySetting("Assembly mark", mark),
                changed > 0
                    ? new NoteSetting(changed + (changed == 1 ? " change" : " changes") + " to apply. Apply sends them to the engine: panels, sheets and cost are recomputed here. The model changes when the units are placed (CW2)." +
                                      (_widths.Count > 0 ? " A width change lays out from the unit list, so the worktop isn't measured." : ""), ChipKind.Warn)
                    : (SettingItem)new NoteSetting("Width and fronts are one click; Apply recomputes the panels.", ChipKind.Grey),
                new ButtonsSetting("", new[] { new SettingButton("Apply", ApplyCommand, primary: true) }),
                _messages));

            var panels = l.CutList.Where(r => r.Mark == mark).ToList();
            Groups.Add(new SettingsGroup("Panels (from the engine)",
                panels.Count == 0
                    ? (SettingItem)new NoteSetting(unit.IsGap ? "A gap has no panels." : "No panels for " + mark + " in this answer.", ChipKind.Grey)
                    : new TableSetting("", new[] { "Part", "mm", "Qty", "Edge" },
                        panels.Select(r => new TableRow(r, r.Part, r.Length + " × " + r.Width, r.Qty.ToString(CultureInfo.InvariantCulture), r.Edge)),
                        hint: "The full list per assembly mark is in the workshop pack's cut list.")));
            AskGroup("Ask about " + mark + "…");
        }

        public int PendingEdits => _fronts.Count + _widths.Count;

        private void Edit(string mark, CaseworkUnit unit, int? width = null, string? fronts = null)
        {
            if (width is int w) { if (w == unit.Width) _widths.Remove(mark); else _widths[mark] = w; }
            if (fronts != null) { if (fronts == unit.Fronts) _fronts.Remove(mark); else _fronts[mark] = fronts; }
            Rebuild();
        }

        private void AskGroup(string placeholder)
        {
            var q = new TextSetting("", _question.Value, placeholder);
            q.PropertyChanged += (_, __) => _question.Value = q.Value;
            Groups.Add(new SettingsGroup("Ask Claude",
                q,
                new ButtonsSetting("", new[] { new SettingButton("Ask", AskCommand, ai: true) },
                    "Questions open Ask with this layout as context (read-only). Edits by sentence (\"make the three drawers equal\") come with Ask phase 2: Claude proposes, the engine recomputes, you apply.")));
        }

        // ---------- 5 Workshop pack ----------

        private void OutputStep()
        {
            if (NeedsLayout()) return;
            var l = Last!;
            Groups.Add(new SettingsGroup("Workshop pack · " + (Label.Length > 0 ? Label : "casework"),
                new TableSetting("", new[] { "Units", "Panels", "Sheets", "Edging" },
                    new[] { new TableRow(l, l.UnitCount.ToString(CultureInfo.InvariantCulture), l.Pieces.ToString(CultureInfo.InvariantCulture), l.Sheets.ToString(CultureInfo.InvariantCulture), Num(l.EdgeM) + " m") }),
                new TableSetting("", new[] { "Worktop", "Hardware", "Part lines" },
                    new[] { new TableRow(l, l.FromUnitList ? "not measured" : Num(l.WorktopM) + " m", l.HardwareItems + " items", l.PartLines.ToString(CultureInfo.InvariantCulture)) })));

            Groups.Add(new SettingsGroup("Boards",
                new TableSetting("", new[] { "Board", "Sheets", "Yield" },
                    l.Boards.Select(b => new TableRow(b, b.Material, b.Sheets.ToString(CultureInfo.InvariantCulture), b.YieldPct + "%")),
                    hint: "Nesting per sheet, with the kerf between every cut, is in the pack's nesting file.")));

            var priced = l.Cost.Count(c => c.Priced);
            Groups.Add(new SettingsGroup("Cost (material library)",
                new TableSetting("", new[] { "Item", "Price", "Source" },
                    l.Cost.Select(c => new TableRow(c, c.Item + (c.Material.Length > 0 ? " · " + c.Material : ""), c.Price, c.Status.Length > 0 ? c.Status + " · " + c.Date : "—"))),
                new NoteSetting(priced == 0
                    ? "Nothing is priced yet: the kit's material library has no prices for these. Missing prices are flagged, never invented."
                    : $"Priced so far: {Ugx(l.CostLow, l.CostHigh)} ({priced} of {l.Cost.Count} lines). The rest say \"price needed\": missing prices are flagged, never invented.",
                    ChipKind.Warn)));

            if (l.KitRequests.Count > 0)
                Groups.Add(new SettingsGroup("Kit change requests", l.KitRequests.Select(k => (SettingItem)new NoteSetting(k, ChipKind.Warn)).ToArray()));

            Groups.Add(new SettingsGroup("Send",
                new NoteSetting(@"Make workshop pack writes the cut list, nesting, hardware and BoQ as CSV, and the workshop pack PDF (cut list per mark, nesting drawings, hardware, cost with its sources), into <project>\01_WIP\_Casework, after a dry run you see first. A file it replaces moves to _Archive; nothing is deleted.", ChipKind.Info),
                new TableSetting("", new[] { "Output", "Format", "State" }, new[]
                {
                    new TableRow(null, "Cut list and nesting", "CSV (Excel)", "Now"),
                    new TableRow(null, "Hardware and BoQ", "CSV (Excel)", "Now"),
                    new TableRow(null, "Workshop pack", "PDF", "Now"),
                    new TableRow(null, "Shop drawings (A3)", "Revit sheets and PDF", "Ask Claude (after Place)"),
                    new TableRow(null, "CNC parts", "DXF", "Later"),
                    new TableRow(null, "Schedule I11_Joinery_Cutlist", "Revit", "With the shop drawings"),
                }),
                new ButtonsSetting("", new[] { new SettingButton("Make workshop pack", PackCommand, primary: true) }),
                _messages));
        }

        // ---------- actions ----------

        public CaseworkRequest Request()
        {
            var q = new CaseworkRequest { RunFile = RunFile, Label = Label };
            foreach (var kv in _fronts) q.Fronts[kv.Key] = kv.Value;
            if ((_widths.Count > 0 || Last?.FromUnitList == true) && Last != null)
            {
                q.Units = Last.Units.Select(u => u.Copy()).ToList();
                foreach (var u in q.Units)
                {
                    if (_widths.TryGetValue(u.Mark, out var w)) u.Width = w;
                    if (_fronts.TryGetValue(u.Mark, out var f)) u.Fronts = f;
                }
                q.Fronts.Clear();
            }
            return q;
        }

        public Task LayOut() => LayOut(stay: false);

        private async Task LayOut(bool stay)
        {
            if (RunFile.Length == 0)
            {
                _messages.Show(ChipKind.Warn, "Choose the run file first: until CW2 reads the room from the model, the run comes from a file.");
                _status("Choose the run file first.");
                Rebuild();
                return;
            }
            _fronts.Clear();
            _widths.Clear();
            Last = await _tools.LayOutAsync(new CaseworkRequest { RunFile = RunFile, Label = Label });
            Shown(Last);
            if (!stay && Last.Ok) Go(1); else Rebuild();
        }

        private async Task Apply()
        {
            if (Last == null || !Last.Ok) { _messages.Show(ChipKind.Warn, "Lay out the run first (step 1)."); Rebuild(); return; }
            if (PendingEdits == 0) { _messages.Show(ChipKind.Info, "Nothing to apply: change a width or the fronts first."); Rebuild(); return; }
            var q = Request();
            var n = PendingEdits;
            var next = await _tools.LayOutAsync(q);
            if (!next.Ok) { _messages.Show(ChipKind.Bad, next.Message); _status(next.Message); Rebuild(); return; }
            Last = next;
            _fronts.Clear();
            _widths.Clear();
            var text = $"Applied {n} {(n == 1 ? "change" : "changes")} in the pane: {next.Pieces} panels on {next.Sheets} sheets. The model changes when the units are placed (CW2).";
            _messages.Show(next.Problems.Count > 0 ? ChipKind.Warn : ChipKind.Good, next.Problems.Count > 0 ? text + " " + string.Join(" ", next.Problems) : text);
            _status(text);
            Rebuild();
        }

        private void Shown(CaseworkLayout l)
        {
            if (!l.Ok) { _messages.Show(ChipKind.Bad, l.Message); _status(l.Message); return; }
            var text = $"{l.UnitCount} units, {l.Pieces} panels on {l.Sheets} sheets, {Num(l.EdgeM)} m of edging" + (l.Problems.Count > 0 ? $"; {l.Problems.Count} to fix." : ".");
            _messages.Show(l.Problems.Count > 0 ? ChipKind.Warn : ChipKind.Info, text);
            _status(text);
        }

        private Task Pack()
        {
            if (Last == null || !Last.Ok) { _messages.Show(ChipKind.Warn, "Lay out the run first (step 1)."); Rebuild(); return Task.CompletedTask; }
            var p = _project.Request();
            if (p.Folder.Length == 0 || p.Code.Length == 0)
            {
                _messages.Show(ChipKind.Warn, @"Set the project folder and code in Setup › Project: the pack goes into its 01_WIP\_Casework and is named with the code.");
                _status("Set the project folder and code first.");
                Rebuild();
                return Task.CompletedTask;
            }
            if (Label.Length == 0)
            {
                _messages.Show(ChipKind.Warn, "Name the room on step 1 (e.g. K-01 Kitchen): the pack's file names come from it.");
                Rebuild();
                return Task.CompletedTask;
            }
            return PackDry(p.Folder, p.Code);
        }

        private async Task PackDry(string folder, string code)
        {
            var q = Request();
            var dry = await _tools.PackAsync(q, folder, code, dryRun: true);
            _messages.Show(dry.Messages);
            if (!dry.Ok) { _status(dry.Messages.FirstOrDefault()?.Text ?? "The pack was refused."); Rebuild(); return; }
            Rebuild();
            _ask(DialogViewModel.WithItems("Make the workshop pack?", (Label.Length > 0 ? Label + ": " : "") + dry.Files.Count + " files into " + dry.Folder + ".",
                new SettingItem[]
                {
                    new ReadOnlySetting("Will write", string.Join(Environment.NewLine, dry.Files.Select(f => f.File + " · " + f.Rows + " rows · " + f.Action)), mono: true),
                    new NoteSetting("CSV files only, into 01_WIP. A replaced file moves to _Archive; nothing is deleted. One log line.", ChipKind.Info),
                }, "Write the pack", async () =>
                {
                    var r = await _tools.PackAsync(q, folder, code, dryRun: false);
                    _messages.Show(r.Messages);
                    _status(r.Messages.FirstOrDefault()?.Text ?? "Done.");
                    Rebuild();
                    return null;
                }));
        }

        private void Place()
        {
            if (!_tools.CanPlace || Last == null) return;
            var q = Request();
            _ = PlaceDry(q);
        }

        private async Task PlaceDry(CaseworkRequest q)
        {
            var dry = await _tools.PlaceAsync(q, dryRun: true);
            _messages.Show(dry.Messages);
            if (!dry.Ok) { Rebuild(); return; }
            _ask(DialogViewModel.WithItems(PlaceText + "?", "The dry run placed them and rolled back.",
                new SettingItem[] { new ReadOnlySetting("Will place", string.Join(Environment.NewLine, dry.Details), mono: true) },
                "Place", async () =>
                {
                    var r = await _tools.PlaceAsync(q, dryRun: false);
                    _messages.Show(r.Messages);
                    Rebuild();
                    return null;
                }));
        }

        private void ChooseRun()
        {
            string start = "";
            try { start = RunFile.Length > 0 ? System.IO.Path.GetDirectoryName(RunFile) ?? "" : ""; } catch (ArgumentException) { }
            var file = _picker.Open("Casework run", "Run (*.json)|*.json", start);
            if (file != null) { _store.Set("casework.runfile", file); Rebuild(); }
        }

        private void AskClaude()
        {
            var text = _question.Value.Trim();
            if (text.Length == 0) { _status("Type a question first."); return; }
            if (_askClaude == null) { _status("Ask Claude isn't available here."); return; }
            var about = Step == 3 && SelectedMark.Length > 0 ? "casework unit " + SelectedMark : "the casework layout" + (Label.Length > 0 ? " for " + Label : "");
            _question.Value = "";
            _askClaude("About " + about + ": " + text);
        }

        // ---------- words ----------

        public static string UnitName(CaseworkUnit u)
        {
            switch (u.Kind)
            {
                case "corner": return "Corner " + u.Width;
                case "sink": return "Sink " + u.Width;
                case "tall": return "Tall " + u.Width;
                case "wall": return "Wall " + u.Width;
                case "gap": return Cap(u.Fronts) + " space " + u.Width;
                default: return "Base " + u.Width;
            }
        }

        public static string FrontsName(string code)
        {
            var i = Array.IndexOf(FrontCodes, code);
            if (i >= 0) return FrontNames[i];
            if (code.EndsWith("drawer") && code.Length > 6) return code.Substring(0, code.Length - 6) + " drawers";
            return code == "none" ? "Open" : Cap(code);
        }

        private static string Cap(string s) => s.Length == 0 ? s : char.ToUpperInvariant(s[0]) + s.Substring(1);
        private static string Num(double v) => v.ToString("0.#", CultureInfo.InvariantCulture);

        private static string Ugx(long low, long high) =>
            low == high ? "UGX " + low.ToString("N0", CultureInfo.InvariantCulture) : "UGX " + low.ToString("N0", CultureInfo.InvariantCulture) + "–" + high.ToString("N0", CultureInfo.InvariantCulture);
    }
}
