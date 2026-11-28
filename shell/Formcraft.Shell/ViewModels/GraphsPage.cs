using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>
    /// Check › Graphs (D6, Builder 7): a Dynamo graph as a staff form, like Dynamo Player. Pick a graph, fill its inputs,
    /// press Plan for the dry run (fmc_dynamo plan: the plan_hash and whether a person must approve), ask for approval,
    /// approve or refuse it here (server CLI graph_approve / graph_refuse only), then Run. Graphs with Python always need
    /// a person, preview too; every apply or offline run does as well. The approval is single-use and bound to the
    /// plan_hash, so a changed input needs a new plan and a new approval. Values live in this page only, never saved.
    /// </summary>
    public sealed class GraphsPage : SectionPage
    {
        public static readonly string[] Modes = { "preview", "apply", "offline" };

        private readonly IGraphTools _tools;
        private readonly IUserSettings _settings;
        private readonly SettingStore _store = new SettingStore(new InMemoryUserSettings(), "graphs.");
        private readonly Action<string> _status;
        private readonly MessagesSetting _messages = new MessagesSetting();
        private readonly Dictionary<string, SettingItem> _inputs = new Dictionary<string, SettingItem>();
        private List<GraphEntry> _graphs = new List<GraphEntry>();
        private string _listMessage = "";
        private GraphForm? _form;
        private GraphPlanView? _plan;
        private GraphApprovalView? _approval;
        private TextSetting? _reason;

        public GraphsPage(IGraphTools tools, IUserSettings settings, Action<string> status)
            : base("Check › Graphs", "Dynamo graphs as forms: dry run first, a person approves, then Run.")
        {
            _tools = tools;
            _settings = settings;
            _status = status;
            RefreshCommand = new AsyncCommand(Load, status);
            PlanCommand = new AsyncCommand(Plan, status);
            AskCommand = new AsyncCommand(Ask, status);
            ApproveCommand = new AsyncCommand(() => Decide(true), status);
            RefuseCommand = new AsyncCommand(() => Decide(false), status);
            RunCommand = new AsyncCommand(Run, status);
            Rebuild();
        }

        public ICommand RefreshCommand { get; }
        public ICommand PlanCommand { get; }
        public ICommand AskCommand { get; }
        public ICommand ApproveCommand { get; }
        public ICommand RefuseCommand { get; }
        public ICommand RunCommand { get; }
        public GraphForm? Form => _form;
        public GraphPlanView? CurrentPlan => _plan;
        public GraphApprovalView? Approval => _approval;

        public override IEnumerable<FooterAction> Footer => new[] { new FooterAction("Run", RunCommand, primary: true) };

        public override void Opened() => _ = Load();

        private string Kit => _settings.Get(SettingKeys.KitFolder) ?? "";
        private string Mode => _store.Get("mode") is string m && Modes.Contains(m) ? m : Modes[0];
        private GraphEntry? Selected => _graphs.FirstOrDefault(g => g.File == _store.Get("graph"));

        private async Task Load()
        {
            var (ok, message, graphs) = await _tools.ListAsync(Kit);
            _graphs = ok ? graphs.Where(g => g.Status != "retired").ToList() : new List<GraphEntry>();
            _listMessage = ok && _graphs.Count == 0 ? "No graphs in the kit's 05_Scripts or the project's 00_Formcraft\\Graphs." : ok ? "" : message;
            if (Selected == null && _graphs.Count > 0) _store.Set("graph", _graphs[0].File);
            await LoadForm();
        }

        private async Task LoadForm()
        {
            ClearPlan();
            _form = Selected == null ? null : await _tools.FormAsync(Selected.File, Kit);
            Rebuild();
        }

        private void ClearPlan()
        {
            _plan = null;
            _approval = null;
            _messages.Show(Enumerable.Empty<ToolMessage>());
        }

        /// <summary>The form's values as text by control id, as fmc_graph_form bind takes them. Blank keeps the saved value.</summary>
        public Dictionary<string, string> Texts()
        {
            var texts = new Dictionary<string, string>();
            foreach (var kv in _inputs)
            {
                switch (kv.Value)
                {
                    case TextSetting t: texts[kv.Key] = t.Value; break;
                    case ToggleSetting b: texts[kv.Key] = b.IsOn ? "true" : "false"; break;
                    case ChoiceSetting c: texts[kv.Key] = c.Selected; break;
                }
            }
            return texts;
        }

        private async Task Plan()
        {
            if (Selected == null || _form == null || !_form.Ok) { _messages.Show(ChipKind.Warn, "Pick a graph first."); return; }
            _approval = null;
            _plan = await _tools.PlanAsync(Selected.File, Kit, Texts(), Mode);
            Rebuild();
            if (!_plan.Ok) _messages.Show(new[] { new ToolMessage(ChipKind.Bad, _plan.Message) }.Concat(_plan.Problems.Select(p => new ToolMessage(ChipKind.Warn, p))));
            else _messages.Show(_plan.NeedsApproval ? ChipKind.Warn : ChipKind.Good, _plan.Message);
        }

        private async Task Ask()
        {
            if (_plan == null || !_plan.Ok) { _messages.Show(ChipKind.Warn, "Press Plan first: a person approves a planned run."); return; }
            _approval = await _tools.AskApprovalAsync(_plan, Kit, _reason?.Value ?? "");
            Rebuild();
            _messages.Show(_approval.Ok ? ChipKind.Info : ChipKind.Bad, _approval.Message);
        }

        private async Task Decide(bool approve)
        {
            if (_approval == null || _approval.Id.Length == 0) { _messages.Show(ChipKind.Warn, "There is no approval to decide."); return; }
            var decided = await _tools.DecideAsync(_approval.Id, approve);
            if (decided.Ok) _approval = decided;
            Rebuild();
            _messages.Show(decided.Ok ? (approve ? ChipKind.Good : ChipKind.Warn) : ChipKind.Bad, decided.Message);
        }

        private async Task Run()
        {
            if (_plan == null || !_plan.Ok) { _messages.Show(ChipKind.Warn, "Press Plan first: Run goes only after a dry run."); return; }
            string id = _approval?.Id ?? "";
            var check = await _tools.RunCheckAsync(_plan, id, Kit);
            if (!check.Ok) { _messages.Show(ChipKind.Bad, check.Message); return; }
            var (ok, message) = await _tools.RunAsync(_plan, id, Kit);
            // The approval is single-use: after a run (or a refused one) the next run needs a new plan and approval.
            ClearPlan();
            Rebuild();
            _messages.Show(ok ? ChipKind.Good : ChipKind.Bad, message);
        }

        public void Rebuild()
        {
            Groups.Clear();
            _inputs.Clear();
            var pick = new List<SettingItem>();
            if (_graphs.Count == 0)
                pick.Add(new NoteSetting(_listMessage.Length > 0 ? _listMessage : "Reading the graphs…", _listMessage.Length > 0 ? ChipKind.Warn : ChipKind.Grey));
            else
            {
                var names = _graphs.Select(g => g.File).ToList();
                pick.Add(new ChoiceSetting(_store, "graph", "Graph", names, Math.Max(0, names.IndexOf(Selected?.File ?? "")), dropdown: true,
                    changed: _ => _ = LoadForm()));
                if (Selected is GraphEntry sel)
                    pick.Add(new ReadOnlySetting("Where", (sel.Tier == "K" ? "Kit" : "Project draft") + " · " + sel.Status + (sel.Python ? " · has Python" : "") + (sel.Lock.Length > 0 ? " · lock " + sel.Lock : "")));
            }
            pick.Add(new ButtonsSetting("", new[] { new SettingButton("Refresh", RefreshCommand) }));
            Groups.Add(new SettingsGroup("Graph", pick.ToArray()));

            if (_form != null && !_form.Ok)
                Groups.Add(new SettingsGroup("Form", new SettingItem[] { new NoteSetting(_form.Message, ChipKind.Bad) }));
            if (_form != null && _form.Ok)
            {
                var items = new List<SettingItem>();
                items.AddRange(_form.Banners.Select(b => new NoteSetting(b.Text, b.Kind)));
                foreach (var c in _form.Controls) items.Add(Control(c));
                if (_form.Outputs.Count > 0) items.Add(new ReadOnlySetting("Shows", string.Join(", ", _form.Outputs)));
                items.Add(new ReadOnlySetting("Graph sha256", _form.Sha256, mono: true));
                Groups.Add(new SettingsGroup("Form · " + _form.Title, items.ToArray()));

                var plan = new List<SettingItem>
                {
                    new ChoiceSetting(_store, "mode", "Mode", Modes, changed: _ => { ClearPlan(); Rebuild(); },
                        hint: "Preview rolls back. Apply keeps the changes. Offline runs in DynamoCLI without Revit."),
                    new NoteSetting(_form.PersonRequiredFor.Count == 0 ? "A preview needs no approval."
                        : "A person approves: " + string.Join(", ", _form.PersonRequiredFor) + (_form.Python ? " (the graph has Python)." : "."), _form.Python ? ChipKind.Warn : ChipKind.Grey),
                    new ButtonsSetting("", new[] { new SettingButton("Plan (dry run)", PlanCommand, primary: true) }),
                };
                if (_plan != null && _plan.Ok)
                {
                    plan.Add(new ReadOnlySetting("plan_hash", _plan.PlanHash, mono: true));
                    plan.Add(new ReadOnlySetting("Approval", _plan.NeedsApproval ? "A person must approve before Run (" + _plan.ApprovalKind + ")" : "None: a preview with no Python"));
                    if (_plan.Why.Count > 0) plan.Add(new ReadOnlySetting("Why", string.Join(Environment.NewLine, _plan.Why)));
                    if (_plan.Binding.Count > 0) plan.Add(new ReadOnlySetting("Inputs", string.Join(Environment.NewLine, _plan.Binding), mono: true));
                    if (_plan.Lock.Length > 0) plan.Add(new ReadOnlySetting("Kit lock", _plan.Lock));
                }
                plan.Add(_messages);
                Groups.Add(new SettingsGroup("Plan", plan.ToArray()));

                if (_plan != null && _plan.Ok && _plan.NeedsApproval)
                {
                    _reason ??= new TextSetting("Reason", placeholder: "Why this run, in a line the approver reads");
                    var approval = new List<SettingItem> { _reason };
                    if (_approval == null || _approval.Id.Length == 0)
                        approval.Add(new ButtonsSetting("", new[] { new SettingButton("Ask approval", AskCommand) }));
                    else
                    {
                        approval.Add(new ReadOnlySetting("Approval", _approval.Id + " · " + _approval.Status + (_approval.ExpiresAt.Length > 0 ? " · until " + _approval.ExpiresAt : ""), mono: true));
                        if (_approval.Status == "pending")
                            approval.Add(new ButtonsSetting("", new[] { new SettingButton("Approve", ApproveCommand, primary: true), new SettingButton("Refuse", RefuseCommand) },
                                hint: "You decide here, as a person. Single use, 30 minutes, for this plan_hash only."));
                    }
                    Groups.Add(new SettingsGroup("Approval · a person decides", approval.ToArray()));
                }
            }
        }

        private SettingItem Control(GraphControl c)
        {
            string hint = string.Join(" ", new[] { c.Rule, c.Hint, c.Disabled ? c.DisabledWhy : "" }.Where(s => s.Length > 0));
            // Kept per graph file in this page's own memory, so a rebuild (plan, approval) keeps what the person typed.
            string key = "in." + (_form?.File ?? "") + "|" + c.Id;
            SettingItem item;
            switch (c.Control)
            {
                case "toggle":
                    item = new ToggleSetting(_store, key, c.Label, c.Value == "true", hint, locked: c.Disabled, lockedWhy: c.DisabledWhy);
                    break;
                case "choice" when c.Options.Count > 0:
                    item = new ChoiceSetting(_store, key, c.Label, c.Options, Math.Max(0, c.Options.IndexOf(c.Value)), dropdown: true, hint: hint);
                    break;
                case "element":
                    // Element pickers are filled in Revit; the pane never types an element id.
                    return new ReadOnlySetting(c.Label, c.Value.Length > 0 ? c.Value : "Picked in Revit", hint);
                default:
                    if (c.Disabled) return new ReadOnlySetting(c.Label, c.Value, hint);
                    item = new TextSetting(c.Label, c.Value, c.Control == "file" || c.Control == "folder" ? "A path inside the project" : "", hint, _store, key, mono: c.Control == "file" || c.Control == "folder");
                    break;
            }
            _inputs[c.Id] = item;
            item.PropertyChanged += (_, __) => { if (_plan != null) { ClearPlan(); _messages.Show(ChipKind.Info, "An input changed: press Plan again."); } };
            return item;
        }
    }
}
