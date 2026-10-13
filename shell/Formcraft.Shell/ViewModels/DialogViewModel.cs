using System;
using System.Threading.Tasks;
using System.Windows.Input;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>
    /// A dialog over the pane (FmcDialog in ShellView). Cancel and Esc close it and change nothing;
    /// the primary button closes it, then runs the action.
    /// </summary>
    public sealed class DialogViewModel
    {
        private readonly Func<Task> _confirm;
        private Action? _close;

        public DialogViewModel(string title, string message, string primaryText, Func<Task> confirm)
        {
            Title = title;
            Message = message;
            PrimaryText = primaryText;
            _confirm = confirm;
            CancelCommand = new RelayCommand(() => _close?.Invoke());
        }

        public string Title { get; }
        public string Message { get; }
        public string PrimaryText { get; }
        public ICommand CancelCommand { get; }
        public ICommand? ConfirmCommand { get; private set; }

        /// <summary>Called by the shell when it shows the dialog.</summary>
        internal void Attach(Action close, Action<string> report)
        {
            _close = close;
            ConfirmCommand = new AsyncCommand(async () =>
            {
                close();
                await _confirm();
            }, report);
        }
    }
}
