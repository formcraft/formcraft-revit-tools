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
    /// Build in the pane (board build/PaneBuild, U26): open the workspace window, colour the active view by progress or
    /// package (real Revit view filters, board B_RevitViews), and see the bills from the model's quantities with what
    /// changed since the baseline. Quantities come from the model and the kit's codes; rates are the QS's and never show
    /// here. The data package and site changes come with the Build web workspace, a separate project.
    /// </summary>
    public sealed class BuildPage : SectionPage
    {
        public static readonly string[] ColourModes = { "Nothing", "Progress", "Package" };

        private readonly IBuildTools _tools;
        private readonly ProjectPage _project;
        private readonly IUserSettings _settings;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private readonly Action _openWorkspace;
        private readonly MessagesSetting _messages = new MessagesSetting();

        public BuildPage(IBuildTools tools, ProjectPage project, IUserSettings settings, Action<string> status, Action<DialogViewModel> ask, Action openWorkspace)
            : base("Build", "Quantities from the model, progress and package colours on real Revit views, and the workspace window.")
        {
            _tools = tools;
            _project = project;
            _settings = settings;
            _store = new SettingStore(settings);
            _status = status;
            _ask = ask;
            _openWorkspace = openWorkspace;
            MeasureCommand = new AsyncCommand(Measure, status);
            BaselineCommand = new AsyncCommand(AskBaseline, status);
            ColourCommand = new RelayCommand(Colour);
            OpenWorkspaceCommand = new RelayCommand(() => _openWorkspace());
            Rebuild();
        }

        public ICommand MeasureCommand { get; }
        public ICommand BaselineCommand { get; }
        public ICommand ColourCommand { get; }
        public ICommand OpenWorkspaceCommand { get; }
        public BuildQuantities? Last { get; private set; }

        /// <summary>Raised after each measure, so the workspace window refreshes too.</summary>
        public event EventHandler? Measured;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("Measure", MeasureCommand),
            new FooterAction("Open workspace", OpenWorkspaceCommand, primary: true),
        };

        public string Mode => _store.Get("build.colour") ?? "Progress";
        private string Kit => _settings.Get(SettingKeys.KitFolder) ?? "";

        public void Rebuild()
        {
            Groups.Clear();
            Groups.Add(new SettingsGroup("Build workspace",
                new NoteSetting("Build's main screen is the workspace window beside the model: BOQ, packages and progress. The pane keeps quick controls.", ChipKind.Info),
                new ButtonsSetting("", new[] { new SettingButton("Open workspace", OpenWorkspaceCommand, primary: true) })));

            var views = new List<SettingItem>
            {
                new ChoiceSetting(_store, "build.colour", "Colour the active view by", ColourModes, 1),
                new ButtonsSetting("", new[] { new SettingButton("Colour the active view", ColourCommand) }),
            };
            if (Last != null && Last.Ok && Last.Progress.Count > 0)
                views.Add(new TableSetting("Progress legend", new[] { "Status", "Elements" }, Last.Progress.Select(p => new TableRow(p, p.Value, p.Count.ToString("N0", CultureInfo.InvariantCulture)))));
            views.Add(new NoteSetting("View filters on FMC_Construction_Status and FMC_Trade_Package, so the view zooms, prints, goes on sheets and works with Flow touch. Revit asks first; one Undo.", ChipKind.Grey));
            Groups.Add(new SettingsGroup("Views on the model", views.ToArray()));

            var boq = new List<SettingItem>();
            if (Last == null) boq.Add(new NoteSetting("Measure reads the model's quantities by each type's FMC_Keynote_Code and the kit's codes. Read-only.", ChipKind.Grey));
            else if (!Last.Ok) boq.Add(new NoteSetting(Last.Message, ChipKind.Bad));
            else
            {
                boq.Add(new ReadOnlySetting("Measured", $"{Last.Model} · {Last.Elements:N0} elements · baseline {(Last.Baseline.Length > 0 ? Last.Baseline : "none yet")}"));
                boq.Add(new TableSetting("", new[] { "Bill", "Items", "Changed" }, Last.Bills.Select(b => new TableRow(b, b.Bill, b.Items.ToString(), b.Changed.ToString()))));
                if (Last.Unmapped.Count > 0)
                    boq.Add(new NoteSetting("No FMC_Keynote_Code, so not in the BOQ: " + string.Join(", ", Last.Unmapped.Select(u => $"{u.Count} {u.Category}")) + ". Nothing is dropped silently: the QS assigns or excludes them.", ChipKind.Warn));
                if (Last.UnknownCodes.Count > 0)
                    boq.Add(new NoteSetting("Codes the kit doesn't have: " + string.Join(", ", Last.UnknownCodes.Select(u => u.Code)) + ".", ChipKind.Warn));
                foreach (var p in Last.MissingParams) boq.Add(new NoteSetting(p + " isn't in this model yet: it comes with the kit's shared parameters.", ChipKind.Warn));
            }
            boq.Add(new NoteSetting("Quantities come from the model and the kit's codes; the QS prices in the workspace. Rates are never shown here.", ChipKind.Warn));
            boq.Add(new ButtonsSetting("", new[] { new SettingButton("Measure", MeasureCommand, primary: true), new SettingButton("Set as baseline", BaselineCommand) }));
            boq.Add(_messages);
            Groups.Add(new SettingsGroup("BOQ and quantities", boq.ToArray()));
            Groups.Add(new SettingsGroup("Data package",
                new NoteSetting("The project data package and site changes come with the Build web workspace, a separate project: changes reach the model only through preview, approval and one Undo.", ChipKind.Grey)));
            Groups.Add(new SettingsGroup("Author's considerations", new ConsiderationsSetting(_store, "build.considerations", _status)));
        }

        private bool Ready()
        {
            if (Kit.Length > 0) return true;
            _messages.Show(ChipKind.Warn, "Set the kit folder in Settings › General first: the codes come from the kit.");
            _status("Set the kit folder first.");
            return false;
        }

        public async Task Measure()
        {
            if (!Ready()) return;
            Last = await _tools.MeasureAsync(Kit, _project.Request().Folder);
            _messages.Show(Last.Ok ? ChipKind.Info : ChipKind.Bad, Last.Message);
            _status(Last.Message);
            Rebuild();
            Measured?.Invoke(this, EventArgs.Empty);
        }

        private Task AskBaseline()
        {
            if (!Ready()) return Task.CompletedTask;
            _ask(new DialogViewModel("Set as baseline", "Saves the model's quantities now as the baseline, for example at a BOQ issue. Later measures flag every quantity that moves from it. Nothing in the model changes.",
                "Save baseline", async () =>
                {
                    var r = await _tools.BaselineAsync(Kit, _project.Request().Folder);
                    _messages.Show(r.Messages);
                    _status(r.Messages.FirstOrDefault()?.Text ?? "Saved.");
                    await Measure();
                }));
            return Task.CompletedTask;
        }

        private void Colour()
        {
            _tools.ColourView(Mode);
            _status(Mode == "Nothing" ? "Build colours: Revit takes them off the active view." : "Build colours: Revit asks before colouring the active view by " + Mode.ToLowerInvariant() + ".");
        }
    }

    /// <summary>
    /// The Build workspace window (board build/B_Workspace): the same measure at full size: every BOQ item with its
    /// quantity and what changed, packages and progress. It floats beside the model or moves to a second monitor.
    /// </summary>
    public sealed class BuildWorkspacePage : SectionPage
    {
        public static readonly string[] Tabs = { "BOQ", "Packages", "Progress" };
        private readonly BuildPage _build;
        private readonly SettingStore _store;

        public BuildWorkspacePage(BuildPage build, IUserSettings settings)
            : base("Formcraft Build", "BOQ, packages and progress from the model.")
        {
            _build = build;
            _store = new SettingStore(settings);
            build.Measured += (_, __) => Rebuild();
            Rebuild();
        }

        public override IEnumerable<FooterAction> Footer => new[] { new FooterAction("Measure", _build.MeasureCommand, primary: true) };

        public void Rebuild()
        {
            Groups.Clear();
            var q = _build.Last;
            var tab = _store.Get("build.tab") ?? Tabs[0];
            var head = new List<SettingItem> { new ChoiceSetting(_store, "build.tab", "Show", Tabs, changed: _ => Rebuild()) };
            if (q == null || !q.Ok)
            {
                head.Add(new NoteSetting(q?.Message ?? "Measure the model to fill the workspace.", q == null ? ChipKind.Grey : ChipKind.Bad));
                head.Add(new ButtonsSetting("", new[] { new SettingButton("Measure", _build.MeasureCommand, primary: true) }));
                Groups.Add(new SettingsGroup(q?.Model ?? "Build", head.ToArray()));
                return;
            }
            head.Add(new ReadOnlySetting("Quantities from the model", $"{q.Model} · baseline {(q.Baseline.Length > 0 ? q.Baseline : "none yet")}"));
            Groups.Add(new SettingsGroup(q.Model, head.ToArray()));
            string Num(double? v) => v == null ? "QS" : v.Value.ToString("0.##", CultureInfo.InvariantCulture);
            if (tab == "BOQ")
            {
                Groups.Add(new SettingsGroup($"BOQ · {q.Items.Count} items, {q.Items.Count(i => i.Qty != null)} measured, {q.Items.Count(i => i.Changed)} changed",
                    new TableSetting("", new[] { "Code", "Description", "Unit", "Qty", "Was", "Changed" },
                        q.Items.Select(i => new TableRow(i, i.Code, i.Description, i.Unit, Num(i.Qty), i.Previous == null ? "—" : Num(i.Previous), i.Changed ? "Yes" : ""))),
                    new NoteSetting("\"QS\": a unit the model can't measure, measured by the QS. Rates: QS only, never shown in Revit.", ChipKind.Grey)));
            }
            else if (tab == "Packages")
                Groups.Add(new SettingsGroup("Packages (FMC_Trade_Package)",
                    new TableSetting("", new[] { "Package", "Elements", "Bills" }, q.Packages.Select(p => new TableRow(p, p.Value, p.Count.ToString("N0", CultureInfo.InvariantCulture),
                        string.Join(", ", q.Bills.Where(b => b.Package == p.Value).Select(b => b.Bill)))))));
            else
                Groups.Add(new SettingsGroup("Progress (FMC_Construction_Status)",
                    new TableSetting("", new[] { "Status", "Elements", "Share" }, q.Progress.Select(p => new TableRow(p, p.Value, p.Count.ToString("N0", CultureInfo.InvariantCulture),
                        (q.Progress.Sum(x => x.Count) == 0 ? 0 : 100.0 * p.Count / q.Progress.Sum(x => x.Count)).ToString("0", CultureInfo.InvariantCulture) + "%")))));
        }
    }
}
