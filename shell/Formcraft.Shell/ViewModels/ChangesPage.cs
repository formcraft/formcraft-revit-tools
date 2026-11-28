using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>
    /// Check › Changes (F133, the NBRB change record): a read-only timeline of what changed in open models, who
    /// changed it and when, with key-parameter before/after values. Times are labeled with their time zone
    /// (Tool Research P-02). Nothing here syncs, saves, reloads, relinquishes or starts a transaction.
    /// </summary>
    public sealed class ChangesPage : SectionPage
    {
        public static readonly string[] Periods = { "Today", "Last 7 days", "Last 30 days", "All recorded" };
        public const string Everyone = "Everyone";
        public const string EveryCategory = "Every category";
        public const string ThisDocument = "This document";
        public const string EveryDocument = "Every document";

        private readonly IChangeFeedTools _tools;
        private readonly IDocumentContext _document;
        private readonly SettingStore _store;
        private readonly Action<string> _status;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private IReadOnlyList<ChangeFeedRow> _rows = Array.Empty<ChangeFeedRow>();
        private ChangeFeedRow? _selected;
        private bool _ignoreSelect;
        private List<string> _users = new List<string> { Everyone };
        private List<string> _categories = new List<string> { EveryCategory };

        public ChangesPage(IChangeFeedTools tools, IDocumentContext document, IUserSettings settings, Action<string> status)
            : base("Check › Changes", "What changed in the model, who changed it and when, with before and after values. Read only: it never syncs or saves.")
        {
            _tools = tools;
            _document = document;
            _store = new SettingStore(settings);
            _status = status;
            _document.Changed += (_, __) => { if (Scope == ThisDocument) _ = Refresh(); };
            RefreshCommand = new AsyncCommand(Refresh, status);
            Rebuild();
        }

        public ICommand RefreshCommand { get; }
        public MessagesSetting Messages => _messages;
        public IReadOnlyList<ChangeFeedRow> Rows => _rows;
        public ChangeFeedRow? Selected => _selected;

        public override IEnumerable<FooterAction> Footer => new[]
        {
            new FooterAction("Refresh", RefreshCommand, primary: true),
        };

        public override void Opened() { if (_rows.Count == 0) _ = Refresh(); else Rebuild(); }

        public string Period => _store.Get("changes.period") ?? Periods[2];
        public string Scope => _store.Get("changes.scope") ?? ThisDocument;
        public string UserFilter => _store.Get("changes.user") ?? Everyone;
        public string CategoryFilter => _store.Get("changes.category") ?? EveryCategory;

        public static (DateTime? since, DateTime? until) Window(string period, DateTime utcNow)
        {
            var local = utcNow.Kind == DateTimeKind.Utc ? utcNow.ToLocalTime() : utcNow;
            var today = local.Date;
            DateTime? start = period switch
            {
                "Today" => today,
                "Last 7 days" => today.AddDays(-6),
                "Last 30 days" => today.AddDays(-29),
                _ => null,
            };
            return (start?.ToUniversalTime(), period == "All recorded" || start == null ? null : utcNow);
        }

        public void Rebuild()
        {
            Groups.Clear();
            var filters = new SettingItem[]
            {
                new ChoiceSetting(_store, "changes.scope", "Document", new[] { ThisDocument, EveryDocument }, changed: _ => { _ = Refresh(); }),
                new ChoiceSetting(_store, "changes.period", "When", Periods, changed: _ => { _ = Refresh(); }),
                new ChoiceSetting(_store, "changes.category", "Category", _categories, dropdown: _categories.Count > 6, changed: _ => { _ = Refresh(); }),
                new ChoiceSetting(_store, "changes.user", "Who", _users, dropdown: _users.Count > 6, changed: _ => { _ = Refresh(); },
                    hint: "The Revit user Revit recorded. Counts on this page are never a ranking (rule 9)."),
            };
            Groups.Add(new SettingsGroup("Filters", filters));

            var timeline = new List<SettingItem>();
            if (_rows.Count == 0)
                timeline.Add(new NoteSetting("No changes recorded for these filters yet. The feed starts listening when Revit opens, and writes a log under " + _tools.LogDir + " (outside the model).", ChipKind.Grey));
            else
            {
                timeline.Add(new NoteSetting(_rows.Count + " change" + (_rows.Count == 1 ? "" : "s") + ". Times are in the zone they were recorded, with the UTC offset shown.", ChipKind.Info));
                var table = new TableSetting("", new[] { "When", "What", "Who", "Category" },
                    _rows.Select(r => new TableRow(r, r.AtLocal, r.What, Who(r), CategoriesOf(r))), selectable: true,
                    hint: "Pick a row to see the before and after values.");
                table.PropertyChanged += (_, e) =>
                {
                    if (_ignoreSelect) return;
                    if (e.PropertyName == nameof(TableSetting.Selected))
                    {
                        _selected = table.Selected?.Tag as ChangeFeedRow;
                        Rebuild();
                    }
                };
                if (_selected != null)
                {
                    _ignoreSelect = true;
                    table.Selected = table.Rows.FirstOrDefault(r => (r.Tag as ChangeFeedRow)?.Seq == _selected.Seq);
                    _ignoreSelect = false;
                }
                timeline.Add(table);
            }
            Groups.Add(new SettingsGroup("Timeline", timeline.ToArray()));

            if (_selected != null)
            {
                var items = new List<SettingItem>
                {
                    new ReadOnlySetting("When", _selected.AtLocal),
                    new ReadOnlySetting("What", _selected.What),
                    new ReadOnlySetting("Who", Who(_selected)),
                    new ReadOnlySetting("Document", _selected.Document, mono: true),
                };
                if (!string.IsNullOrEmpty(_selected.TruncateReason))
                    items.Add(new NoteSetting(_selected.TruncateReason, ChipKind.Warn));
                if (_selected.Elements.Count == 0)
                    items.Add(new NoteSetting(
                        _selected.Kind == "synced" || _selected.Kind == "saved" || _selected.Kind == "opened" || _selected.Kind == "closed"
                            ? "This entry is a model event (a save, a sync, an open or a close). It has no element parameters."
                            : "No element details were recorded for this entry.", ChipKind.Grey));
                else
                {
                    foreach (var el in _selected.Elements)
                    {
                        items.Add(new ReadOnlySetting(el.Action + " · " + el.Title, el.UniqueId, mono: true));
                        if (el.Params.Count == 0)
                            items.Add(new NoteSetting(string.IsNullOrEmpty(el.TruncateReason) ? "No key parameters changed (or before values were not yet known)." : el.TruncateReason, ChipKind.Grey));
                        else
                            items.Add(new TableSetting("Before → after", new[] { "Parameter", "Before", "After" },
                                el.Params.Select(p => new TableRow(p, p.Name, p.Before ?? "—", p.After ?? "—"))));
                        if (!string.IsNullOrEmpty(el.TruncateReason) && el.Params.Count > 0)
                            items.Add(new NoteSetting(el.TruncateReason, ChipKind.Warn));
                    }
                }
                Groups.Add(new SettingsGroup("Before and after · " + _selected.AtLocal, items.ToArray()));
            }

            var about = new List<SettingItem>
            {
                new NoteSetting("The log is a file on this PC, not inside the model. This page never syncs, saves, reloads latest or relinquishes. A person syncs in Revit. It never counts or ranks people (rule 9).", ChipKind.Grey),
            };
            if (!_tools.LoggingEnabled)
                about.Add(new NoteSetting("Change-feed logging is disabled in the kit or %APPDATA%\Formcraft\config.json. No log files are being written. The in-memory journal is still shown.", ChipKind.Warn));
            about.Add(_messages);
            Groups.Add(new SettingsGroup("About this log", about.ToArray()));
        }

        private async Task Refresh()
        {
            var (since, until) = Window(Period, DateTime.UtcNow);
            string doc = "";
            if (Scope == ThisDocument)
            {
                var title = _document.Current?.Title ?? "";
                doc = title.Split('·')[0].Trim();
                if (doc.Length == 0) doc = title;
            }
            IReadOnlyList<ChangeFeedRow> rows;
            try { rows = await _tools.ReadAsync(doc, "", "", since, until, 500); }
            catch (Exception ex)
            {
                _messages.Show(ChipKind.Warn, ex.Message);
                _status("The change log could not be read.");
                return;
            }
            RebuildChoices(rows);
            string user = UserFilter == Everyone ? "" : UserFilter;
            string category = CategoryFilter == EveryCategory ? "" : CategoryFilter;
            _rows = rows.Where(r =>
                (user.Length == 0 || string.Equals(r.User, user, StringComparison.OrdinalIgnoreCase))
                && (category.Length == 0 || r.Categories.Any(c => string.Equals(c, category, StringComparison.OrdinalIgnoreCase)))
            ).Take(200).ToList();
            if (_selected != null) _selected = _rows.FirstOrDefault(r => r.Seq == _selected.Seq) ?? _rows.FirstOrDefault();
            Rebuild();
            _status(_rows.Count == 0 ? "No changes in this period." : _rows.Count + " changes. Times are shown with their time zone.");
        }

        private void RebuildChoices(IReadOnlyList<ChangeFeedRow> rows)
        {
            var users = new SortedSet<string>(StringComparer.OrdinalIgnoreCase) { Everyone };
            var cats = new SortedSet<string>(StringComparer.OrdinalIgnoreCase) { EveryCategory };
            foreach (var r in rows)
            {
                if (!string.IsNullOrEmpty(r.User)) users.Add(r.User);
                foreach (var c in r.Categories) cats.Add(c);
            }
            _users = users.ToList();
            _categories = cats.ToList();
        }

        private static string Who(ChangeFeedRow r)
        {
            var who = string.IsNullOrEmpty(r.User) ? "" : r.User;
            var by = r.By == "ai" ? "AI" : r.By == "person" ? "person" : r.By;
            if (who.Length == 0) return by;
            return string.IsNullOrEmpty(by) ? who : who + " · " + by;
        }

        private static string CategoriesOf(ChangeFeedRow r) => string.Join(", ", r.Categories);

    }
}
