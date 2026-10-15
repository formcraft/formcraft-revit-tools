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
    /// Engineer › Ceilings (+Model, CL3; boards CL_Pane, CL_Overview, CL_Pack): five steps from a room and a brief to a
    /// ceiling pack. Every number comes from the engine (fmc_ceiling). The light level is indicative and always for the
    /// electrical engineer (CA-E-03); detectors and sprinklers are flagged for the fire engineer (rule 5). Placing
    /// ceilings in Revit is CL2: until the add-in can, the Place button says so and stays disabled.
    /// </summary>
    public sealed class CeilingsPage : SectionPage
    {
        public static readonly string[] StepNames = { "Room", "Designs", "Check", "Features", "Pack" };
        /// <summary>The brief's shapes and details, as the engine names them (fmc_ceiling brief.styles).</summary>
        public static readonly (string Name, string Style)[] Shapes =
            { ("Flat", "flat"), ("Tray", "tray"), ("Bulkhead", "bulkhead"), ("Floating raft", "raft"), ("Coffered", "coffer") };
        public static readonly (string Name, string Style)[] Details = { ("Cove light", "cove"), ("Cornice", "cornice") };
        public static readonly string[] BulkheadWidths = { "450", "600", "900" };
        public static readonly string[] BulkheadDrops = { "150", "300", "450" };
        public static readonly string[] RaftDrops = { "100", "150", "200" };
        public static readonly string[] CofferDrops = { "150", "200", "250" };

        private readonly ICeilingTools _tools;
        private readonly ProjectPage _project;
        private readonly IFilePicker _picker;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly Action<string>? _askClaude;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private readonly TextSetting _question = new TextSetting("", "", "Ask about this ceiling…");
        private readonly CeilingRequest? _sample;
        private bool _sampleRan;

        public CeilingsPage(ICeilingTools tools, ProjectPage project, IFilePicker picker, IUserSettings settings, Action<string> status,
                            Action<DialogViewModel> ask, Action<string>? askClaude = null)
            : base("Ceilings", "From a room and a sentence to a coordinated ceiling, a set-out and a bill of quantities.")
        {
            _tools = tools;
            _project = project;
            _picker = picker;
            _store = new SettingStore(settings);
            _status = status;
            _ask = ask;
            _askClaude = askClaude;
            _sample = tools.Sample;
            ProposeCommand = new AsyncCommand(Propose, status);
            UseCommand = new AsyncCommand(() => Use(Design), status);
            ApplyCommand = new AsyncCommand(Apply, status);
            PackCommand = new AsyncCommand(Pack, status);
            PlaceCommand = new RelayCommand(_ => Place(), _ => _tools.CanPlace && Evaluation != null && Evaluation.Ok);
            ReadRoomCommand = new RelayCommand(_ => { }, _ => false);
            NotYetCommand = new RelayCommand(_ => { }, _ => false);
            ChooseFixturesCommand = new RelayCommand(ChooseFixtures);
            AskCommand = new RelayCommand(AskClaude);
            BackCommand = new RelayCommand(() => Go(Step - 1));
            Rebuild();
        }

        public ICommand ProposeCommand { get; }
        public ICommand UseCommand { get; }
        public ICommand ApplyCommand { get; }
        public ICommand PackCommand { get; }
        public RelayCommand PlaceCommand { get; }
        public RelayCommand ReadRoomCommand { get; }
        public RelayCommand NotYetCommand { get; }
        public ICommand ChooseFixturesCommand { get; }
        public ICommand AskCommand { get; }
        public ICommand BackCommand { get; }
        public CeilingDesigns? Designs { get; private set; }
        public CeilingEvaluation? Evaluation { get; private set; }
        public TextSetting Question => _question;

        public int Step => int.TryParse(_store.Get("ceilings.step"), out var s) && s >= 0 && s < StepNames.Length ? s : 0;

        /// <summary>The chosen design (tray, raft, coffer, flat): the person's pick, else the engine's recommendation.</summary>
        public string Design
        {
            get
            {
                var kinds = Designs?.Options.Select(o => o.Kind).ToList() ?? new List<string>();
                var d = _store.Get("ceilings.design");
                if (d != null && kinds.Contains(d)) return d;
                return Designs?.Options.FirstOrDefault(o => o.Recommended)?.Kind ?? kinds.FirstOrDefault() ?? "";
            }
        }

        private CeilingOption? Chosen => Designs?.Options.FirstOrDefault(o => o.Kind == Design);

        public override IEnumerable<FooterAction> Footer
        {
            get
            {
                switch (Step)
                {
                    case 0: return new[] { new FooterAction("Propose designs", ProposeCommand, primary: true) };
                    case 1: return new[] { new FooterAction("Back", BackCommand), new FooterAction("Use design " + (Chosen?.Id ?? ""), UseCommand, primary: true) };
                    case 2: return new[] { new FooterAction("Back", BackCommand), new FooterAction("Place the ceiling", PlaceCommand, primary: true) };
                    case 3: return new[] { new FooterAction("Back", BackCommand), new FooterAction("Apply", ApplyCommand, primary: true) };
                    default: return new[] { new FooterAction("Back", BackCommand), new FooterAction("Make ceiling pack", PackCommand, primary: true) };
                }
            }
        }

        /// <summary>The preview opens on the boards' living room; in Revit nothing runs until the person asks.</summary>
        public override void Opened()
        {
            if (_sample == null || _sampleRan || Designs != null) return;
            _sampleRan = true;
            _ = Propose(stay: true);
        }

        public void Go(int step)
        {
            step = Math.Max(0, Math.Min(step, StepNames.Length - 1));
            if (step != Step) _store.Set("ceilings.step", step.ToString(CultureInfo.InvariantCulture));
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
                case 1: DesignStep(); break;
                case 2: CheckStep(); break;
                case 3: FeatureStep(); break;
                default: PackStep(); break;
            }
        }

        // ---------- the room and brief, from the pane's fields ----------

        private string Text(string key, string sample) => (_store.Get(key) ?? (_sample != null ? sample : "")).Trim();

        private static string Mm(double v) => v > 0 ? v.ToString("0", CultureInfo.InvariantCulture) : "";

        private static double? Number(string s) =>
            double.TryParse(s.Replace(" ", ""), NumberStyles.Float, CultureInfo.InvariantCulture, out var v) && v > 0 ? v : (double?)null;

        private List<string> Picked(string key, IEnumerable<(string Name, string Style)> options, IEnumerable<string> sample)
        {
            var saved = _store.Get(key);
            var on = saved == null ? (_sample != null ? new HashSet<string>(sample) : new HashSet<string>()) : new HashSet<string>(saved.Split('|').Where(x => x.Length > 0));
            return options.Where(o => on.Contains(o.Name)).Select(o => o.Style).ToList();
        }

        private string Choice(string key, string[] options) => _store.Get(key) is string v && options.Contains(v) ? v : "";

        public CeilingRequest Request()
        {
            var s = _sample;
            var q = new CeilingRequest
            {
                Room = Text("ceilings.room", s?.Room ?? ""),
                WidthMm = Number(Text("ceilings.width", Mm(s?.WidthMm ?? 0))) ?? 0,
                DepthMm = Number(Text("ceilings.depth", Mm(s?.DepthMm ?? 0))) ?? 0,
                StructureHeightMm = Number(Text("ceilings.structure_height", Mm(s?.StructureHeightMm ?? 0))) ?? 0,
                Structure = _store.Get("ceilings.structure") == "Slab" ? "slab" : "ties",
                TieSpacingMm = Number(Text("ceilings.tie_spacing", "")),
                Board = Text("ceilings.board", ""),
                FanAtCentre = _store.Get("ceilings.fan") is string fan ? fan == "true" : s?.FanAtCentre ?? false,
                FixturesFile = Text("ceilings.fixtures", s?.FixturesFile ?? ""),
                BulkheadWidthMm = Number(Choice("ceilings.bulkhead_width", BulkheadWidths)),
                BulkheadDropMm = Number(Choice("ceilings.bulkhead_drop", BulkheadDrops)),
                RaftDropMm = Number(Choice("ceilings.raft_drop", RaftDrops)),
                CofferDropMm = Number(Choice("ceilings.coffer_drop", CofferDrops)),
            };
            var sampleShapes = Shapes.Where(x => s != null && s.Styles.Contains(x.Style)).Select(x => x.Name);
            var sampleDetails = Details.Where(x => s != null && s.Styles.Contains(x.Style)).Select(x => x.Name);
            q.Styles.AddRange(Picked("ceilings.shapes", Shapes, sampleShapes));
            q.Styles.AddRange(Picked("ceilings.details", Details, sampleDetails));
            return q;
        }

        /// <summary>What's missing before the engine can run: the room's size and what is above it.</summary>
        public static string? Missing(CeilingRequest q)
        {
            var miss = new List<string>();
            if (q.Room.Length == 0) miss.Add("the room's name");
            if (q.WidthMm <= 0 || q.DepthMm <= 0) miss.Add("its width and depth (mm)");
            if (q.StructureHeightMm <= 0) miss.Add("the underside of the ties or slab (mm from the floor)");
            return miss.Count == 0 ? null : "Give " + string.Join(", ", miss) + ".";
        }

        // ---------- 1 Room and brief ----------

        private void RoomStep()
        {
            var q = Request();
            var s = _sample;
            Groups.Add(new SettingsGroup("Room",
                new ButtonsSetting("", new[] { new SettingButton("Read the room from the model", ReadRoomCommand) },
                    "Coming with CL2: the outline, what is above (ties, slab, beams), lighting circuits, AC units and fixtures read from the model. Until then, type the room."),
                new TextSetting("Room", q.Room, "e.g. L-01 Living", "", _store, "ceilings.room"),
                new TextSetting("Width (mm)", Mm(q.WidthMm), "e.g. 6000", "", _store, "ceilings.width"),
                new TextSetting("Depth (mm)", Mm(q.DepthMm), "e.g. 4500", "", _store, "ceilings.depth"),
                new TextSetting("Underside of the ties or slab (mm from the floor)", Mm(q.StructureHeightMm), "e.g. 3000", "", _store, "ceilings.structure_height"),
                new ChoiceSetting(_store, "ceilings.structure", "Above the ceiling", new[] { "Truss ties", "Slab" }),
                new TextSetting("Tie centres (mm, if known)", Mm(q.TieSpacingMm ?? 0), "e.g. 600", "The hanger check says which hangers land between ties.", _store, "ceilings.tie_spacing")));

            Groups.Add(new SettingsGroup("Fixtures",
                new ToggleSetting(_store, "ceilings.fan", "A ceiling fan in the middle of the room", s?.FanAtCentre ?? false),
                new TextSetting("Fixtures file (JSON, optional)", q.FixturesFile, @"downlights, detectors, AC grilles, hatch, sprinklers", "", _store, "ceilings.fixtures", mono: true),
                new ButtonsSetting("", new[] { new SettingButton("Choose…", ChooseFixturesCommand) },
                    "fmc_ceiling's fixtures in mm from the room's corner. Read from the model with CL2.")));

            Groups.Add(new SettingsGroup("Describe it",
                new TextSetting("", "", "e.g. Tray ceiling with a 600 bulkhead all round and warm cove light, fan in the middle…", "", _store, "ceilings.brief"),
                new MultiSetting(_store, "ceilings.shapes", "Shape", Shapes.Select(x => x.Name).ToList(),
                                 Shapes.Where(x => s != null && s.Styles.Contains(x.Style)).Select(x => x.Name)),
                new MultiSetting(_store, "ceilings.details", "Details", Details.Select(x => x.Name).ToList(),
                                 Details.Where(x => s != null && s.Styles.Contains(x.Style)).Select(x => x.Name)),
                new NoteSetting("Designs from a sentence or a sketch, and timber slats, PVC panels, T&G and a 600 grid, come later (board CL_Overview). Today the engine designs gypsum board on metal furring from the shapes you pick.", ChipKind.Grey)));

            Groups.Add(new SettingsGroup("Ceiling standards (kit)",
                new TextSetting("Ceiling build (kit keynote)", q.Board, "I.CLG_02 when empty (the engine's default)", "", _store, "ceilings.board", mono: true),
                new NoteSetting(Designs != null && Designs.KitRequests.Count > 0
                    ? "Channel centres, hanger grid, void, joints and waste: the kit has no ceiling standard yet, so the engine uses its reference values and lists each as a kit change request (step 5)."
                    : "Channel centres, hanger grid, void, joints and waste come from the kit (03_Master_Data\\FMC_Ceiling_Standard.json, proposed). Prices come only from the material library.",
                    ChipKind.Grey)));
            Groups.Add(new SettingsGroup("Style",
                new NoteSetting("Design movement, cornice profile, edge detail and light colour come with the kit's design-movement profile sets (later).", ChipKind.Grey)));
            Groups.Add(new SettingsGroup("Propose",
                new ButtonsSetting("", new[] { new SettingButton("Propose designs", ProposeCommand, primary: true) }),
                _messages));
        }

        // ---------- 2 Designs ----------

        private bool NeedsDesigns()
        {
            if (Designs != null && Designs.Ok && Designs.Options.Count > 0) return false;
            Groups.Add(new SettingsGroup(StepNames[Step],
                new NoteSetting(Designs == null ? "Propose designs first (step 1)." : Designs.Message, Designs == null ? ChipKind.Grey : ChipKind.Warn),
                new ButtonsSetting("", new[] { new SettingButton("Go to step 1", new RelayCommand(() => Go(0))) }),
                _messages));
            return true;
        }

        private void DesignStep()
        {
            if (NeedsDesigns()) return;
            var d = Designs!;
            var table = new TableSetting("", new[] { "Design", "Heights", "Boards", "Light (indic.)", "Checks" },
                d.Options.Select(o => new TableRow(o, o.Id + (o.Recommended ? " · recommended" : ""), o.HeightsText, o.Sheets + " sheets", o.Lux + " lx", o.ChecksText)),
                selectable: true, hint: "Pick a row to use that design.");
            table.Selected = table.Rows.FirstOrDefault(r => (r.Tag as CeilingOption)?.Kind == Design);
            table.PropertyChanged += (_, e) =>
            {
                if (e.PropertyName != nameof(TableSetting.Selected) || !(table.Selected?.Tag is CeilingOption o) || o.Kind == Design) return;
                _store.Set("ceilings.design", o.Kind);
                Rebuild();
            };
            Groups.Add(new SettingsGroup("Designs from your brief", table, new NoteSetting(d.Note, ChipKind.Info)));
            foreach (var o in d.Options)
            {
                var items = new List<SettingItem> { new ReadOnlySetting(o.Label, o.Why) };
                items.AddRange(o.Flags.Select(f => (SettingItem)new NoteSetting(f, o.Fail > 0 ? ChipKind.Bad : ChipKind.Warn)));
                Groups.Add(new SettingsGroup("Design " + o.Id + (o.Recommended ? " · recommended" : "") + (o.Kind == Design ? " · chosen" : ""), items.ToArray()));
            }
            if (d.Skipped.Count > 0) Groups.Add(new SettingsGroup("Not possible in this room", d.Skipped.Select(x => (SettingItem)new NoteSetting(x, ChipKind.Grey)).ToArray()));
            Groups.Add(new SettingsGroup("On the ceiling plan",
                new ToggleSetting(_store, "ceilings.overlay", "Show designs on the ceiling plan and in 3D", false, "Ghosted in blue with the Flow overlay: comes with CL2.",
                                  locked: true, lockedWhy: "Comes with CL2 (placement in Revit)"),
                new NoteSetting("Mixing designs in a sentence (\"A with B's raft over the sofa\") comes with Ask phase 2.", ChipKind.Grey),
                new ButtonsSetting("", new[] { new SettingButton("More designs", NotYetCommand, ai: true), new SettingButton("Use design " + (Chosen?.Id ?? ""), UseCommand, primary: true) })));
            AskGroup("Ask about these designs…");
        }

        // ---------- 3 Checks and dry run ----------

        private bool NeedsEvaluation()
        {
            if (NeedsDesigns()) return true;
            if (Evaluation != null && Evaluation.Ok && Evaluation.Kind == Design) return false;
            Groups.Add(new SettingsGroup(StepNames[Step],
                new NoteSetting(Evaluation != null && Evaluation.Kind == Design && Evaluation.Message.Length > 0 ? Evaluation.Message : "Use a design first (step 2).",
                                Evaluation != null && Evaluation.Kind == Design ? ChipKind.Warn : ChipKind.Grey),
                new ButtonsSetting("", new[] { new SettingButton("Use design " + (Chosen?.Id ?? ""), UseCommand, primary: true) }),
                _messages));
            return true;
        }

        public static (string Status, ChipKind Kind) Chip(string result)
        {
            switch (result)
            {
                case "OK": return ("OK", ChipKind.Good);
                case "Fail": return ("Fail", ChipKind.Bad);
                case "Decide": return ("Decide", ChipKind.Warn);
                case "Engineer": return ("Engineer", ChipKind.Info);
                case "Info": return ("Info", ChipKind.Info);
                default: return (result, ChipKind.Grey);
            }
        }

        private void CheckStep()
        {
            if (NeedsEvaluation()) return;
            var e = Evaluation!;
            var rows = e.Checks.Select(c => { var (status, kind) = Chip(c.Result); return new CheckRow(new HealthCheck(c.Check, status, kind, detail: c.Detail), null); }).ToList();
            Groups.Add(new SettingsGroup("Checks before anything is placed · design " + (Chosen?.Id ?? ""), new CheckListSetting(rows),
                new NoteSetting("They flag; you decide. The light level is indicative: the electrical engineer designs the lighting (CA-E-03). Detectors and sprinklers are the fire engineer's.", ChipKind.Info)));
            Groups.Add(new SettingsGroup("Counts",
                new TableSetting("", new[] { "Board", "Sheets", "Furring", "Hangers" },
                    new[] { new TableRow(e, Num(e.BoardM2) + " m²", e.Sheets.ToString(CultureInfo.InvariantCulture), Num(e.FurringM) + " m", e.Hangers.ToString(CultureInfo.InvariantCulture)) })));
            Groups.Add(new SettingsGroup("Place in the model",
                new NoteSetting(_tools.CanPlace
                    ? "The dry run places the ceilings, bulkhead, cove, cornice and fixtures and rolls back, so the counts are real. One Undo takes it all out."
                    : "Placing comes with CL2 (fmc_ceiling_place). Then the dry run places the ceilings and fixtures in Revit and rolls back, you say yes, and one Undo takes it all out. Nothing is placed from here yet.",
                    _tools.CanPlace ? ChipKind.Info : ChipKind.Warn),
                new ButtonsSetting("", new[] { new SettingButton("Place the ceiling", PlaceCommand, primary: true) },
                    _tools.CanPlace ? "Behind the live-model lock: new files, _Staging and _ChainTests only." : "Disabled until the add-in can place ceilings (CL2)."),
                _messages));
        }

        // ---------- 4 Features ----------

        public IReadOnlyList<string> Features
        {
            get
            {
                var list = new List<string>();
                switch (Design)
                {
                    case "tray": list.Add("Perimeter bulkhead"); break;
                    case "raft": list.Add("Floating raft"); break;
                    case "coffer": list.Add("Coffers"); break;
                }
                if (Design == "tray" || Design == "raft") list.Add("Cove light");
                list.Add("Cornice");
                return list;
            }
        }

        private void FeatureStep()
        {
            if (NeedsEvaluation()) return;
            var e = Evaluation!;
            var features = Features;
            var feature = _store.Get("ceilings.feature") is string f && features.Contains(f) ? f : features[0];
            var items = new List<SettingItem>
            {
                new ChoiceSetting(_store, "ceilings.feature", "Feature", features.ToList(), features.ToList().IndexOf(feature), dropdown: true, changed: _ => Rebuild()),
            };
            var q = Request();
            switch (feature)
            {
                case "Perimeter bulkhead":
                    items.Add(Segment("ceilings.bulkhead_width", "Width", BulkheadWidths, q.BulkheadWidthMm));
                    items.Add(Segment("ceilings.bulkhead_drop", "Drop", BulkheadDrops, q.BulkheadDropMm));
                    items.Add(new ReadOnlySetting("Heights", e.HeightsText()));
                    break;
                case "Floating raft":
                    items.Add(Segment("ceilings.raft_drop", "Drop", RaftDrops, q.RaftDropMm));
                    items.Add(new ReadOnlySetting("Heights", e.HeightsText()));
                    break;
                case "Coffers":
                    items.Add(Segment("ceilings.coffer_drop", "Depth", CofferDrops, q.CofferDropMm));
                    items.Add(new ReadOnlySetting("Heights", e.HeightsText()));
                    break;
                case "Cove light":
                    items.Add(new ReadOnlySetting("Cove LED", Num(e.CoveLedM) + " m along the step", "The electrical engineer specifies the strip, driver and colour (rule 5)."));
                    break;
                default:
                    items.Add(new ReadOnlySetting("Cornice", Num(e.CorniceM) + " m round the room", "Profile from the design movement's profile sets (later)."));
                    break;
            }
            items.Add(new MultiSetting(_store, "ceilings.details", "Details", Details.Select(x => x.Name).ToList(),
                                       Details.Where(x => _sample != null && _sample.Styles.Contains(x.Style)).Select(x => x.Name)));
            items.Add(new ReadOnlySetting("Build-up", (q.Board.Length > 0 ? q.Board : "I.CLG_02") + " · " + e.Sheet + " boards", "Keynotes from the kit."));
            items.Add(new NoteSetting("Apply sends the changes to the engine: designs, checks, set-out and quantities are recomputed here. The model changes when the ceiling is placed (CL2).", ChipKind.Grey));
            items.Add(new ButtonsSetting("", new[] { new SettingButton("Apply", ApplyCommand, primary: true) }));
            items.Add(_messages);
            Groups.Add(new SettingsGroup("Selected feature · " + feature.ToLowerInvariant(), items.ToArray()));
            AskGroup("Ask about this ceiling…");
        }

        private ChoiceSetting Segment(string key, string label, string[] options, double? current)
        {
            var cur = current.HasValue ? current.Value.ToString("0", CultureInfo.InvariantCulture) : "";
            var fallback = Array.IndexOf(options, cur);
            // Nothing chosen yet: the engine's own default is in use, shown as the middle option it uses.
            return new ChoiceSetting(_store, key, label, options, fallback >= 0 ? fallback : 1,
                hint: current.HasValue ? "" : "Not set: the engine's default (" + options[1] + ") is in use until you pick one.");
        }

        private void AskGroup(string placeholder)
        {
            var q = new TextSetting("", _question.Value, placeholder);
            q.PropertyChanged += (_, __) => _question.Value = q.Value;
            Groups.Add(new SettingsGroup("Ask Claude",
                q,
                new ButtonsSetting("", new[] { new SettingButton("Ask", AskCommand, ai: true) },
                    "Questions open Ask with this ceiling as context (read-only). Edits by sentence (\"make the bulkhead 900 on the TV wall only\") come with Ask phase 2: Claude proposes, the engine recomputes, you apply.")));
        }

        // ---------- 5 Pack ----------

        private void PackStep()
        {
            if (NeedsEvaluation()) return;
            var e = Evaluation!;
            var q = Request();
            Groups.Add(new SettingsGroup("Ceiling pack · " + (q.Room.Length > 0 ? q.Room : "room"),
                new TableSetting("", new[] { "Board", "Sheets", "Channels", "Hangers" },
                    new[] { new TableRow(e, Num(e.BoardM2) + " m²", e.Sheets.ToString(CultureInfo.InvariantCulture), Num(e.ChannelsM) + " m", e.Hangers.ToString(CultureInfo.InvariantCulture)) }),
                new TableSetting("", new[] { "Cornice", "Cove LED", "Screws", "Paint" },
                    new[] { new TableRow(e, Num(e.CorniceM) + " m", Num(e.CoveLedM) + " m", e.Screws.ToString(CultureInfo.InvariantCulture), Num(e.PaintM2) + " m²") })));

            Groups.Add(new SettingsGroup("Set-out",
                new TableSetting("", new[] { "Zone", "Height", "Area", "Boards" },
                    e.Zones.Select(z => new TableRow(z, Cap(z.Zone), z.HeightMm.ToString(CultureInfo.InvariantCulture), Num(z.AreaM2) + " m²",
                        z.Boards + (z.Boards > 0 ? " (" + z.First + "–" + z.Last + ")" : "") + (z.Slivers > 0 ? " · " + z.Slivers + " slivers" : "")))),
                new NoteSetting("Boards are numbered from the zone's setting-out point, long edges across the furring, end joints staggered; mains, furring and hanger points are in the set-out file.", ChipKind.Info)));

            Groups.Add(new SettingsGroup("Bill of quantities (material library)",
                new TableSetting("", new[] { "Item", "Qty", "Price" },
                    e.Boq.Select(b => new TableRow(b, b.Item, Num(b.Qty) + " " + b.Unit,
                        b.TotalUgx is long t ? "UGX " + t.ToString("N0", CultureInfo.InvariantCulture) + " · " + b.PriceStatus : b.Note.StartsWith("by the") ? "by the engineer" : "price needed"))),
                new NoteSetting((e.PricedTotalUgx > 0 ? "Priced so far: UGX " + e.PricedTotalUgx.ToString("N0", CultureInfo.InvariantCulture) + "; " : "Nothing priced yet; ") +
                                e.PriceNeeded + " lines say \"price needed\". Missing prices are flagged, never invented.", ChipKind.Warn)));

            if (e.KitRequests.Count > 0)
                Groups.Add(new SettingsGroup("Kit change requests", e.KitRequests.Select(k => (SettingItem)new NoteSetting(k, ChipKind.Warn)).ToArray()));

            Groups.Add(new SettingsGroup("Send",
                new NoteSetting(@"Make ceiling pack writes the set-out, the BoQ and the checks as CSV into <project>\01_WIP\_Ceilings\<date>_<room>_<design>, a new folder each time, after a dry run you see first.", ChipKind.Info),
                new TableSetting("", new[] { "Output", "Format", "State" }, new[]
                {
                    new TableRow(null, "Board set-out", "CSV", "Now"),
                    new TableRow(null, "Bill of quantities", "CSV (Excel)", "Now"),
                    new TableRow(null, "Checks", "CSV", "Now"),
                    new TableRow(null, "Reflected ceiling plan (VT_I_RCP 1:50)", "Sheet", "With CL4"),
                    new TableRow(null, "Set-out drawing and section details", "PDF, sheet", "With CL4"),
                }),
                new ButtonsSetting("", new[] { new SettingButton("Make ceiling pack", PackCommand, primary: true) }),
                _messages));
        }

        // ---------- actions ----------

        public Task Propose() => Propose(stay: false);

        private async Task Propose(bool stay)
        {
            var q = Request();
            var missing = Missing(q);
            if (missing != null) { _messages.Show(ChipKind.Warn, missing); _status(missing); Rebuild(); return; }
            Designs = await _tools.DesignsAsync(q);
            Evaluation = null;
            if (!Designs.Ok) { _messages.Show(ChipKind.Bad, Designs.Message); _status(Designs.Message); Rebuild(); return; }
            var text = Designs.Options.Count + " designs for " + q.Room + "; " + (Designs.Options.FirstOrDefault(o => o.Recommended) is CeilingOption r ? "design " + r.Id + " recommended." : "none without a check to fix.");
            _messages.Show(ChipKind.Info, text);
            _status(text);
            if (stay) { await Evaluate(q); Rebuild(); return; }
            Go(1);
        }

        private async Task Evaluate(CeilingRequest q)
        {
            if (Design.Length == 0) return;
            Evaluation = await _tools.EvaluateAsync(q, Design);
            if (Evaluation.Ok) _messages.Show(ChipKind.Info, Evaluation.Message);
            else _messages.Show(ChipKind.Warn, Evaluation.Message);
        }

        private async Task Use(string design)
        {
            if (Designs == null || !Designs.Ok) { Go(0); return; }
            var q = Request();
            await Evaluate(q);
            _status(Evaluation?.Message ?? "");
            Go(2);
        }

        private async Task Apply()
        {
            var q = Request();
            var missing = Missing(q);
            if (missing != null) { _messages.Show(ChipKind.Warn, missing); Rebuild(); return; }
            var keep = Design;
            Designs = await _tools.DesignsAsync(q);
            if (!Designs.Ok) { _messages.Show(ChipKind.Bad, Designs.Message); Rebuild(); return; }
            if (Designs.Options.All(o => o.Kind != keep))
            {
                Evaluation = null;
                _messages.Show(ChipKind.Warn, "This design isn't possible with these changes: pick another on step 2.");
                Rebuild();
                return;
            }
            Evaluation = await _tools.EvaluateAsync(q, keep);
            var text = Evaluation.Ok
                ? $"Applied in the pane: {Evaluation.Sheets} sheets, {Num(Evaluation.BoardM2)} m² of board, heights {Evaluation.HeightsText()}. The model changes when the ceiling is placed (CL2)."
                : Evaluation.Message;
            _messages.Show(Evaluation.Ok ? ChipKind.Good : ChipKind.Warn, text);
            _status(text);
            Rebuild();
        }

        private Task Pack()
        {
            if (Evaluation == null || !Evaluation.Ok) { _messages.Show(ChipKind.Warn, "Use a design first (step 2)."); Rebuild(); return Task.CompletedTask; }
            var folder = _project.Request().Folder;
            if (folder.Length == 0)
            {
                _messages.Show(ChipKind.Warn, @"Set the project folder in Setup › Project: the pack goes into its 01_WIP\_Ceilings.");
                _status("Set the project folder first.");
                Rebuild();
                return Task.CompletedTask;
            }
            return PackDry(folder);
        }

        private async Task PackDry(string folder)
        {
            var q = Request();
            var design = Design;
            var dry = await _tools.PackAsync(q, design, folder, dryRun: true);
            _messages.Show(dry.Messages);
            if (!dry.Ok) { _status(dry.Messages.FirstOrDefault()?.Text ?? "The pack was refused."); Rebuild(); return; }
            Rebuild();
            _ask(DialogViewModel.WithItems("Make the ceiling pack?", q.Room + " · design " + (Chosen?.Id ?? design) + ": " + dry.Files.Count + " files into " + dry.Folder + ".",
                new SettingItem[]
                {
                    new ReadOnlySetting("Will write", string.Join(Environment.NewLine, dry.Files), mono: true),
                    new NoteSetting("CSV files only, into a new folder in 01_WIP. Nothing is replaced or deleted. One log line.", ChipKind.Info),
                }, "Write the pack", async () =>
                {
                    var r = await _tools.PackAsync(q, design, folder, dryRun: false);
                    _messages.Show(r.Messages);
                    _status(r.Messages.FirstOrDefault()?.Text ?? "Done.");
                    Rebuild();
                    return null;
                }));
        }

        private void Place()
        {
            if (!_tools.CanPlace || Evaluation == null) return;
            _ = PlaceDry(Request(), Design);
        }

        private async Task PlaceDry(CeilingRequest q, string design)
        {
            var dry = await _tools.PlaceAsync(q, design, dryRun: true);
            _messages.Show(dry.Messages);
            if (!dry.Ok) { Rebuild(); return; }
            _ask(DialogViewModel.WithItems("Place the ceiling?", "The dry run placed it and rolled back.",
                new SettingItem[] { new ReadOnlySetting("Will place", string.Join(Environment.NewLine, dry.Details), mono: true) },
                "Place", async () =>
                {
                    var r = await _tools.PlaceAsync(q, design, dryRun: false);
                    _messages.Show(r.Messages);
                    Rebuild();
                    return null;
                }));
        }

        private void ChooseFixtures()
        {
            var current = (_store.Get("ceilings.fixtures") ?? "").Trim();
            string start = "";
            try { start = current.Length > 0 ? System.IO.Path.GetDirectoryName(current) ?? "" : ""; } catch (ArgumentException) { }
            var file = _picker.Open("Ceiling fixtures", "Fixtures (*.json)|*.json", start);
            if (file != null) { _store.Set("ceilings.fixtures", file); Rebuild(); }
        }

        private void AskClaude()
        {
            var text = _question.Value.Trim();
            if (text.Length == 0) { _status("Type a question first."); return; }
            if (_askClaude == null) { _status("Ask Claude isn't available here."); return; }
            var q = Request();
            _question.Value = "";
            _askClaude("About the ceiling" + (q.Room.Length > 0 ? " in " + q.Room : "") + (Chosen != null ? " (design " + Chosen.Id + ", " + Chosen.Label + ")" : "") + ": " + text);
        }

        private static string Cap(string s) => s.Length == 0 ? s : char.ToUpperInvariant(s[0]) + s.Substring(1);
        private static string Num(double v) => v.ToString("0.##", CultureInfo.InvariantCulture);
    }

    internal static class CeilingText
    {
        public static string HeightsText(this CeilingEvaluation e) => string.Join(" / ", e.Heights);
    }
}
