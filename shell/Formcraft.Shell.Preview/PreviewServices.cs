using System;
using System.Collections.Generic;
using System.IO;
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
            Pane = new ShellViewModel(Licence, Connection, Document, Settings);
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
