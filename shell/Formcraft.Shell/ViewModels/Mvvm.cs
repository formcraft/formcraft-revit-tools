using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
using System.Windows.Input;

namespace Formcraft.Shell.ViewModels
{
    public abstract class ObservableObject : INotifyPropertyChanged
    {
        public event PropertyChangedEventHandler? PropertyChanged;

        protected void OnPropertyChanged([CallerMemberName] string? name = null) =>
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));

        protected bool Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
        {
            if (EqualityComparer<T>.Default.Equals(field, value)) return false;
            field = value;
            OnPropertyChanged(name);
            return true;
        }
    }

    public sealed class RelayCommand : ICommand
    {
        private readonly Action<object?> _run;
        private readonly Func<object?, bool>? _can;

        public RelayCommand(Action<object?> run, Func<object?, bool>? can = null)
        {
            _run = run;
            _can = can;
        }

        public RelayCommand(Action run) : this(_ => run()) { }

        public event EventHandler? CanExecuteChanged
        {
            add => CommandManager.RequerySuggested += value;
            remove => CommandManager.RequerySuggested -= value;
        }

        public bool CanExecute(object? parameter) => _can?.Invoke(parameter) ?? true;
        public void Execute(object? parameter) => _run(parameter);
    }

    /// <summary>Runs an async action from a command; errors go to the footer status, never a crash.</summary>
    public sealed class AsyncCommand : ICommand
    {
        private readonly Func<Task> _run;
        private readonly Action<string> _report;
        private bool _busy;

        public AsyncCommand(Func<Task> run, Action<string> report)
        {
            _run = run;
            _report = report;
        }

        public event EventHandler? CanExecuteChanged
        {
            add => CommandManager.RequerySuggested += value;
            remove => CommandManager.RequerySuggested -= value;
        }

        public bool CanExecute(object? parameter) => !_busy;

        public async void Execute(object? parameter)
        {
            _busy = true;
            CommandManager.InvalidateRequerySuggested();
            try { await _run(); }
            catch (Exception ex) { _report("Something went wrong: " + ex.Message); }
            finally
            {
                _busy = false;
                CommandManager.InvalidateRequerySuggested();
            }
        }
    }
}
