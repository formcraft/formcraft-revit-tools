using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>
    /// Setup › Templates (board manage/PaneTemplates, U14): new files from the kit's templates, the firm look (brand
    /// pack), template audit, the template library and the settings new projects start with; then the files open in
    /// Revit. Every change is a dry run, a yes, then the run (fmc_file, fmc_template).
    /// </summary>
    public sealed class TemplatesPage : SectionPage
    {
        public static readonly string[] Kinds = { "Project model", "Family", "Detail file", "Title block" };
        public static readonly string[] ShowOptions = { "All", "Must", "Should", "Advice" };

        private readonly IFileTools _files;
        private readonly ITemplateTools _templates;
        private readonly IFilePicker _picker;
        private readonly IUserSettings _settings;
        private readonly SettingStore _store;
        private readonly ProjectPage _project;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly DocumentListSetting _docs = new DocumentListSetting();
        private readonly MessagesSetting _messages = new MessagesSetting();
        private readonly MessagesSetting _brandMessages = new MessagesSetting();
        private readonly MessagesSetting _auditMessages = new MessagesSetting();
        private AuditResult? _audit;

        public TemplatesPage(IFileTools files, ITemplateTools templates, IFilePicker picker, IUserSettings settings, ProjectPage project,
                             Action<string> status, Action<DialogViewModel> ask)
            : base("Setup › Templates", "New files from the kit's templates, the firm look, template audits and the template library.")
        {
            _files = files;
            _templates = templates;
            _picker = picker;
            _settings = settings;
            _store = new SettingStore(settings);
            _project = project;
            _status = status;
            _ask = ask;
            NewFileCommand = new AsyncCommand(NewFile, status);
            ApplyLookCommand = new AsyncCommand(ApplyLook, status);
            AuditCommand = new AsyncCommand(Audit, status);
            ArchiveCommand = new AsyncCommand(Archive, status);
            _files.Changed += (_, __) => ShowDocuments();
            Rebuild();
        }

        public ICommand NewFileCommand { get; }
        public ICommand ApplyLookCommand { get; }
        public ICommand AuditCommand { get; }
        public ICommand ArchiveCommand { get; }
        public DocumentListSetting Documents => _docs;
        public MessagesSetting Messages => _messages;
        public MessagesSetting BrandMessages => _brandMessages;
        public AuditResult? LastAudit => _audit;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("New file", NewFileCommand, primary: true),
            new FooterAction("Apply look", ApplyLookCommand),
            new FooterAction("Audit", AuditCommand),
        };

        public override void Opened() => Rebuild();

        private string Kit => _settings.Get(SettingKeys.KitFolder) ?? "";
        private string Kind => _store.Get("templates.kind") ?? Kinds[0];
        private bool IsModel => Kind == Kinds[0];

        public void Rebuild()
        {
            Groups.Clear();
            var library = KitLibrary.Templates(Kit);
            var packs = KitLibrary.BrandPacks(Kit);
            Groups.Add(NewFileGroup(library));
            Groups.Add(BrandGroup(library, packs));
            Groups.Add(AuditGroup(library, packs));
            Groups.Add(new SettingsGroup("Build",
                new NoteSetting("The template builder (Revit versions, full or starter, role templates, project types; parameters, keynotes, " +
                                "filters, view templates, schedules, sheets and browser) is its own piece of work and comes after the Manage sections. " +
                                "Builds land in 06_Templates\\_Staging.")));
            Groups.Add(LibraryGroup(library));
            Groups.Add(new SettingsGroup("Keep projects in step · Phase 2",
                new NoteSetting("Pushes view templates, styles and filters to live projects on an older template; never geometry. Preview first, " +
                                "then the project's Lead approves. Arrives in Phase 2.")));
            Groups.Add(new SettingsGroup("Saved settings for new projects",
                new ReadOnlySetting("Units", "mm · m² (2 dp) · m³ (3 dp) · ° (2 dp)", hint: "Fixed by the Manual."),
                new ChoiceSetting(_store, "templates.titleblock", "Title block", new[] { "FMC_TitleBlock · A1", "FMC_TitleBlock · A3 site set" }, dropdown: true),
                new ChoiceSetting(_store, "templates.views", "Starting views", new[] { "Standard set by role", "Minimal (plans and 3D)" }),
                new ReadOnlySetting("Output folder", Path.Combine(Kit, "06_Templates", "_Staging"), mono: true, hint: "Builds land in staging.")));
            Groups.Add(new SettingsGroup("Files open in Revit",
                _docs,
                new ButtonsSetting("", new[] { new SettingButton("Archive a closed file…", ArchiveCommand) }),
                new NoteSetting("Nothing is deleted: Archive moves a file and its backups to _Archive. Workshared models are never saved by a tool."),
                _messages));
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "templates.considerations", _status)));
            ShowDocuments();
        }

        // ---------- New file from a template ----------

        private SettingsGroup NewFileGroup(IReadOnlyList<KitTemplate> library)
        {
            var items = new List<SettingItem>
            {
                new ChoiceSetting(_store, "templates.kind", "Make a", Kinds, changed: _ => Rebuild()),
                new ChoiceSetting(_store, "templates.clientkit", "Client Kit", ConnectViewModel.ClientKits, dropdown: true),
            };
            if (IsModel)
            {
                var roles = _project.Request().Roles.DefaultIfEmpty("A").ToArray();
                items.Add(new ChoiceSetting(_store, "templates.role", "Role", ProjectPage.Roles, Math.Max(0, Array.IndexOf(ProjectPage.Roles, roles[0])),
                    dropdown: true, changed: _ => Rebuild()));
                var names = library.Select(t => t.Name + (t.Staging ? " · staging" : " · released")).ToArray();
                if (names.Length == 0) items.Add(new NoteSetting("The kit has no templates in 06_Templates. Point to the kit in Settings › General.", ChipKind.Warn));
                else items.Add(new ChoiceSetting(_store, "templates.kittemplate", "Template", names, Math.Max(0, PreferredTemplate(library)), dropdown: true));
                var (name, folder) = ModelTarget();
                items.Add(new ReadOnlySetting("File name (from the naming rule)", name, mono: true));
                items.Add(new ReadOnlySetting("Save in", folder.Length == 0 ? "Set the project folder in Setup › Project" : folder, mono: true));
                items.Add(new ToggleSetting(_store, "templates.fillinfo", "Fill Project Information from the project", true,
                    "From Setup › Project: name, client, plot, district and the rest."));
            }
            else
            {
                items.Add(new TextSetting("Template", "", "Choose a family template (.rft)", store: _store, key: "templates.template", mono: true));
                items.Add(new ButtonsSetting("", new[] { new SettingButton("Browse…", new RelayCommand(BrowseTemplate)) }));
                items.Add(new TextSetting("Save as", "", "Choose where the family goes", store: _store, key: "templates.saveto", mono: true,
                    hint: "Library families FMC_[Role]_[CategoryToken]_[Description].rfa in _Staging; project families [Project]_[Role]_… in 01_WIP\\<Role>\\Families (D4)."));
                items.Add(new ButtonsSetting("", new[] { new SettingButton("Browse…", new RelayCommand(BrowseSave)) }));
            }
            items.Add(new ToggleSetting(_store, "templates.open", "Open it when made", false));
            items.Add(new ButtonsSetting("", new[] { new SettingButton("New file", NewFileCommand, primary: true) },
                "Made in a dry run first; nothing is overwritten without a second yes."));
            return new SettingsGroup("New file from a template", items.ToArray());
        }

        private int PreferredTemplate(IReadOnlyList<KitTemplate> library)
        {
            var role = _store.Get("templates.role") ?? _project.Request().Roles.DefaultIfEmpty("A").First();
            var i = library.ToList().FindIndex(t => !t.Staging && t.Family.Equals("FMC_" + role + "_Template", StringComparison.OrdinalIgnoreCase));
            return i >= 0 ? i : library.ToList().FindIndex(t => !t.Staging);
        }

        private KitTemplate? ChosenTemplate(IReadOnlyList<KitTemplate> library)
        {
            var chosen = _store.Get("templates.kittemplate");
            return library.FirstOrDefault(t => chosen != null && chosen.StartsWith(t.Name + " · ")) ?? library.ElementAtOrDefault(Math.Max(0, PreferredTemplate(library)));
        }

        /// <summary>The next free model name for the role in the project's 01_WIP\&lt;Role&gt;.</summary>
        public (string Name, string Folder) ModelTarget()
        {
            var q = _project.Request();
            var role = _store.Get("templates.role") ?? q.Roles.DefaultIfEmpty("A").First();
            string code = q.Code.Length > 0 ? q.Code : "[Project]";
            string folder = q.Folder.Length > 0 ? Path.Combine(q.Folder, "01_WIP", role) : "";
            int n = 1;
            string Name(int i) => $"{code}-{q.Originator}-{q.Volume}-{q.Level}-{q.Type}-{role}-{i:0000}.rvt";
            try { while (folder.Length > 0 && File.Exists(Path.Combine(folder, Name(n)))) n++; } catch { }
            return (Name(n), folder);
        }

        private void BrowseTemplate()
        {
            var path = _picker.Open("Choose a family template", "Family templates (*.rft)|*.rft", _files.StartFolder);
            if (path == null) return;
            _store.Set("templates.template", path);
            Rebuild();
        }

        private void BrowseSave()
        {
            var path = _picker.Save("Save the new family as", "Revit family (*.rfa)|*.rfa", "", _files.StartFolder);
            if (path == null) return;
            _store.Set("templates.saveto", path);
            Rebuild();
        }

        private Task NewFile()
        {
            bool open = (_store.Get("templates.open") ?? "false") == "true";
            FileRequest q;
            if (IsModel)
            {
                var library = KitLibrary.Templates(Kit);
                var template = ChosenTemplate(library);
                var (name, folder) = ModelTarget();
                if (template == null || folder.Length == 0 || name.StartsWith("[Project]"))
                {
                    _messages.Show(ChipKind.Warn, "Choose a kit template, and set the project folder and code in Setup › Project.");
                    return Task.CompletedTask;
                }
                q = new FileRequest
                {
                    Action = "create_from_template", Kind = "project", TemplatePath = template.Path, SavePath = Path.Combine(folder, name), CloseAfter = !open,
                    ProjectInfo = (_store.Get("templates.fillinfo") ?? "true") == "true" ? ProjectInfo() : new Dictionary<string, string>(),
                };
            }
            else
            {
                var template = (_store.Get("templates.template") ?? "").Trim();
                var save = (_store.Get("templates.saveto") ?? "").Trim();
                if (template.Length == 0 || save.Length == 0)
                {
                    _messages.Show(ChipKind.Warn, "Choose a family template and where to save the new family.");
                    return Task.CompletedTask;
                }
                q = new FileRequest { Action = "create_from_template", Kind = "family", TemplatePath = template, SavePath = save, CloseAfter = !open };
            }
            return Run(q, "Create " + Path.GetFileName(q.SavePath) + "?", "Create");
        }

        /// <summary>Project Information from Setup › Project, as fmc_project writes it.</summary>
        public Dictionary<string, string> ProjectInfo()
        {
            var q = _project.Request();
            var info = new Dictionary<string, string>
            {
                ["Project Number"] = q.Code,
                ["Project Name"] = q.Details.TryGetValue("FMC_Project_Name", out var n) ? n : "",
                ["Client Name"] = q.Details.TryGetValue("FMC_Client", out var c) ? c : "",
                ["Project Address"] = q.Details.TryGetValue("FMC_Site_Address", out var a) ? a : "",
                ["Project Status"] = q.Stage,
            };
            foreach (var kv in q.Details) info[kv.Key] = kv.Value;
            return info.Where(kv => kv.Value.Trim().Length > 0).ToDictionary(kv => kv.Key, kv => kv.Value);
        }

        // ---------- Firm look ----------

        private SettingsGroup BrandGroup(IReadOnlyList<KitTemplate> library, IReadOnlyList<BrandPack> packs)
        {
            if (packs.Count == 0)
                return new SettingsGroup("Firm look · brand pack",
                    new NoteSetting("The kit has no brand packs (06_Templates\\FMC_BrandPacks.json). A missing pack is a kit change request.", ChipKind.Warn));
            var staging = library.Where(t => t.Staging).Select(t => t.Name).ToArray();
            var pack = Pack(packs);
            return new SettingsGroup("Firm look · brand pack",
                new ChoiceSetting(_store, "templates.brand", "Brand pack", packs.Select(p => p.Name).ToArray(), dropdown: true, changed: _ => Rebuild()),
                new ReadOnlySetting("Main font", pack.MainFont),
                new ReadOnlySetting("Title font", pack.TitleFont.Length > 0 ? pack.TitleFont : pack.MainFont),
                staging.Length == 0
                    ? (SettingItem)new NoteSetting("No template in 06_Templates\\_Staging. The look is applied to staging templates only; released ones change through a new version.")
                    : new ChoiceSetting(_store, "templates.brandtarget", "Apply to", staging, dropdown: true),
                new ButtonsSetting("", new[] { new SettingButton("Apply look", ApplyLookCommand) },
                    "Text and dimension types take the pack's fonts; sizes stay at the standard (2.5 / 3.5 / 5 mm). A dry run shows every change first."),
                _brandMessages,
                new NoteSetting("Tag families, the title block, filter colours, fill patterns, line styles, schedules and the logo lockup follow with the template builder."));
        }

        private BrandPack Pack(IReadOnlyList<BrandPack> packs)
        {
            var name = _store.Get("templates.brand");
            return packs.FirstOrDefault(p => p.Name == name) ?? packs[0];
        }

        private async Task ApplyLook()
        {
            var packs = KitLibrary.BrandPacks(Kit);
            var staging = KitLibrary.Templates(Kit).Where(t => t.Staging).ToList();
            if (packs.Count == 0 || staging.Count == 0)
            {
                _brandMessages.Show(ChipKind.Warn, packs.Count == 0 ? "The kit has no brand packs." : "No template in 06_Templates\\_Staging to apply the look to.");
                return;
            }
            var pack = Pack(packs);
            var target = staging.FirstOrDefault(t => t.Name == _store.Get("templates.brandtarget")) ?? staging[0];
            var dry = await _templates.BrandAsync(target.Path, pack, true);
            if (!dry.Ok) { _brandMessages.Show(dry.Messages); return; }
            if (dry.Count == 0) { _brandMessages.Show(ChipKind.Good, target.Name + " already has the " + pack.Name + " fonts."); return; }
            _ask(DialogViewModel.WithItems("Apply the brand pack: preview", pack.Name + " on " + target.Name + ". Only fonts change; sizes stay.",
                new SettingItem[] { new ReadOnlySetting("Item · now → after", string.Join(Environment.NewLine, dry.Details), mono: true) }, "Apply to " + dry.Count,
                async () =>
                {
                    var r = await _templates.BrandAsync(target.Path, pack, false);
                    _brandMessages.Show(r.Messages);
                    _status(r.Messages.FirstOrDefault()?.Text ?? "Done.");
                    return null;
                }));
        }

        // ---------- Audit ----------

        private SettingsGroup AuditGroup(IReadOnlyList<KitTemplate> library, IReadOnlyList<BrandPack> packs)
        {
            var items = new List<SettingItem>();
            if (library.Count == 0) items.Add(new NoteSetting("The kit has no templates to audit.", ChipKind.Warn));
            else items.Add(new ChoiceSetting(_store, "templates.audittarget", "Template", library.Select(t => t.Name + " · " + t.Status.ToLowerInvariant()).ToArray(), dropdown: true));
            items.Add(new ReadOnlySetting("What the audit covers",
                "Shared parameters vs FMC_SharedParameters.txt · view templates and filters · fonts vs the brand pack · text and dimension styles · " +
                "title blocks and schedules · browser organisation · size, unused families, warnings"));
            items.Add(new ButtonsSetting("", new[] { new SettingButton("Audit", AuditCommand, primary: true) }, "Read-only: the template is opened in the background and closed again."));
            if (_audit != null)
            {
                items.Add(new ChoiceSetting(_store, "templates.show", "Show", ShowOptions, changed: _ => Rebuild()));
                var show = _store.Get("templates.show") ?? "All";
                items.Add(new CheckListSetting(_audit.Lines.Where(l => show == "All" || l.Severity == show)
                    .Select(l => new CheckRow(new HealthCheck(l.Area, l.Status, l.Kind, detail: l.Severity == "Pass" ? "" : l.Severity + ": " + l.Detail), null))));
            }
            items.Add(_auditMessages);
            return new SettingsGroup("Audit a template", items.ToArray());
        }

        private async Task Audit()
        {
            var library = KitLibrary.Templates(Kit);
            if (library.Count == 0) { _auditMessages.Show(ChipKind.Warn, "The kit has no templates to audit."); return; }
            var chosen = _store.Get("templates.audittarget");
            var target = library.FirstOrDefault(t => chosen != null && chosen.StartsWith(t.Name + " · ")) ?? library[0];
            var packs = KitLibrary.BrandPacks(Kit);
            _status("Auditing " + target.Name + "…");
            var r = await _templates.AuditAsync(target.Path, packs.Count > 0 ? Pack(packs) : null);
            _audit = r.Ok ? r : null;
            _auditMessages.Show(r.Ok ? ChipKind.Info : ChipKind.Bad, r.Message);
            _status(r.Message);
            Rebuild();
        }

        // ---------- Library ----------

        private SettingsGroup LibraryGroup(IReadOnlyList<KitTemplate> library) => new SettingsGroup("Template library",
            library.Count == 0
                ? (SettingItem)new NoteSetting("No templates in the kit's 06_Templates yet.")
                : new TableSetting("", new[] { "Template", "Version", "Status" }, library.Select(t => new TableRow(t, t.Family, t.Version, t.Status))),
            new ButtonsSetting("", new[]
            {
                new SettingButton("Compare two versions", new RelayCommand(() => _status("Compare two versions: lists what changed between two template versions (with the template builder)."))),
                new SettingButton("Publish to library", new RelayCommand(() => _status("Publishing from staging to 06_Templates is a people gate: the BIM Manager approves and moves it. No tool publishes."))),
            }),
            new NoteSetting("Publishing from staging to 06_Templates is a people gate: the BIM Manager approves."));

        // ---------- Files open in Revit ----------

        public void ShowDocuments()
        {
            _docs.Rows.Clear();
            foreach (var d in _files.Documents)
                _docs.Rows.Add(new DocumentRow(d, new AsyncCommand(() => SaveAs(d), _status), new AsyncCommand(() => Close(d), _status)));
            _docs.Changed();
        }

        private Task SaveAs(OpenDocument doc)
        {
            string ext = doc.IsFamily ? ".rfa" : doc.Path.EndsWith(".rte", StringComparison.OrdinalIgnoreCase) ? ".rte" : ".rvt";
            var path = _picker.Save("Save " + doc.Title + " as", "Revit file (*" + ext + ")|*" + ext,
                Path.GetFileNameWithoutExtension(doc.Title) + ext, _files.StartFolder);
            if (path == null) return Task.CompletedTask;
            return Run(new FileRequest { Action = "save_as", Document = doc.Reference, SavePath = path },
                "Save " + doc.Title + " as " + Path.GetFileName(path) + "?", "Save");
        }

        private Task Close(OpenDocument doc)
        {
            if (!doc.IsModified) return Run(new FileRequest { Action = "close", Document = doc.Reference }, null, null);
            var form = new InMemoryUserSettings();
            var options = doc.IsWorkshared || string.IsNullOrEmpty(doc.Path) ? new[] { "Close without saving" } : new[] { "Close without saving", "Save and close" };
            var choice = new ChoiceSetting(new SettingStore(form, ""), "how", "It has unsaved changes", options);
            _ask(DialogViewModel.WithItems("Close " + doc.Title + "?", "", new SettingItem[] { choice }, "Close", async () =>
            {
                await Run(new FileRequest { Action = "close", Document = doc.Reference, Save = choice.Selected == "Save and close" }, null, null);
                return null;
            }));
            return Task.CompletedTask;
        }

        private Task Archive()
        {
            var path = _picker.Open("Archive a closed file (moves it and its backups to _Archive)", "Revit files (*.rvt;*.rfa;*.rte)|*.rvt;*.rfa;*.rte", _files.StartFolder);
            if (path == null) return Task.CompletedTask;
            return Run(new FileRequest { Action = "archive", Path = path }, "Archive " + Path.GetFileName(path) + "?", "Archive");
        }

        /// <summary>
        /// fmc_file the way any AI must use it: a dry run; an existing target asks for a second yes; then the question
        /// (none for closing a file the person already chose to close), then the real run.
        /// </summary>
        public async Task Run(FileRequest request, string? confirmTitle, string? confirmLabel)
        {
            _status("Dry run…");
            var dry = await _files.RunAsync(request, true);
            if (!dry.Ok && dry.NeedsOverwrite)
            {
                _ask(DialogViewModel.WithItems("Replace the existing file?", request.SavePath,
                    new SettingItem[] { new NoteSetting("The file already exists. Replacing it needs a second yes.", ChipKind.Warn) }, "Replace", async () =>
                    {
                        request.Overwrite = true;
                        await Run(request, confirmTitle, confirmLabel);
                        return null;
                    }));
                return;
            }
            if (!dry.Ok) { _messages.Show(dry.Messages); _status(dry.Messages.FirstOrDefault()?.Text ?? "Refused."); return; }
            if (confirmTitle == null) { await RunForReal(request); return; }
            _status("Dry run passed. Nothing has changed yet.");
            _ask(DialogViewModel.WithItems(confirmTitle, "The dry run passed the folder rules and name checks. Run it for real?",
                new SettingItem[] { new ReadOnlySetting("Will do", string.Join(Environment.NewLine, dry.Details), mono: true) }, confirmLabel ?? "Run",
                async () => { await RunForReal(request); return null; }));
        }

        private async Task RunForReal(FileRequest request)
        {
            _status("Working in Revit…");
            var r = await _files.RunAsync(request, false);
            _messages.Show(r.Messages);
            _status(r.Messages.FirstOrDefault()?.Text ?? "Done.");
            ShowDocuments();
        }
    }
}
