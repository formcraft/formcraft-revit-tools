using System;
using System.Collections.Generic;
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
        /// A dialog with several rows (Add person: name, Revit user name, role, disciplines). The rows use the same
        /// templates as Settings. <paramref name="confirm"/> returns null to close, or the message to show (it stays open).
        /// </summary>
        public static DialogViewModel WithItems(string title, string message, IReadOnlyList<SettingItem> items, string primaryText, Func<Task<string?>> confirm)
        {
            var d = new DialogViewModel(title, message, primaryText, _ => confirm(), null, isNote: false) { Items = items };
            return d;
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
        public IReadOnlyList<SettingItem> Items { get; private set; } = new SettingItem[0];
        public bool HasItems => Items.Count > 0;
        /// <summary>Stays open on a problem: dialogs that ask for something.</summary>
        private bool Asks => HasInput || HasItems;
        public bool HasMessage => Message.Length > 0;
        /// <summary>Plain message text (a note shows in its amber box instead).</summary>
        public bool ShowText => IsText && HasMessage;
        /// <summary>The error under a dialog of rows (an input dialog shows it under the input).</summary>
        public bool HasItemsError => HasItems && HasError;
        public string InputLabel { get; }

        public string Input
        {
            get => _input;
            set => Set(ref _input, value ?? "");
        }

        public string Error
        {
            get => _error;
            private set
            {
                if (!Set(ref _error, value)) return;
                OnPropertyChanged(nameof(HasError));
                OnPropertyChanged(nameof(HasItemsError));
            }
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
                if (!Asks) close();
                var problem = await _confirm(Input);
                if (!Asks) return;
                if (problem == null) close();
                else Error = problem;
            }, report);
        }
    }
}
