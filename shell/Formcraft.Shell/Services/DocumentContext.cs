using System;

namespace Formcraft.Shell.Services
{
    /// <summary>What the live-model lock allows on the open document (CLAUDE.md rule 1).</summary>
    public enum DocState
    {
        /// <summary>Family, new unsaved model or a file in _Staging / _ChainTests: setup tools open.</summary>
        Setup,
        /// <summary>Workshared model with "Claude in shared models" on.</summary>
        Shared,
        /// <summary>Live project: Claude reads and reports.</summary>
        Live,
    }

    /// <summary>The open document as the pane shows it in the banner.</summary>
    public sealed class DocumentInfo
    {
        public DocumentInfo(string title, DocState state)
        {
            Title = title;
            State = state;
        }

        public string Title { get; }
        public DocState State { get; }

        /// <summary>The banner's second line, word for word from the boards.</summary>
        public string LockText => State switch
        {
            DocState.Setup => "Setup tools open",
            DocState.Shared => "Shared model: AI in shared models is on",
            _ => "Live project: AI reads and reports",
        };
    }

    /// <summary>
    /// The active Revit document. The add-in implements it (U10) from the same guard the server uses
    /// (plugin/Fmc/GuardStatus.cs), so the banner and Claude never disagree.
    /// </summary>
    public interface IDocumentContext
    {
        DocumentInfo Current { get; }
        event EventHandler? Changed;
    }

    /// <summary>Sample documents for the preview app and tests. Values match the canvas samples.</summary>
    public sealed class MockDocumentContext : IDocumentContext
    {
        public static readonly DocumentInfo NewModel = new DocumentInfo("New model · not saved yet", DocState.Setup);
        public static readonly DocumentInfo SharedModel = new DocumentInfo("F26001-FMC-ZZ-ZZ-M3-A-0001 · shared", DocState.Shared);
        public static readonly DocumentInfo LiveProject = new DocumentInfo("F26001-FMC-ZZ-ZZ-M3-A-0001", DocState.Live);

        // A live project is the safe default: nothing can change the model.
        public DocumentInfo Current { get; private set; } = LiveProject;
        public event EventHandler? Changed;

        public void Open(DocumentInfo document)
        {
            Current = document;
            Changed?.Invoke(this, EventArgs.Empty);
        }
    }
}
