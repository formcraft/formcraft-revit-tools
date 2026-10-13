using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>One search result row: title in bold, detail in grey (board core/UI_Palette).</summary>
    public sealed class SearchResult : ObservableObject
    {
        private bool _isSelected;

        public SearchResult(SearchKind kind, string title, string detail, FmcModule module, string? opens, bool allowed)
        {
            Kind = kind;
            Title = title;
            Module = module;
            Opens = opens;
            Allowed = allowed;
            Detail = allowed ? detail : detail + " · not on your licence, ask your admin";
        }

        public SearchKind Kind { get; }
        /// <summary>The group heading it sits under: SECTIONS, ACTIONS, SETTINGS, HELP.</summary>
        public string Heading => (Kind == SearchKind.Help ? "Help" : Kind + "s").ToUpperInvariant();
        public string Title { get; }
        public string Detail { get; }
        public FmcModule Module { get; }
        /// <summary>Section name, "Settings", or null (help in the guide).</summary>
        public string? Opens { get; }
        /// <summary>Its module is on the licence. Results you can't run still show, dimmed, with why and who can help.</summary>
        public bool Allowed { get; }
        public bool IsSelected { get => _isSelected; set => Set(ref _isSelected, value); }
    }

    /// <summary>
    /// Ctrl+K search over everything the registry knows: sections, actions, settings and help. Matches the title and the
    /// entry's extra words (never the grey detail), every typed word must match, and results follow the licence and the
    /// parts switches, so search finds what the pane shows.
    /// </summary>
    public sealed class SearchViewModel : ObservableObject
    {
        private readonly SectionRegistry _registry;
        private readonly Func<IEnumerable<SectionItem>> _visibleSections;
        private readonly Func<FmcModule, bool> _licensed;
        private readonly Func<string[]?, bool> _partsShown;
        private readonly Action<SearchResult> _open;
        private string _query = "";
        private SearchResult? _selected;

        public SearchViewModel(SectionRegistry registry, Func<IEnumerable<SectionItem>> visibleSections, Func<FmcModule, bool> licensed,
                               Func<string[]?, bool> partsShown, Action<SearchResult> open)
        {
            _registry = registry;
            _visibleSections = visibleSections;
            _licensed = licensed;
            _partsShown = partsShown;
            _open = open;
            OpenCommand = new RelayCommand(p => { if (p is SearchResult r) Open(r); });
            TryCommand = new RelayCommand(p => Query = p as string ?? "");
        }

        /// <summary>The board's sample searches, offered when nothing is found.</summary>
        public IReadOnlyList<string> Samples { get; } = new[] { "sheet", "qa", "level" };

        public ObservableCollection<SearchResult> Results { get; } = new ObservableCollection<SearchResult>();
        public RelayCommand OpenCommand { get; }
        public RelayCommand TryCommand { get; }

        public string Query
        {
            get => _query;
            set
            {
                if (!Set(ref _query, value ?? "")) return;
                Refresh();
            }
        }

        /// <summary>Results replace the section body while there is a query.</summary>
        public bool IsOpen => Query.Trim().Length > 0;
        public bool NothingFound => IsOpen && Results.Count == 0;
        public string NothingFoundText => "Nothing found for “" + Query.Trim() + "”.";

        public SearchResult? Selected
        {
            get => _selected;
            set
            {
                if (_selected == value) return;
                if (_selected != null) _selected.IsSelected = false;
                _selected = value;
                if (_selected != null) _selected.IsSelected = true;
                OnPropertyChanged();
            }
        }

        public void MoveNext() => Move(+1);
        public void MovePrevious() => Move(-1);

        /// <summary>Enter: opens the selected result.</summary>
        public void OpenSelected()
        {
            if (Selected != null) Open(Selected);
        }

        /// <summary>Esc: clears the search and puts the section back.</summary>
        public void Close() => Query = "";

        /// <summary>Runs the search again (after a licence or parts change).</summary>
        public void Refresh()
        {
            var words = Query.Trim().ToLowerInvariant().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            var found = new List<SearchResult>();
            if (words.Length > 0)
            {
                bool Matches(string title, IEnumerable<string>? extra)
                {
                    var hay = new[] { title }.Concat(extra ?? Enumerable.Empty<string>()).Select(h => h.ToLowerInvariant()).ToList();
                    return words.All(w => hay.Any(h => h.Contains(w)));
                }

                var visible = _visibleSections().ToList();
                foreach (var s in visible.Where(s => Matches(s.Group + " › " + s.Name, null)))
                    found.Add(new SearchResult(SearchKind.Section, s.Group + " › " + s.Name, s.Module.ToString(), s.Module, s.Name, _licensed(s.Module)));

                foreach (var e in _registry.Search ?? new SearchEntryDef[0])
                {
                    if (!_partsShown(e.Parts) || !Matches(e.Title, e.Words)) continue;
                    // An entry that opens a section only shows while that section does.
                    if (e.Opens != null && e.Opens != "Settings" && visible.All(s => s.Name != e.Opens)) continue;
                    found.Add(new SearchResult(e.Kind, e.Title, e.Detail, e.Module, e.Opens, _licensed(e.Module)));
                }
            }

            Results.Clear();
            foreach (var r in found.OrderBy(r => (int)r.Kind)) Results.Add(r);
            Selected = Results.FirstOrDefault();
            OnPropertyChanged(nameof(IsOpen));
            OnPropertyChanged(nameof(NothingFound));
            OnPropertyChanged(nameof(NothingFoundText));
        }

        private void Move(int step)
        {
            if (Results.Count == 0) return;
            var i = Selected == null ? -1 : Results.IndexOf(Selected);
            Selected = Results[(i + step + Results.Count) % Results.Count];
        }

        private void Open(SearchResult result)
        {
            Selected = result;
            _open(result);
        }
    }
}
