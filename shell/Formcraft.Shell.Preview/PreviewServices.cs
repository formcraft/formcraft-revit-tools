using System.Collections.Generic;
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
        public PreviewServices()
        {
            Pane = new ShellViewModel(Licence, Connection, Document);
        }

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

        /// <summary>Mock sign-in: any email and password, then code 123456; then past first-run setup.</summary>
        public void SignInToMainPane()
        {
            Licence.SignInAsync("[name.a]@formcraft.example", "sample").GetAwaiter().GetResult();
            Licence.VerifyCodeAsync("123456").GetAwaiter().GetResult();
            Pane.Welcome.ContinueCommand.Execute(null);
        }
    }
}
