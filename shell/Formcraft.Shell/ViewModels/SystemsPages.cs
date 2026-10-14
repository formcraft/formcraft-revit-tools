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
    /// What each building system can do today, said honestly: a system is covered only when all seven capabilities work
    /// end to end on a real client model (board model/PaneModelSystems). Updated as each capability ships.
    /// </summary>
    public static class SystemCapabilities
    {
        public static readonly string[] Disciplines = { "Electrical", "ELV", "Fire", "Plumbing", "Mechanical", "Special" };
        public static readonly string[] Capabilities = { "1 Enrich", "2 Size", "3 Diagram", "4 Calculate", "5 Review calcs", "6 Quantities", "7 Document" };

        public static readonly IReadOnlyDictionary<string, string[]> Systems = new Dictionary<string, string[]>
        {
            ["Electrical"] = new[] { "Power distribution", "Small power", "Lighting", "Generator and standby" },
            ["ELV"] = new[] { "Data and telecoms", "CCTV and access control", "Audio-visual" },
            ["Fire"] = new[] { "Fire alarm", "Sprinklers and hose reels", "Emergency lighting" },
            ["Plumbing"] = new[] { "Cold water", "Hot water", "Drainage", "Rainwater" },
            ["Mechanical"] = new[] { "Ventilation", "Air conditioning", "Gas" },
            ["Special"] = new[] { "Lightning protection", "Solar PV" },
        };

        /// <summary>The status of one capability for one system: Built, Partly, Waits on the kit, or Planned.</summary>
        public static string Status(string system, string capability)
        {
            bool power = system == "Power distribution" || system == "Small power" || system == "Lighting";
            if (power && capability == "4 Calculate") return "Partly";
            if (system == "Power distribution" && (capability == "1 Enrich" || capability == "2 Size")) return "Waits on the kit";
            return "Planned";
        }

        public static int Done(string system) => Capabilities.Count(c => Status(system, c) == "Built");
    }

    /// <summary>
    /// Engineer › Systems (board model/PaneModelSystems, U25): pick a discipline and a system, see its seven capabilities
    /// with honest status, and run the read-only electrical check (boards, loads, circuits, feeders). Formcraft prepares
    /// and checks; sizing and design stay with the engineer.
    /// </summary>
    public sealed class SystemsPage : SectionPage
    {
        private readonly ISystemTools _tools;
        private readonly ProjectPage _project;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private SystemsCheck? _last;

        public SystemsPage(ISystemTools tools, ProjectPage project, IUserSettings settings, Action<string> status)
            : base("Engineer › Systems", "Each building system's seven capabilities, and the checks that run on this model.")
        {
            _tools = tools;
            _project = project;
            _store = new SettingStore(settings);
            _status = status;
            CheckCommand = new AsyncCommand(() => Check(false), status);
            SaveCommand = new AsyncCommand(() => Check(true), status);
            Rebuild();
        }

        public ICommand CheckCommand { get; }
        public ICommand SaveCommand { get; }
        public SystemsCheck? Last => _last;

        public override IEnumerable<FooterAction> Footer => Discipline == "Electrical"
            ? new[] { new FooterAction("Save the list", SaveCommand), new FooterAction("Check (read only)", CheckCommand, primary: true) }
            : new FooterAction[0];

        public string Discipline => _store.Get("systems.discipline") ?? SystemCapabilities.Disciplines[0];

        public string System
        {
            get
            {
                var list = SystemCapabilities.Systems[Discipline];
                var s = _store.Get("systems.system");
                return list.Contains(s) ? s! : list[0];
            }
        }

        public void Rebuild()
        {
            Groups.Clear();
            var systems = SystemCapabilities.Systems[Discipline];
            var table = new TableSetting("", new[] { "System", "Done", "Status" },
                systems.Select(s => new TableRow(s, s, SystemCapabilities.Done(s) + " of 7",
                    SystemCapabilities.Capabilities.Any(c => SystemCapabilities.Status(s, c) != "Planned") ? "Partly" : "Planned")), selectable: true);
            table.Selected = table.Rows.FirstOrDefault(r => (string?)r.Tag == System);
            table.PropertyChanged += (_, e) =>
            {
                if (e.PropertyName != nameof(TableSetting.Selected) || !(table.Selected?.Tag is string s) || s == System) return;
                _store.Set("systems.system", s);
                Rebuild();
            };
            Groups.Add(new SettingsGroup("System",
                new ChoiceSetting(_store, "systems.discipline", "Discipline", SystemCapabilities.Disciplines, changed: _ => { _store.Set("systems.system", null); _last = null; Rebuild(); }),
                table,
                new NoteSetting("A system is covered only when all seven capabilities work end to end on a real client model.", ChipKind.Grey)));
            Groups.Add(new SettingsGroup("Seven capabilities · " + System,
                new TableSetting("", new[] { "Capability", "Status" }, SystemCapabilities.Capabilities.Select(c => new TableRow(c, c, SystemCapabilities.Status(System, c))))));

            if (Discipline == "Electrical")
            {
                var run = new List<SettingItem>
                {
                    new NoteSetting("Read-only: boards with their connected and demand loads, circuits and the circuit that feeds each; devices on no circuit; circuits on no board. Nothing is changed.", ChipKind.Info),
                    new ButtonsSetting("", new[] { new SettingButton("Save the list", SaveCommand), new SettingButton("Check (read only)", CheckCommand, primary: true) }),
                    _messages,
                };
                Groups.Add(new SettingsGroup("Run on this model", run.ToArray()));
                if (_last != null && _last.Ok)
                {
                    Groups.Add(new SettingsGroup("Board manager · " + _last.Model,
                        _last.Boards.Count == 0 ? (SettingItem)new NoteSetting("No electrical equipment in this model.")
                            : new TableSetting("", new[] { "Board", "Load kVA", "Circuits", "Fed by", "Check" },
                                _last.Boards.Select(b => new TableRow(b, b.Name, Kva(b.ConnectedVa) + " / " + Kva(b.DemandVa), b.Circuits.ToString(), b.FedBy.Length > 0 ? b.FedBy : "—", b.Check)),
                                hint: "Load: connected / demand, from Revit's own panel values."),
                        new TableSetting("Checks", new[] { "Check", "Found", "Result" }, _last.Checks.Select(c => new TableRow(c, c.Check, c.Found, c.State)))));
                }
                Groups.Add(new SettingsGroup("Enrich and Size · FormCraft Electrical 0.1",
                    new NoteSetting("Enrich Data and Size Feeders are built (FormCraft Electrical 0.1), but they write 16 FMC_ parameters the kit doesn't have yet " +
                                    "(FMC_Load_VA, FMC_Voltage, FMC_Conductor_Size and others). They join the add-in once the kit adds them: the kit wins (rule 7).", ChipKind.Warn)));
            }
            else
                Groups.Add(new SettingsGroup("Run on this model", new NoteSetting(Discipline + ": no tools yet. Each capability arrives with a dry run and the same control layer as Manage.", ChipKind.Grey)));

            Groups.Add(new SettingsGroup("Hand-offs to Manage",
                new NoteSetting("Diagram sheets go to Drawings › Sheets, calculation reports join Ready to issue, and quantities feed Check › Reports, as each capability ships.", ChipKind.Grey)));
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "systems.considerations", _status)));
        }

        private static string Kva(double va) => (va / 1000).ToString("0.0", CultureInfo.InvariantCulture);

        private async Task Check(bool save)
        {
            var folder = _project.Request().Folder;
            _last = await _tools.ElectricalAsync(folder, save);
            if (!_last.Ok) _messages.Show(ChipKind.Bad, _last.Message);
            else _messages.Show(save && _last.Saved.Length > 0 ? ChipKind.Good : ChipKind.Info, save && _last.Saved.Length > 0 ? "Saved for the engineer: " + _last.Saved : _last.Message);
            _status(_last.Ok ? _last.Message : _last.Message);
            Rebuild();
        }
    }

    /// <summary>
    /// Engineer › Structural (board model/PaneModelStructural, U25): the seven steps with honest status, the read-only
    /// analytical model check, and analysis results already in the model. Formcraft never sizes or changes a structural
    /// member: the engineer decides (CLAUDE.md rule 5).
    /// </summary>
    public sealed class StructuralPage : SectionPage
    {
        public static readonly (string Step, string Status)[] Steps =
        {
            ("1 Enrich: grades, exposure class, member marks (kit fields)", "Check only: lists empty kit fields"),
            ("2 Analytical check: members joined, supports, offsets", "Partly"),
            ("3 Loads: cases and combinations (set by the engineer)", "Engineer"),
            ("4 Hand-off: the analytical model to the engineer's analysis software", "Planned"),
            ("5 Results back: sizes and utilisation, differences listed", "Partly: reads FMC_FEA_ results in the model"),
            ("6 Quantities: concrete m³ by grade, steel t, rebar BBS", "Planned"),
            ("7 Document: S sheet set, schedules, BBS", "Planned"),
        };

        private readonly ISystemTools _tools;
        private readonly ProjectPage _project;
        private readonly IUserSettings _settings;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private SystemsCheck? _last;

        public StructuralPage(ISystemTools tools, ProjectPage project, IUserSettings settings, Action<string> status)
            : base("Engineer › Structural", "Prepare and check the structural model; the engineer designs and signs.")
        {
            _tools = tools;
            _project = project;
            _settings = settings;
            _store = new SettingStore(settings);
            _status = status;
            CheckCommand = new AsyncCommand(() => Check(false), status);
            SaveCommand = new AsyncCommand(() => Check(true), status);
            Rebuild();
        }

        public ICommand CheckCommand { get; }
        public ICommand SaveCommand { get; }
        public SystemsCheck? Last => _last;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("Save the list", SaveCommand),
            new FooterAction("Check (read only)", CheckCommand, primary: true),
        };

        public void Rebuild()
        {
            Groups.Clear();
            Groups.Add(new SettingsGroup("Structural systems",
                new TableSetting("", new[] { "System", "Done", "Status" },
                    new[] { "Foundations (pads, strips, ground beams)", "RC frame (columns, beams, slabs)", "Steel frame (UB, UC, purlins)", "Roof (timber and steel trusses)", "Stairs and walls" }
                        .Select(s => new TableRow(s, s, "0 of 7", "Check only"))),
                new NoteSetting("A structural system is covered only when all seven steps work end to end on a real client model.", ChipKind.Grey)));
            Groups.Add(new SettingsGroup("Seven steps", new TableSetting("", new[] { "Step", "Status" }, Steps.Select(s => new TableRow(s, s.Step, s.Status)))));

            var check = new List<SettingItem>();
            if (_last != null && _last.Ok)
            {
                if (_last.Members.Length > 0) check.Add(new ReadOnlySetting("Checked", _last.Model + " · " + _last.Members));
                check.Add(new TableSetting("", new[] { "Check", "Found", "Result" }, _last.Checks.Select(c => new TableRow(c, c.Check, c.Found, c.State))));
                if (_last.NotInKit.Count > 0) check.Add(new NoteSetting("Not in the kit, so not checked: " + string.Join(", ", _last.NotInKit) + ".", ChipKind.Grey));
            }
            check.Add(new NoteSetting("Formcraft reports these; the engineer fixes or accepts them. Load cases and combinations are set per project by the engineer (Manual Part 12).", ChipKind.Info));
            check.Add(new ButtonsSetting("", new[] { new SettingButton("Save the list", SaveCommand), new SettingButton("Check (read only)", CheckCommand, primary: true) }));
            check.Add(_messages);
            Groups.Add(new SettingsGroup("Analytical model check", check.ToArray()));

            var results = new List<SettingItem>();
            if (_last == null) results.Add(new NoteSetting("Run the check to read the analysis results already in the model (FMC_FEA_Utilisation).", ChipKind.Grey));
            else if (_last.Results.Count == 0) results.Add(new NoteSetting("No analysis results in this model yet: they come back with the hand-off (step 4).", ChipKind.Grey));
            else results.Add(new TableSetting("", new[] { "Member", "Type", "Util.", "Run" },
                _last.Results.Select(r => new TableRow(r, r.Mark, r.Type, r.Utilisation.ToString("0.00", CultureInfo.InvariantCulture), r.Run))));
            results.Add(new NoteSetting("Section changes are the engineer's decision. Formcraft lists the differences; the engineer applies them in Revit. Claude never changes a structural section.", ChipKind.Warn));
            Groups.Add(new SettingsGroup("Results back from analysis", results.ToArray()));
            Groups.Add(new SettingsGroup("Hand-offs to Manage",
                new NoteSetting("S sheets and schedules go to Drawings › Sheets, the design basis and calculation summary join Ready to issue, and quantities and the BBS feed Check › Reports, as each step ships.", ChipKind.Grey)));
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "structural.considerations", _status)));
        }

        private async Task Check(bool save)
        {
            var kit = _settings.Get(SettingKeys.KitFolder) ?? "";
            if (kit.Length == 0) { _messages.Show(ChipKind.Warn, "Set the kit folder in Settings › General first: the field names come from the kit."); return; }
            _last = await _tools.StructuralAsync(kit, _project.Request().Folder, save);
            if (!_last.Ok) _messages.Show(ChipKind.Bad, _last.Message);
            else _messages.Show(save && _last.Saved.Length > 0 ? ChipKind.Good : ChipKind.Info, save && _last.Saved.Length > 0 ? "Saved for the engineer: " + _last.Saved : _last.Message);
            _status(_last.Message);
            Rebuild();
        }
    }
}
