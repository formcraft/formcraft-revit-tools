using System;
using System.Threading.Tasks;
using System.Windows.Input;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>
    /// A dialog over the pane (FmcDialog in ShellView). Cancel and Esc close it and change nothing; the primary button
    /// runs the action. A plain dialog closes first, then runs it. A dialog with an input (the 6-digit code) stays open
    /// and shows the error until the action accepts the input.
    /// </summary>
    public sealed class DialogViewModel : ObservableObject
    {
        private readonly Func<string, Task<string?>> _confirm;
        private Action? _close;
        private string _input = "";
        private string _error = "";

        /// <summary>A confirmation: the message shows as an amber note (board: Release this seat).</summary>
        public DialogViewModel(string title, string message, string primaryText, Func<Task> confirm)
            : this(title, message, primaryText, async _ => { await confirm(); return null; }, null, isNote: true)
        {
        }

        private DialogViewModel(string title, string message, string primaryText, Func<string, Task<string?>> confirm, string? inputLabel, bool isNote)
        {
            Title = title;
            Message = message;
            PrimaryText = primaryText;
            InputLabel = inputLabel ?? "";
            IsNote = isNote;
            _confirm = confirm;
            CancelCommand = new RelayCommand(() => _close?.Invoke());
        }

        /// <summary>
        /// A dialog that asks for one value. <paramref name="confirm"/> returns null when the value is accepted (the dialog
        /// closes) or the message to show under the input (it stays open).
        /// </summary>
        public static DialogViewModel WithInput(string title, string message, string inputLabel, string primaryText, Func<string, Task<string?>> confirm) =>
            new DialogViewModel(title, message, primaryText, confirm, inputLabel, isNote: false);

        public string Title { get; }
        public string Message { get; }
        public string PrimaryText { get; }
        /// <summary>The message is an amber note; otherwise plain text.</summary>
        public bool IsNote { get; }
        public bool IsText => !IsNote;
        public bool HasInput => InputLabel.Length > 0;
        public string InputLabel { get; }

        public string Input
        {
            get => _input;
            set => Set(ref _input, value ?? "");
        }

        public string Error
        {
            get => _error;
            private set { if (Set(ref _error, value)) OnPropertyChanged(nameof(HasError)); }
        }

        public bool HasError => Error.Length > 0;

        public ICommand CancelCommand { get; }
        public ICommand? ConfirmCommand { get; private set; }

        /// <summary>Called by the shell when it shows the dialog.</summary>
        internal void Attach(Action close, Action<string> report)
        {
            _close = close;
            ConfirmCommand = new AsyncCommand(async () =>
            {
                if (!HasInput) close();
                var problem = await _confirm(Input);
                if (!HasInput) return;
                if (problem == null) close();
                else Error = problem;
            }, report);
        }
    }
}
