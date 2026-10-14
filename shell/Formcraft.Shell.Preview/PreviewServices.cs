using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Preview
{
    /// <summary>
    /// The mock services behind the preview pane, with switches that stand in for Revit: which document is open,
    /// and whether the Formcraft service answers.
    /// </summary>
    public sealed class PreviewServices : ObservableObject
    {
        /// <param name="settings">Defaults to the preview's own file, so trying switches never touches the real settings.json.</param>
        public PreviewServices(IUserSettings? settings = null)
        {
            Settings = settings ?? new JsonUserSettings(PreviewSettingsPath);
            // No Z:\00_Standards on most PCs: start the preview on the sample kit (tests/shell/fixtures/kit).
            if (Settings.Get(SettingKeys.KitFolder) == null && SampleKit is string kit) Settings.Set(SettingKeys.KitFolder, kit);
            Pane = new ShellViewModel(Licence, Connection, Document, Settings, touch: Touch, families: new MockFamilyTools(), files: new MockFileTools(), library: new MockLibraryTools());
            // The sample log in the tools' own format (tests/shell/fixtures), so the Log file window has rows.
            if (SampleKit is string sample) Pane.LogPath = Path.Combine(Path.GetDirectoryName(sample)!, "FMC_MCP_FileLog.csv");
        }

        /// <summary>The repo's sample kit, found by walking up from the app to the repo root (global.json).</summary>
        public static string? SampleKit
        {
            get
            {
                var dir = AppContext.BaseDirectory;
                while (dir != null && !File.Exists(Path.Combine(dir, "global.json"))) dir = Path.GetDirectoryName(dir);
                var kit = dir == null ? null : Path.Combine(dir, "tests", "shell", "fixtures", "kit");
                return kit != null && Directory.Exists(kit) ? kit : null;
            }
        }

        public static string PreviewSettingsPath =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Formcraft", "Preview", "settings.json");

        public IUserSettings Settings { get; }

        public MockLicenceService Licence { get; } = new MockLicenceService();
        public MockConnectionService Connection { get; } = new MockConnectionService();
        public MockDocumentContext Document { get; } = new MockDocumentContext();
        /// <summary>Sample touch views and settings (board flow/PaneFlowTouch).</summary>
        public MockTouchService Touch { get; } = new MockTouchService();
        public ShellViewModel Pane { get; }

        public IReadOnlyList<Option<DocumentInfo>> Documents { get; } = new[]
        {
            new Option<DocumentInfo>(MockDocumentContext.NewModel, "New model"),
            new Option<DocumentInfo>(MockDocumentContext.SharedModel, "Shared"),
            new Option<DocumentInfo>(MockDocumentContext.LiveProject, "Live"),
        };

        public IReadOnlyList<Option<ConnectionState>> Connections { get; } = new[]
        {
            new Option<ConnectionState>(ConnectionState.Connected, "Connected"),
            new Option<ConnectionState>(ConnectionState.NotConnected, "Not connected"),
        };

        /// <summary>The seven states of board account/PaneStates, plus Normal.</summary>
        public static readonly string[] StateNames = { "Normal", "Not licensed", "Offline", "Grace over", "Not connected", "Kit missing", "Live model", "Revit busy" };
        public IReadOnlyList<string> States => StateNames;
        private string _state = "Normal";

        /// <summary>Puts the mocks into one state (after putting everything back to normal).</summary>
        public string PaneState
        {
            get => _state;
            set
            {
                if (value == null || Array.IndexOf(StateNames, value) < 0) return;
                _state = value;
                ApplyState(value);
                OnPropertyChanged();
            }
        }

        public void ApplyState(string state)
        {
            Licence.SetOnline();
            Licence.SetModule(FmcModule.Model, ModuleStatus.Trial, DateTime.Today.AddDays(9));
            Connection.Set(ConnectionState.Connected);
            if (SampleKit is string kit) Settings.Set(SettingKeys.KitFolder, kit);
            switch (state)
            {
                case "Not licensed":
                    Licence.SetModule(FmcModule.Model, ModuleStatus.NotLicensed);
                    var systems = Pane.Groups.SelectMany(g => g.Sections).FirstOrDefault(s => s.Name == "Systems");
                    if (systems != null) Pane.SelectSectionCommand.Execute(systems);
                    break;
                case "Offline": Licence.SetOffline(3, 11); break;
                case "Grace over": Licence.SetGraceOver(); break;
                case "Not connected": Connection.Set(ConnectionState.NotConnected); break;
                case "Kit missing": Settings.Set(SettingKeys.KitFolder, @"C:\No kit here"); break;
                case "Live model": Document.Open(MockDocumentContext.LiveProject); break;
                case "Revit busy": Connection.Set(ConnectionState.RevitBusy); break;
            }
        }

        public DocumentInfo OpenDocument
        {
            get => Document.Current;
            set
            {
                Document.Open(value);
                OnPropertyChanged();
            }
        }

        public ConnectionState ConnectionState
        {
            get => Connection.State;
            set
            {
                Connection.Set(value);
                OnPropertyChanged();
            }
        }

        /// <summary>Mock sign-in: any email and password, then code 123456; then through the four first-run steps.</summary>
        public void SignInToMainPane()
        {
            SignInToSetup();
            for (var i = 0; i < 3; i++) Pane.Welcome.NextCommand.Execute(null);
        }

        /// <summary>Signed in, on first-run step 2.</summary>
        public void SignInToSetup()
        {
            Licence.SignInAsync("[name.a]@formcraft.example", "sample").GetAwaiter().GetResult();
            Licence.VerifyCodeAsync("123456").GetAwaiter().GetResult();
        }
    }
}
