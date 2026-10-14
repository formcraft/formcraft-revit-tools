using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;
using Formcraft.Shell.Views;
using revit_mcp_plugin.Core;
using revit_mcp_plugin.Fmc;
using ShellDocState = Formcraft.Shell.Services.DocState;

namespace revit_mcp_plugin.Shell
{
    /// <summary>
    /// Hosts the Formcraft pane (Formcraft.Shell's ShellView) in a Revit dockable pane: the add-in's one pane. The add-in
    /// supplies what the shell can't know on its own: Revit's theme, the open document, the Claude service and the working
    /// Connect page (FormcraftBrowser.Page). Settings are the person's own (%APPDATA%\Formcraft\settings.json).
    /// </summary>
    public static class ShellHost
    {
        public static readonly DockablePaneId PaneId = new DockablePaneId(new Guid("2C7D3B10-58E4-4A6F-9F1E-6B0A4D2C8E71"));
        public const string Title = "Formcraft";

        public static ShellViewModel Pane { get; private set; }
        public static IUserSettings Settings { get; private set; }
        public static MockLicenceService Licence { get; private set; }
#if REVIT2025_OR_GREATER
        /// <summary>Formcraft Flow's touch engine, started just before the pane (null if it couldn't start).</summary>
        public static TouchKit.App Touch { get; set; }
#endif

        private static readonly RevitDocumentContext Document = new RevitDocumentContext();
        private static readonly RevitConnection Connection = new RevitConnection();
        private static readonly RevitConnectInfo ConnectInfo = new RevitConnectInfo();
        private static readonly RevitFileTools Files = new RevitFileTools();
        private static ShellView _view;
        private static bool _autoStartDone;

        /// <summary>Called from OnStartup: dockable panes can only be registered there.</summary>
        public static void Register(UIControlledApplication application)
        {
#if REVIT2024_OR_GREATER
            // The pane follows Revit's own Light/Dark setting, at start and whenever it changes (Options › Colors).
            ThemeService.Shared.SetHostTheme(UIThemeManager.CurrentTheme == UITheme.Dark ? PaneTheme.Dark : PaneTheme.Light);
            application.ThemeChanged += (s, e) =>
                ThemeService.Shared.SetHostTheme(UIThemeManager.CurrentTheme == UITheme.Dark ? PaneTheme.Dark : PaneTheme.Light);
#else
            // Revit 2020-2023 have no dark theme.
            ThemeService.Shared.SetHostTheme(PaneTheme.Light);
#endif
            Settings = new JsonUserSettings(JsonUserSettings.DefaultPath);
            FlowTools.Register();
            // Connect's "Switch on when Revit starts" is start_with_revit in fmc_connect.json, the file the MCP server reads too.
            string autoStart = "settings." + ConnectViewModel.AutoStartKey;
            Settings.Set(autoStart, ConnectSettings.Load().StartWithRevit ? "true" : "false");
            Settings.Changed += (_, __) =>
            {
                var c = ConnectSettings.Load();
                bool want = Settings.Get(autoStart) == "true";
                if (c.StartWithRevit != want) { c.StartWithRevit = want; c.Save(); }
            };
            // The licence service arrives in U17 (decision D6); until then sign-in is the mock (code 123456).
            // F-014: the mock keeps the session when "Keep me signed in on this PC" is on (until U17's real service).
            Licence = new MockLicenceService(Settings);
#if REVIT2025_OR_GREATER
            ITouchService touch = Touch != null ? new RevitTouch(Touch) : null;
#else
            ITouchService touch = null;
#endif
            Pane = new ShellViewModel(Licence, Connection, Document, Settings, touch: touch, connect: ConnectInfo,
                                      families: new RevitFamilyTools(), files: Files,
                                      project: new RevitProjectTools(), templates: new RevitTemplateTools(),
                                      library: new RevitLibraryTools(), qa: new RevitQaTools(),
                                      materials: new RevitMaterialTools(), sheets: new RevitSheetTools(),
                                      annotate: new RevitAnnotateTools(), issue: new RevitIssueTools(), links: new RevitLinkTools(), workshare: new RevitWorkshareTools(), review: new RevitReviewTools(), reports: new RevitReportTools(), flow: new RevitFlowTools(), brief: new RevitBriefTools(),
                                      // F-013: no update feed yet; the installed build from the build stamp.
                                      updates: new NoFeedUpdateService("build " + revit_mcp_plugin.FmcBuildInfo.Commit + " · " + revit_mcp_plugin.FmcBuildInfo.Time.Replace("T", " ").TrimEnd('Z') + " UTC"))
            {
                LogPath = Path.Combine(GuardStatus.ExpandEnv(GuardStatus.Load().ReportsDir), "FMC_MCP_FileLog.csv"),
            };
            FormcraftBrowser.DocumentsChanged += Files.Update;
            _view = new ShellView { DataContext = Pane };
            // fmc_ui (U11): Claude reads and steers the pane through the command set.
            UiBridgeHost.Attach(new UiBridge(Pane, Licence, UiBridgeHost.AllowMockLicence, () => _view));

            application.RegisterDockablePane(PaneId, Title, new PaneProvider(_view));
            application.Idling += OnIdling;
            RibbonBuilder.Create(application, Pane, Settings, Licence);
        }

