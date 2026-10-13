using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>
    /// The Log file window (board core/UI_Log): today's FMC_MCP_FileLog.csv for this PC, filtered All / Pane clicks /
    /// Claude / Refused; open the CSV or the reports folder; copy a row for support. Opened from the ribbon (Core › Log
    /// file, U10) and from Settings › Updates. Never used to rank people (Manual 14.5).
    /// </summary>
    public sealed class LogViewModel : ObservableObject
    {
        public static readonly string[] Filters = { "All", "Pane clicks", "Claude", "Refused" };

        private readonly ILogReader _reader;
        private readonly Action<string> _open;
        private readonly Action<string> _copy;
        private IReadOnlyList<LogEntry> _all = new LogEntry[0];
        private string _filter = Filters[0];
        private LogEntry? _selected;
        private string _message = "";

        /// <param name="open">Opens a file or folder (Explorer in the app; recorded in tests).</param>
        /// <param name="copy">Puts text on the clipboard.</param>
        public LogViewModel(ILogReader reader, Action<string> open, Action<string> copy)
        {
            _reader = reader;
            _open = open;
            _copy = copy;
            OpenCsvCommand = new RelayCommand(() => Open(_reader.Path, "Opened the CSV."));
            OpenFolderCommand = new RelayCommand(() => Open(Path.GetDirectoryName(_reader.Path) ?? "", "Opened the reports folder."));
            CopyRowCommand = new RelayCommand(CopyRow);
            RefreshCommand = new RelayCommand(Refresh);
            Refresh();
        }

        public IReadOnlyList<string> FilterNames => Filters;
        public ObservableCollection<LogEntry> Rows { get; } = new ObservableCollection<LogEntry>();
        public RelayCommand OpenCsvCommand { get; }
        public RelayCommand OpenFolderCommand { get; }
        public RelayCommand CopyRowCommand { get; }
        public RelayCommand RefreshCommand { get; }

        public string Filter
        {
            get => _filter;
            set
            {
                if (value == null || !Filters.Contains(value) || !Set(ref _filter, value)) return;
                Apply();
            }
        }

        public LogEntry? Selected { get => _selected; set => Set(ref _selected, value); }

        public string FileLine => Path.GetFileName(_reader.Path) + " · " + (_onlyToday ? "today" : "all days") + " · this PC";
        private bool _onlyToday = true;

        /// <summary>Show only today's rows (the board), or every day in the file.</summary>
        public bool OnlyToday
        {
            get => _onlyToday;
            set
            {
                if (!Set(ref _onlyToday, value)) return;
                OnPropertyChanged(nameof(FileLine));
                Apply();
            }
        }

        public string Message { get => _message; private set => Set(ref _message, value); }
        public bool IsEmpty => Rows.Count == 0;
        public string EmptyText => _all.Count == 0
            ? "No log yet on this PC. Rows appear here when a pane button or Claude runs a Formcraft tool."
            : "No rows for this filter" + (_onlyToday ? " today." : ".");

        public void Refresh()
        {
            _all = _reader.Read();
            Apply();
            Message = _all.Count == 0 ? "" : _all.Count + " rows in " + Path.GetFileName(_reader.Path) + ".";
        }

        private void Apply()
        {
            var today = DateTime.Today;
            IEnumerable<LogEntry> rows = _all;
            if (_onlyToday) rows = rows.Where(r => r.Time.Date == today);
            rows = _filter switch
            {
                "Pane clicks" => rows.Where(r => r.From == "Pane"),
                "Claude" => rows.Where(r => r.From == "Claude" || r.From == "Ask"),
                "Refused" => rows.Where(r => r.Refused),
                _ => rows,
            };
            Rows.Clear();
            foreach (var r in rows) Rows.Add(r);
            Selected = null;
            OnPropertyChanged(nameof(IsEmpty));
            OnPropertyChanged(nameof(EmptyText));
        }

        private void Open(string path, string done)
        {
            if (path.Length == 0 || !(File.Exists(path) || Directory.Exists(path)))
            {
                Message = "Not there yet: " + path;
                return;
            }
            _open(path);
            Message = done;
        }

        private void CopyRow()
        {
            if (Selected == null)
            {
                Message = "Pick a row first.";
                return;
            }
            _copy(Selected.SupportLine);
            Message = "Row copied for support: tools and results only, no model content.";
        }
    }
}
