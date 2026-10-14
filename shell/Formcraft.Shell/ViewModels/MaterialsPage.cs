using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>
    /// Setup › Materials (board manage/PaneMaterials, U18): the firm's material database from the kit, assigning a
    /// material to types with a dry run first, the model's material audit and clean-up, and requests for new materials.
    /// Projects take materials from the database; they never invent their own. Assigning changes no geometry and runs
    /// where the live-model lock allows (templates and new projects).
    /// </summary>
    public sealed class MaterialsPage : SectionPage
    {
        public static readonly string[] Targets = { "Every type in a category", "By rule (type name contains …)", "Selected elements' types" };
        public static readonly string[] TargetKeys = { "category", "rule", "selection" };
        public static readonly string[] Categories = { "Floors", "Walls", "Ceilings", "Roofs", "Doors" };
        public static readonly string[] ParameterNames = { "Structure: finish layer", "Type material", "Family parameter: Finish" };
        public static readonly string[] ParameterKeys = { "finish_layer", "type_material", "family_finish" };

        private readonly IMaterialTools _tools;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly MessagesSetting _assignMessages = new MessagesSetting();
        private readonly MessagesSetting _auditMessages = new MessagesSetting();
        private readonly MessagesSetting _dbMessages = new MessagesSetting();
        private MaterialDatabase? _db;
        private DbMaterial? _selected;
        private List<MaterialCheck>? _audit;

        public MaterialsPage(IMaterialTools tools, IUserSettings settings, Action<string> status, Action<DialogViewModel> ask)
            : base("Setup › Materials", "Materials, textures and visualisation from one Formcraft material database.")
        {
            _tools = tools;
            _store = new SettingStore(settings);
            _status = status;
            _ask = ask;
            SearchCommand = new AsyncCommand(Load, status);
            AssignCommand = new AsyncCommand(Assign, status);
            AuditCommand = new AsyncCommand(Audit, status);
            PurgeCommand = new AsyncCommand(Purge, status);
            RequestCommand = new RelayCommand(AskRequest);
            UpdatesCommand = new AsyncCommand(async () => { var m = await _tools.UpdatesAsync(); _dbMessages.Show(ChipKind.Info, m); _status(m); }, status);
            Rebuild();
        }

        public ICommand SearchCommand { get; }
        public ICommand AssignCommand { get; }
        public ICommand AuditCommand { get; }
        public ICommand PurgeCommand { get; }
        public ICommand RequestCommand { get; }
        public ICommand UpdatesCommand { get; }
        public MaterialDatabase? Database => _db;
        public MessagesSetting AssignMessages => _assignMessages;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("Assign (dry run)", AssignCommand, primary: true),
            new FooterAction("Audit", AuditCommand),
        };

        public override void Opened() { if (_db == null) _ = Load(); }

        public async Task Load()
        {
            _db = await _tools.DatabaseAsync(_store.Get("materials.class") ?? "All", (_store.Get("materials.query") ?? "").Trim());
            if (_selected != null) _selected = _db.Materials.FirstOrDefault(m => m.Name == _selected.Name) ?? _selected;
            Rebuild();
        }

        /// <summary>Opens a material's details as if it was clicked.</summary>
        public void Select(string name)
        {
            _selected = _db?.Materials.FirstOrDefault(m => m.Name == name);
            Rebuild();
        }

        public void Rebuild()
        {
            Groups.Clear();
            Groups.Add(DatabaseGroup());
            if (_selected != null) Groups.Add(SelectedGroup(_selected));
            Groups.Add(AssignGroup());
            Groups.Add(AuditGroup());
            Groups.Add(new SettingsGroup("Visualise and schedule",
                new NoteSetting("The finish colour view (floors, walls and ceilings coloured by material, with a legend), the material takeoff and room " +
                                "finishes schedules, and sending quantities and cost codes to Build come with Build (U26)."),
                new ChoiceSetting(_store, "materials.style", "Visual style for reviews", new[] { "Realistic with textures", "Shaded with material colours", "Consistent colours" })));
            Groups.Add(new SettingsGroup("Database changes",
                new ButtonsSetting("", new[]
                {
                    new SettingButton("Request new material", RequestCommand),
                    new SettingButton("Check for database updates", UpdatesCommand),
                }, "A material made in a project is never added to the database directly: it goes to the BIM Manager as a change request with its textures."),
                _dbMessages));
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "materials.considerations", _status)));
        }

        private SettingsGroup DatabaseGroup()
        {
            if (_db == null) return new SettingsGroup("Formcraft material database", new NoteSetting("Reading the kit's material database…"));
            if (!_db.Ok) return new SettingsGroup("Formcraft material database", new NoteSetting(_db.Message, ChipKind.Warn),
                new ButtonsSetting("", new[] { new SettingButton("Try again", SearchCommand) }));
            var table = new TableSetting("", new[] { "Material", "Class", "Keynote" }, _db.Materials.Select(m => new TableRow(m, m.Name, m.Class, m.Keynote)), selectable: true,
                hint: "Each material carries graphics, an appearance with textures, identity data, a keynote and a cost code for Build.");
            table.PropertyChanged += (_, e) =>
            {
                if (e.PropertyName == nameof(TableSetting.Selected) && table.Selected?.Tag is DbMaterial m) { _selected = m; Rebuild(); }
            };
            return new SettingsGroup("Formcraft material database",
                new ReadOnlySetting("Database", $"{_db.File} · v{_db.Version} · {_db.Count} materials", mono: true),
                new ChoiceSetting(_store, "materials.class", "Class", new[] { "All" }.Concat(_db.Classes).ToArray(), changed: _ => { Task t = Load(); }),
                new TextSetting("Search", "", "Name or keynote", store: _store, key: "materials.query"),
                new ButtonsSetting("", new[] { new SettingButton("Search", SearchCommand) }),
                table);
        }

        private static SettingsGroup SelectedGroup(DbMaterial m) => new SettingsGroup("Selected · " + m.Name,
            new ReadOnlySetting("Class", m.Class + (m.Sub.Length > 0 ? " · " + m.Sub : "")),
            new ReadOnlySetting("Keynote", m.Keynote.Length > 0 ? m.Keynote : "—"),
            new ReadOnlySetting("Cost code (Build)", m.CostCode.Length > 0 ? m.CostCode : "—"),
            new ReadOnlySetting("Supplier", m.Supplier.Length > 0 ? m.Supplier : "—"),
            m.Maps.Count == 0 ? (SettingItem)new NoteSetting("No texture maps in the database for this material.")
                : new TableSetting("Appearance and textures", new[] { "Map", "File", "Size" }, m.Maps.Select(x => new TableRow(x, x.Map, x.File, x.Size))),
            new ReadOnlySetting("Graphics", m.Graphics.Length > 0 ? m.Graphics : "—"));

        private SettingsGroup AssignGroup()
        {
            var target = _store.Get("materials.target") ?? Targets[0];
            var items = new List<SettingItem>
            {
                new ReadOnlySetting("Material", _selected?.Name ?? "Pick one in the database above"),
                new ChoiceSetting(_store, "materials.target", "Assign to", Targets, dropdown: true, changed: _ => Rebuild()),
            };
            if (target != Targets[2]) items.Add(new ChoiceSetting(_store, "materials.category", "Category", Categories));
            if (target == Targets[1]) items.Add(new TextSetting("Type name contains", "", "e.g. Porcelain", store: _store, key: "materials.contains"));
            items.Add(new ChoiceSetting(_store, "materials.parameter", "Material parameter", ParameterNames));
            items.Add(new ButtonsSetting("", new[] { new SettingButton("Assign (dry run)", AssignCommand, primary: true) },
                "Setup class: runs on templates and new projects; on a live project the live-model lock refuses it. Geometry never changes."));
            items.Add(_assignMessages);
            return new SettingsGroup("Assign to elements · dry run first", items.ToArray());
        }

        private (string Target, string Category, string Contains, string Parameter) AssignInputs()
        {
            int t = Math.Max(0, Array.IndexOf(Targets, _store.Get("materials.target") ?? Targets[0]));
            int p = Math.Max(0, Array.IndexOf(ParameterNames, _store.Get("materials.parameter") ?? ParameterNames[0]));
            return (TargetKeys[t], _store.Get("materials.category") ?? Categories[0], (_store.Get("materials.contains") ?? "").Trim(), ParameterKeys[p]);
        }

        private async Task Assign()
        {
            if (_selected == null) { _assignMessages.Show(ChipKind.Warn, "Pick a material in the database first."); return; }
            var (target, category, contains, parameter) = AssignInputs();
            if (target == "rule" && contains.Length == 0) { _assignMessages.Show(ChipKind.Warn, "Say what the type name contains."); return; }
            var material = _selected.Name;
            var dry = await _tools.AssignAsync(material, target, category, contains, parameter, true);
            if (!dry.Ok) { _assignMessages.Show(ChipKind.Bad, dry.Message); return; }
            var changes = dry.Types.Where(x => !x.Change.StartsWith("skipped")).ToList();
            if (changes.Count == 0)
            {
                _assignMessages.Show(ChipKind.Warn, dry.Types.Count == 0 ? "No types match." : "No type can take it: " + dry.Types[0].Change + ".");
                return;
            }
            var lines = dry.Types.Select(x => $"{x.Type} · {x.Elements} elements · {x.Change}").ToList();
            if (dry.CreatesMaterial) lines.Insert(0, material + " is made in the model from the database first.");
            _ask(DialogViewModel.WithItems("Assign " + material + " · dry run", "Plan only: nothing changed. One Undo when applied; the log records before and after.",
                new SettingItem[] { new ReadOnlySetting("Type · elements · change", string.Join(Environment.NewLine, lines), mono: true) }, "Apply", async () =>
                {
                    var r = await _tools.AssignAsync(material, target, category, contains, parameter, false);
                    _assignMessages.Show(r.Ok ? ChipKind.Good : ChipKind.Bad, r.Message);
                    _status(r.Message);
                    return null;
                }));
        }

        private SettingsGroup AuditGroup()
        {
            var items = new List<SettingItem>();
            if (_audit != null)
            {
                items.Add(new CheckListSetting(_audit.Select(c => new CheckRow(new HealthCheck(c.Check, c.Found + " · " + c.Result, c.Kind,
                    detail: c.Found > 0 && c.Items.Count > 0 ? string.Join(", ", c.Items.Take(6)) + (c.Found > 6 ? "…" : "") : ""), null))));
            }
            items.Add(new ButtonsSetting("", new[]
            {
                new SettingButton(_audit == null ? "Audit this model" : "Audit again", AuditCommand, primary: _audit == null),
                new SettingButton("Purge unused", PurgeCommand),
            }, "The audit only reads. Purge runs a dry run first and is refused on live projects. Fixing texture paths and merging duplicates " +
               "come with the next Materials step; until then the audit lists them."));
            items.Add(_auditMessages);
            return new SettingsGroup("Audit this model", items.ToArray());
        }

        private async Task Audit()
        {
            _status("Auditing the model's materials…");
            var (ok, message, checks) = await _tools.AuditAsync();
            _audit = ok ? checks : null;
            _auditMessages.Show(ok ? ChipKind.Info : ChipKind.Bad, message);
            _status(message);
            Rebuild();
        }

        private async Task Purge()
        {
            var (ok, message, materials) = await _tools.PurgeAsync(true);
            if (!ok || materials.Count == 0) { _auditMessages.Show(ok ? ChipKind.Good : ChipKind.Bad, ok ? "Nothing to purge." : message); return; }
            _ask(DialogViewModel.WithItems("Material clean-up · dry run", "Purges " + materials.Count + " materials nothing in the model uses.",
                new SettingItem[] { new ReadOnlySetting("Would purge", string.Join(Environment.NewLine, materials), mono: true) }, "Purge " + materials.Count, async () =>
                {
                    var r = await _tools.PurgeAsync(false);
                    _auditMessages.Show(r.Ok ? ChipKind.Good : ChipKind.Bad, r.Message);
                    _status(r.Message);
                    return null;
                }));
        }

        private void AskRequest()
        {
            var form = new InMemoryUserSettings();
            var store = new SettingStore(form, "");
            var name = new TextSetting("Name", "", "FMC_[Group]_[Description]", store: store, key: "name");
            var detail = new TextSetting("Class, supplier and why", "", store: store, key: "text");
            _ask(DialogViewModel.WithItems("Request new material", "Textures go with the request to the BIM Manager.", new SettingItem[] { name, detail }, "Send request", async () =>
            {
                if ((form.Get("name") ?? "").Trim().Length == 0) return "Name the material.";
                var m = await _tools.RequestAsync(form.Get("name")!.Trim(), form.Get("text") ?? "");
                _dbMessages.Show(ChipKind.Good, m);
                _status(m);
                return null;
            }));
        }
    }
}