        public static void TogglePane(UIApplication app)
        {
            DockablePane pane = app.GetDockablePane(PaneId);
            if (pane.IsShown()) pane.Hide();
            else pane.Show();
        }

        public static void ShowPane(UIApplication app)
        {
            DockablePane pane = app.GetDockablePane(PaneId);
            if (!pane.IsShown()) pane.Show();
        }

        /// <summary>Shows the pane on Connect (Core › Connect AI, and the page's own links to Files, Activity, Guard).</summary>
        public static void ShowConnect(UIApplication app)
        {
            ShowPane(app);
            if (Pane.IsMain && !Pane.IsConnectOpen) Pane.OpenConnectCommand.Execute(null);
        }

        /// <summary>The Log file window (board core/UI_Log), from the ribbon's Core › Log file.</summary>
        public static void OpenLog()
        {
            var window = new LogWindow(new CsvLogReader(Pane.LogPath));
            window.Show();
        }

        /// <summary>Idling runs in API context after every burst of work: cheap checks, pushed only when they change.</summary>
        private static void OnIdling(object sender, IdlingEventArgs e)
        {
            if (!(sender is UIApplication app)) return;
            if (!_autoStartDone)
            {
                // start_with_revit in fmc_connect.json (Connect › "Switch on when Revit starts"): once, at the first idle moment.
                _autoStartDone = true;
                if (ConnectSettings.Load().StartWithRevit && !SocketService.Instance.IsRunning)
                    FormcraftBrowser.RequestToggleService();
            }
            Connection.Update(SocketService.Instance.IsRunning);
            RibbonBuilder.ShowConnection(SocketService.Instance.IsRunning);
            ConnectInfo.Poll();
            Document.Update(app.ActiveUIDocument?.Document);
        }

        private sealed class PaneProvider : IDockablePaneProvider
        {
            private readonly ShellView _content;
            public PaneProvider(ShellView content) { _content = content; }

            public void SetupDockablePane(DockablePaneProviderData data)
            {
                data.FrameworkElement = _content;
                data.VisibleByDefault = true;
                // First run only: Revit remembers where the person docks or floats it after that.
                data.InitialState = new DockablePaneState
                {
                    DockPosition = DockPosition.Tabbed,
                    TabBehind = DockablePanes.BuiltInDockablePanes.PropertiesPalette,
                    MinimumWidth = 320,
                };
            }
        }
    }

    /// <summary>
    /// The open document for the pane's banner, judged by the same live-model lock the server uses (GuardStatus.Verdict,
    /// tested against the server's lock_cases.json). A workshared model counts as live until the "Claude in shared models"
    /// switch reaches the add-in.
    /// </summary>
    public sealed class RevitDocumentContext : IDocumentContext
    {
        private string _key = "";

        public DocumentInfo Current { get; private set; } = new DocumentInfo("No model open", ShellDocState.Live);
        public event EventHandler Changed;

        public void Update(Document doc)
        {
            string key = doc == null ? "" : doc.Title + "|" + doc.PathName + "|" + doc.IsFamilyDocument + "|" + doc.IsWorkshared;
            if (key == _key) return;
            _key = key;
            if (doc == null)
            {
                Current = new DocumentInfo("No model open", ShellDocState.Live);
            }
            else
            {
                var state = new Fmc.DocState
                {
                    Title = doc.Title,
                    Path = doc.PathName ?? "",
                    IsFamily = doc.IsFamilyDocument,
                    IsWorkshared = doc.IsWorkshared,
                };
                var (ok, _) = GuardStatus.Load().Verdict(state);
                string title = string.IsNullOrEmpty(state.Path) ? "New model · not saved yet" : doc.Title + (doc.IsWorkshared ? " · workshared" : "");
                Current = new DocumentInfo(title, ok ? ShellDocState.Setup : ShellDocState.Live);
            }
            Changed?.Invoke(this, EventArgs.Empty);
        }
    }

    /// <summary>The AI connection (the plugin's socket on 127.0.0.1, port from fmc_connect.json) behind the header's Connected chip.</summary>
    public sealed class RevitConnection : IConnectionService
    {
        public ConnectionState State { get; private set; } = ConnectionState.NotConnected;
        public event EventHandler Changed;

        public void Update(bool running)
        {
            var state = running ? ConnectionState.Connected : ConnectionState.NotConnected;
            if (state == State) return;
            State = state;
            Changed?.Invoke(this, EventArgs.Empty);
        }
    }
}
