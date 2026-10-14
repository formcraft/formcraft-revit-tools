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
    /// Team › Links (board manage/PaneLinks, U20): the model's coordinates (read-only), every link audited against the
    /// Manual (02_Shared only, by shared coordinates, pinned, overlay, relative path, Z_Links_&lt;Role&gt;), linking models
    /// from 02_Shared and pinning, each after a dry run and refused on live projects. Coordinates never move from here.
    /// </summary>
    public sealed class LinksPage : SectionPage
    {
        private readonly ILinkTools _tools;
        private readonly ProjectPage _project;
        private readonly IFilePicker _picker;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private LinkAudit? _audit;

        public LinksPage(ILinkTools tools, ProjectPage project, IFilePicker picker, IUserSettings settings, Action<string> status, Action<DialogViewModel> ask)
            : base("Team › Links", "Every model on one coordinate system: linked from 02_Shared by shared coordinates, pinned and audited.")
        {
            _tools = tools;
            _project = project;
            _picker = picker;
            _store = new SettingStore(settings);
            _status = status;
            _ask = ask;
            AuditCommand = new AsyncCommand(Audit, status);
            LinkCommand = new AsyncCommand(Link, status);
            PinCommand = new AsyncCommand(Pin, status);
            Rebuild();
        }

        public ICommand AuditCommand { get; }
        public ICommand LinkCommand { get; }
        public ICommand PinCommand { get; }
        public LinkAudit? LastAudit => _audit;
        public MessagesSetting Messages => _messages;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("Audit", AuditCommand, primary: true),
            new FooterAction("Link…", LinkCommand),
            new FooterAction("Pin all", PinCommand),
        };

        public override void Opened() { if (_audit == null) _ = Audit(); else Rebuild(); }

        /// <summary>Link from: the folder chosen here, else the project's 02_Shared.</summary>
        public string LinkFrom()
        {
            var chosen = (_store.Get("links.from") ?? "").Trim();
            if (chosen.Length > 0) return chosen;
            var folder = _project.Request().Folder;
            return folder.Length == 0 ? "" : Path.Combine(folder, "02_Shared");
        }

        public void Rebuild()
        {
            Groups.Clear();
            var a = _audit;
            Groups.Add(new SettingsGroup("Coordinates",
                new ReadOnlySetting("Coordinate system", a == null ? "Audit to read it" : a.Crs.Length > 0 ? a.Crs : "FMC_CRS isn't set in Project Information",
                    hint: "Set from the surveyor's coordinate record (MAN 8.2)."),
                new ReadOnlySetting("Shared position of the project origin", a == null ? "" : $"E {a.Easting} · N {a.Northing} · Elev {a.Elevation} mm", mono: true),
                new ReadOnlySetting("Angle to true north · site", a == null ? "" : a.Angle + "° · " + a.Site)));

            var links = new List<SettingItem>
            {
                new ReadOnlySetting("Link from", LinkFrom().Length > 0 ? LinkFrom() : @"Set the project folder in Setup › Project, or choose a folder", mono: true,
                    hint: "Models in 02_Shared only (MAN 7.4)."),
                new ButtonsSetting("", new[] { new SettingButton("Choose folder…", new RelayCommand(Choose)), new SettingButton("Audit", AuditCommand, primary: true) }),
                new ReadOnlySetting("Positioning", "Auto – By Shared Coordinates", hint: "Fixed by the Manual (MAN 8.5)."),
                new ReadOnlySetting("Link workset", "Z_Links_<Role>", hint: a != null && !a.Workshared ? "This model isn't workshared: worksets don't apply." : "MAN 4.6"),
            };
            if (a != null)
            {
                if (a.Links.Count == 0) links.Add(new NoteSetting("No Revit links in this model yet."));
                else
                {
                    var table = new TableSetting("Linked models · " + a.Links.Count, new[] { "Model", "Pinned", "State" },
                        a.Links.Select(l => new TableRow(l, l.Model, l.Pinned ? "Yes" : "No", l.State)), selectable: true, hint: "Click a row to see what to fix.");
                    table.PropertyChanged += (_, e) =>
                    {
                        if (e.PropertyName == nameof(TableSetting.Selected) && table.Selected?.Tag is LinkLine l)
                            _status(l.Model + ": " + (l.Problems.Count > 0 ? string.Join(", ", l.Problems) : "as the Manual asks") + (l.Workset.Length > 0 ? " · " + l.Workset : ""));
                    };
                    links.Add(table);
                }
                if (a.FolderProblem.Length > 0) links.Add(new NoteSetting(a.FolderProblem, ChipKind.Warn));
            }
            links.Add(new ButtonsSetting("", new[] { new SettingButton("Link models…", LinkCommand), new SettingButton("Pin all", PinCommand) },
                "A dry run first, then a yes; refused on live projects."));
            links.Add(_messages);
            Groups.Add(new SettingsGroup("Links", links.ToArray()));

            Groups.Add(new SettingsGroup("Coordinate changes (guided)",
                new NoteSetting("Acquiring or publishing coordinates needs a preview and a Lead's or Admin's approval in the log. It comes with the team file (approvers); " +
                                "until then do it in Revit. Never by Claude and never on a schedule.", ChipKind.Warn)));
            Groups.Add(new SettingsGroup("Sync master data and keynotes",
                new NoteSetting("Writing master data and keynotes into types (preview, CSV change log) comes once the master data file's shape is confirmed.")));
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "links.considerations", _status)));
        }

        private void Choose()
        {
            var folder = _picker.Folder("Link models from", LinkFrom());
            if (folder == null) return;
            _store.Set("links.from", folder);
            _ = Audit();
        }

        private async Task Audit()
        {
            _status("Reading links…");
            var a = await _tools.AuditAsync(LinkFrom());
            _audit = a.Ok ? a : null;
            _messages.Show(a.Ok ? (a.Links.Any(l => l.Problems.Count > 0) ? ChipKind.Warn : ChipKind.Info) : ChipKind.Bad, a.Message);
            _status(a.Message);
            Rebuild();
        }

        private async Task Link()
        {
            if (_audit == null) await Audit();
            var choices = _audit?.Candidates.Where(c => !c.Linked && !c.Own).ToList() ?? new List<LinkCandidate>();
            if (choices.Count == 0)
            {
                _messages.Show(ChipKind.Info, LinkFrom().Length == 0 ? "Choose the folder to link from first." : "No models to link in " + LinkFrom() + ".");
                return;
            }
            var form = new InMemoryUserSettings();
            var fs = new SettingStore(form, "");
            var pick = new MultiSetting(fs, "models", "Models", choices.Select(c => c.Name).ToArray(), choices.Select(c => c.Name), asChecks: true);
            var pin = new ToggleSetting(fs, "pin", "Pin after linking", true);
            _ask(DialogViewModel.WithItems("Link models from 02_Shared", "Auto – By Shared Coordinates, on Z_Links_<Role>.", new SettingItem[] { pick, pin }, "Preview", async () =>
            {
                var paths = choices.Where(c => pick.On.Contains(c.Name)).Select(c => c.Path).ToList();
                if (paths.Count == 0) return "Tick at least one model.";
                bool p = pin.IsOn;
                var dry = await _tools.LinkAsync(paths, p, true);
                if (!dry.Ok) return dry.Messages.FirstOrDefault()?.Text ?? "Refused.";
                _ask(DialogViewModel.WithItems("Link " + paths.Count + " models?", "This changes the model.",
                    new SettingItem[] { new ReadOnlySetting("Will do", string.Join(Environment.NewLine, dry.Details), mono: true) }, "Link", async () =>
                    {
                        var r = await _tools.LinkAsync(paths, p, false);
                        _messages.Show(r.Messages);
                        _status(r.Messages.FirstOrDefault()?.Text ?? "Linked.");
                        await Audit();
                        return null;
                    }));
                return null;
            }));
        }

        private async Task Pin()
        {
            var dry = await _tools.PinAsync(true);
            if (!dry.Ok) { _messages.Show(dry.Messages); return; }
            if (dry.Details.Count == 0) { _messages.Show(ChipKind.Good, "Every link is pinned."); _status("Every link is pinned."); return; }
            _ask(DialogViewModel.WithItems("Pin " + dry.Details.Count + " links?", "Pinned links can't be moved by accident.",
                new SettingItem[] { new ReadOnlySetting("Will pin", string.Join(Environment.NewLine, dry.Details), mono: true) }, "Pin", async () =>
                {
                    var r = await _tools.PinAsync(false);
                    _messages.Show(r.Messages);
                    _status(r.Messages.FirstOrDefault()?.Text ?? "Pinned.");
                    await Audit();
                    return null;
                }));
        }
    }
}
