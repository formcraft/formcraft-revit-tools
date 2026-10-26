using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>
    /// Admin (boards core/PaneAdmin and account/PaneSeats): the team and what each role can do, project settings, AI and
    /// automation, licences, the audit log and the handover; then licences and seats. Admins only. Uses the same rows as
    /// Settings (SettingTemplates.xaml).
    /// </summary>
    public sealed class AdminViewModel : ObservableObject
    {
        public static readonly string[] Sections = { "Team and roles", "Licences and seats", "AI involvement" };
        private static readonly string[] DisciplineCodes = { "Z", "A", "S", "M", "E", "P", "FP", "C", "L" };

        private readonly IAdminService _admin;
        private readonly IAiTools _ai;
        private AiPolicy? _policy;
        private List<AiQueueLine> _queue = new List<AiQueueLine>();
        private readonly InMemoryUserSettings _aiDraft = new InMemoryUserSettings();
        private readonly MessagesSetting _aiMessages = new MessagesSetting();
        private readonly ILicenceService _licence;
        private readonly SettingStore _team;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private string _section = Sections[0];
        private IReadOnlyList<SettingsGroup> _groups = new SettingsGroup[0];
        private TableSetting? _teamTable;

        public AdminViewModel(IAdminService admin, ILicenceService licence, Action<string> status, Action<DialogViewModel> ask, IAiTools? ai = null)
        {
            _admin = admin;
            _ai = ai ?? new MockAiTools();
            _licence = licence;
            _team = new SettingStore(admin.TeamValues);
            _status = status;
            _ask = ask;
            _admin.Changed += (_, __) => Rebuild();
            Rebuild();
        }

        public IReadOnlyList<string> SectionNames => Sections;

        public string Section
        {
            get => _section;
            set
            {
                if (value == null || !Sections.Contains(value) || !Set(ref _section, value)) return;
                Rebuild();
                if (value == Sections[2]) _ = LoadAi();
            }
        }

        public string SectionHint => _section == Sections[0]
            ? "Only admins see this. Roles hide and lock the plugin's own buttons; real file protection comes from folder permissions or a common data environment."
            : _section == Sections[1]
            ? "Plan and renewal, seats per module, who holds which modules, invites, offline licence files and module requests. Payments stay on the account website."
            : "How much AI may model, and how: the firm switch, the involvement level, each group's level, the approval queue and Stop AI. The bands and limits come from the kit rulebook.";

        public IReadOnlyList<SettingsGroup> Groups { get => _groups; private set => Set(ref _groups, value); }

        public void Rebuild() => Groups = _section == Sections[0] ? TeamAndRoles() : _section == Sections[1] ? LicencesAndSeats() : AiInvolvement();

        // ---------- Team and roles (core/PaneAdmin) ----------
        private IReadOnlyList<SettingsGroup> TeamAndRoles()
        {
            var me = _admin.Team.FirstOrDefault(t => t.Role == "Admin");
            _teamTable = new TableSetting("", new[] { "Person", "Revit user", "Role", "Disc." },
                _admin.Team.Select(t => new TableRow(t, t.Name, t.RevitUser, t.Role, t.Disciplines)), selectable: true);
            var permissions = new TableSetting("", new[] { "Pane" }.Concat(_admin.Roles.Select(Short)).ToList(),
                _admin.Panes.Select(p => new TableRow(p, new[] { p }.Concat(_admin.Roles.Select(r => _admin.Permission(p, r))).ToArray())),
                hint: "Disc. = own discipline only. Own = views or families they own. — = hidden.");

            return new[]
            {
                new SettingsGroup("You",
                    new ReadOnlySetting("Signed in as", (me?.RevitUser ?? Environment.UserName) + " · Revit user name matches the team file"),
                    new ReadOnlySetting("Your role", "Admin · backup admin: " + _admin.BackupAdmin),
                    new ReadOnlySetting("Team file", @"<project>\FMC_Team.json · only admins can change it", mono: true)),
                new SettingsGroup("Team",
                    _teamTable,
                    new ButtonsSetting("", new[]
                    {
                        new SettingButton("Add person…", new RelayCommand(AskAddPerson)),
                        new SettingButton("Change role…", new RelayCommand(AskChangeRole)),
                        new SettingButton("Remove", new RelayCommand(AskRemove)),
                    }, "Pick a row for Change role or Remove.")),
                new SettingsGroup("Permissions by role",
                    permissions,
                    new ButtonsSetting("", new[]
                    {
                        new SettingButton("Edit permissions…", new RelayCommand(AskEditPermissions)),
                        new SettingButton("Reset to Formcraft defaults", new RelayCommand(AskResetPermissions)),
                    })),
                new SettingsGroup("Project settings",
                    new ChoiceSetting(_team, "admin.standard", "Standard", new[] { "Formcraft FMC-BIM v2.2", "Client standard (Phase 3)" }, dropdown: true),
                    new ChoiceSetting(_team, "admin.stages", "Stages shown", new[] { "Gates and issue sets", "Also show RIBA" },
                        hint: "Gate 1–3 and issue sets drive the plugin; RIBA is a label only."),
                    new ReadOnlySetting("Sheet status", "Manual 4.4: S0–S4, S6, S7, A1…, B1…, CR"),
                    new ReadOnlySetting("Revisions", "P01… preliminary · C01… contract")),
                new SettingsGroup("AI",
                    new ReadOnlySetting("AI in shared models", "Each person's own switch, in Connect › Safety",
                        "Setup tools on workshared models (D1). Only the person sets it (CLAUDE.md rule 1), so it isn't a team setting."),
                    new TextSetting("Cap per person (USD/month)", "10", store: _team, key: "admin.capperson"),
                    new TextSetting("Team cap (USD/month)", "40", store: _team, key: "admin.capteam"),
                    new ReadOnlySetting("Spent this month", "No Ask AI use yet (Ask AI arrives in U27)")),
                new SettingsGroup("Automation",
                    new ToggleSetting(_team, "admin.autosave", "Auto-save files that are not workshared", false, "Every 15 minutes"),
                    // CLAUDE.md rule 6: workshared models are never saved or synchronised by a tool. Kept off and locked.
                    new ToggleSetting(_team, "admin.scheduledsync", "Scheduled sync for this project", false,
                        "Off and locked: workshared models are never synchronised by a tool (CLAUDE.md rule 6). The person syncs in Revit.",
                        locked: true, lockedWhy: "CLAUDE.md rule 6"),
                    new ChoiceSetting(_team, "admin.syncinterval", "Sync interval (reminder only)", new[] { "Every 2 hours", "Every hour", "At 12:30 and 17:00" }, dropdown: true),
                    new ChoiceSetting(_team, "admin.coordinates", "Coordinate changes approved by", new[] { "Lead or Admin", "Admin only" }),
                    new NoteSetting("AI can never save, sync or move coordinates. These switches are for the plugin only.", ChipKind.Warn)),
                new SettingsGroup("Project data · version bridge (Phase 2)",
                    new ReadOnlySetting("Shared data file", @"<project>\FMC_ProjectData · reviews, sync log, rules, registers, roster", mono: true),
                    new MultiSetting(_team, "admin.versions", "Revit versions on this project", new[] { "2025", "2026", "2027" }, new[] { "2025" }),
                    new NoteSetting("Every version of Formcraft reads and writes the same project data, so reviews and sync history match across versions.")),
                new SettingsGroup("Modules and licences",
                    new TableSetting("", new[] { "Module", "Seats", "Status" }, new[] { FmcModule.Core, FmcModule.Manage, FmcModule.Flow, FmcModule.Model, FmcModule.Build }
                        .Select(m =>
                        {
                            var seats = _admin.Seats.FirstOrDefault(s => s.Module == m);
                            var licensed = _licence.Current.For(m).CanUse;
                            return new TableRow(m, m.ToString(), m == FmcModule.Core ? "All" : seats == null || seats.Seats == "0" ? "—" : seats.Used + " of " + seats.Seats,
                                                m == FmcModule.Core ? "Always" : licensed ? "Licensed" : "Not yet");
                        })),
                    new NoteSetting("One installer holds every module; the licence switches them on."),
                    new ReadOnlySetting("Seats", "Used against bought, per module: Admin › Licences and seats"),
                    new ToggleSetting(_team, "admin.licencecheck", "Licence check", true, "On from 0.1; payment switches on at 1.0", locked: true, lockedWhy: "Roadmap 0.1")),
                new SettingsGroup("Audit log",
                    new TableSetting("", new[] { "When", "Who", "Change" }, _admin.Audit.Take(12).Select(a => new TableRow(a, a.When, a.Who, a.Change)),
                        hint: "Every role, rule or setting change, with who and when.")),
                new SettingsGroup("Handover",
                    new ReadOnlySetting("Backup admin", _admin.BackupAdmin),
                    new ButtonsSetting("", new[]
                    {
                        new SettingButton("Pass admin to…", new RelayCommand(AskPassAdmin)),
                        new SettingButton("Export team file", new RelayCommand(() => _status(@"Export team file: saves FMC_Team.json beside the central model (with the team file, U12)."))),
                    }, "Never locked out: the admin key moves only when the new admin accepts.")),
                new SettingsGroup("Author's considerations", new ConsiderationsSetting(_team, "admin.considerations", _status)),
            };
        }

        private static string Short(string role) => role switch { "Admin" => "Adm", "Modeller" => "Mod", "Reviewer" => "Rev", _ => role };

        private TeamMember? Picked => _teamTable?.Selected?.Tag as TeamMember;

        private void AskAddPerson()
        {
            var store = new SettingStore(new InMemoryUserSettings());
            var name = new TextSetting("Name", placeholder: "Their name");
            var user = new TextSetting("Revit user name", hint: "The plugin matches this name to decide what they can see.", mono: true);
            var role = new ChoiceSetting(store, "role", "Role", new[] { "Modeller", "Lead", "Reviewer", "Viewer", "Admin" }, dropdown: true);
            var disc = new MultiSetting(store, "disc", "Disciplines", DisciplineCodes, new string[0]);
            _ask(DialogViewModel.WithItems("Add person", "They see only what their role allows the next time they open the model.",
                new SettingItem[] { name, user, role, disc }, "Add",
                () => Task.FromResult(_admin.AddPerson(name.Value, user.Value, role.Selected, string.Join(" ", disc.On)))));
        }

        private void AskChangeRole()
        {
            var store = new SettingStore(new InMemoryUserSettings());
            var people = _admin.Team.Where(t => t.Role != "Admin" || t != _admin.Team.First()).Select(t => t.RevitUser + " · " + t.Name).ToList();
            var start = Picked == null ? 0 : Math.Max(0, people.FindIndex(p => p.StartsWith(Picked.RevitUser + " ")));
            var person = new ChoiceSetting(store, "person", "Person", people, start, dropdown: true);
            var role = new ChoiceSetting(store, "role", "New role", _admin.Roles, 0, dropdown: true);
            var disc = new MultiSetting(store, "disc", "Disciplines", DisciplineCodes, new string[0]);
            var reason = new TextSetting("Reason (goes in the audit log)");
            _ask(DialogViewModel.WithItems("Change role", "", new SettingItem[] { person, role, disc, reason }, "Change role",
                () => Task.FromResult(_admin.ChangeRole(person.Selected.Split(' ')[0], role.Selected, string.Join(" ", disc.On), reason.Value))));
        }

        private void AskRemove()
        {
            var m = Picked;
            if (m == null)
            {
                _status("Remove: pick a person in the team table first.");
                return;
            }
            _ask(new DialogViewModel("Remove " + m.Name, m.RevitUser + " leaves the team file. They keep their files; the plugin shows them nothing until they are added again.",
                "Remove", () => { _admin.Remove(m.RevitUser); _status(m.Name + " removed. Logged in the audit log."); return Task.CompletedTask; }));
        }

        private void AskEditPermissions()
        {
            var store = new SettingStore(new InMemoryUserSettings());
            var role = new ChoiceSetting(store, "role", "Role", new[] { "Lead", "Modeller", "Reviewer", "Viewer" }, dropdown: true);
            var families = new ChoiceSetting(store, "families", "Families", new[] { "Full, own discipline", "Check and add parameters", "Read", "Hidden" }, dropdown: true);
            var sheets = new ChoiceSetting(store, "sheets", "Sheets", new[] { "Full, own discipline", "Place views", "Read", "Hidden" }, dropdown: true);
            var annotate = new ChoiceSetting(store, "annotate", "Annotate", new[] { "Run on live model, own discipline", "Own views only", "Hidden" }, dropdown: true);
            var reviews = new ChoiceSetting(store, "reviews", "Reviews", new[] { "Raise, assign and close", "Fix and write solution", "Raise and check", "Read" }, dropdown: true);
            var workshare = new ChoiceSetting(store, "workshare", "Workshare", new[] { "Worksets, own discipline", "Sync form and sync", "Read", "Hidden" }, dropdown: true);
            var ai = new ToggleSetting(store, "ai", "Use AI buttons", true, "Within the cap per person");
            var note = new NoteSetting("Admin rights cannot be given here. Use Change role.", ChipKind.Warn);
            string Code(string text) => text switch
            {
                "Full, own discipline" => "Disc.", "Run on live model, own discipline" => "Live", "Worksets, own discipline" => "Disc.",
                "Check and add parameters" => "Check", "Place views" => "Place", "Own views only" => "Own", "Raise, assign and close" => "Close",
                "Fix and write solution" => "Fix", "Raise and check" => "Check", "Sync form and sync" => "Sync", "Hidden" => "—", _ => text,
            };
            _ask(DialogViewModel.WithItems("Edit permissions", "", new SettingItem[] { role, families, sheets, annotate, reviews, workshare, ai, note }, "Save permissions",
                () =>
                {
                    _admin.SetPermission("Families", role.Selected, Code(families.Selected));
                    _admin.SetPermission("Sheets", role.Selected, Code(sheets.Selected));
                    _admin.SetPermission("Annotate", role.Selected, Code(annotate.Selected));
                    _admin.SetPermission("Reviews", role.Selected, Code(reviews.Selected));
                    _admin.SetPermission("Workshare", role.Selected, Code(workshare.Selected));
                    _admin.SetPermission("AI buttons", role.Selected, ai.IsOn ? "Cap" : "—");
                    _status("Permissions saved for " + role.Selected + ". Logged in the audit log.");
                    return Task.FromResult<string?>(null);
                }));
        }

        private void AskResetPermissions() => _ask(new DialogViewModel("Reset to Formcraft defaults",
            "Every role gets the Formcraft default permissions back. People keep their roles.", "Reset",
            () => { _admin.ResetPermissions(); _status("Permissions are the Formcraft defaults again."); return Task.CompletedTask; }));

        private void AskPassAdmin()
        {
            var store = new SettingStore(new InMemoryUserSettings());
            var people = _admin.Team.Where(t => t.Role != "Admin" && t.Role != "Viewer").Select(t => t.RevitUser + " · " + t.Name).ToList();
            var to = new ChoiceSetting(store, "to", "New admin", people, dropdown: true);
            var keep = new ToggleSetting(store, "keep", "Keep me as backup admin", true);
            _ask(DialogViewModel.WithItems("Pass admin to someone else", "The new admin's computer gets the admin key when they accept. Until then you stay admin.",
                new SettingItem[] { to, keep }, "Send handover",
                () => { _admin.PassAdmin(to.Selected.Split(' ')[0], keep.IsOn); _status("Handover sent. You stay admin until they accept."); return Task.FromResult<string?>(null); }));
        }

        // ---------- Licences and seats (account/PaneSeats) ----------
        private IReadOnlyList<SettingsGroup> LicencesAndSeats() => new[]
        {
            new SettingsGroup("Subscription",
                new ReadOnlySetting("Plan", "Formcraft Revit Tools · Team · renews 31 Dec 2026"),
                new ReadOnlySetting("Billing contact", "[NAME B] · on the account website"),
                new ButtonsSetting("", new[] { new SettingButton("Open the account website", new RelayCommand(() => _status("Open the account website: buying, renewals and invoices happen there, never in Revit."))) })),
            new SettingsGroup("Seats by module",
                new TableSetting("", new[] { "Module", "Used", "Seats" }, _admin.Seats.Select(s => new TableRow(s, s.Module.ToString(), s.Used, s.Seats)))),
            new SettingsGroup("People",
                new TableSetting("", new[] { "Person", "Role", "Modules", "Last check" }, _admin.SeatHolders.Select(h => new TableRow(h, h.Person, h.Role, h.Modules, h.LastCheck))),
                new ButtonsSetting("", new[]
                {
                    new SettingButton("Invite a person", new RelayCommand(AskInvite)),
                    new SettingButton("Assign seats", new RelayCommand(() => _status("Assign seats: pick who holds which modules (with the licence service, U17)."))),
                    new SettingButton("Make offline licence file", new RelayCommand(() => _status("Made FMC_Licence_<PC>.lic for a PC with no internet: works 30 days, then needs a check-in (sample)."))),
                })),
            new SettingsGroup("Requests", _admin.Requests.Count == 0
                ? new SettingItem[] { new NoteSetting("No requests waiting.") }
                : _admin.Requests.Select(r => (SettingItem)new ButtonsSetting(r.Text, new[]
                    {
                        new SettingButton("Approve", new RelayCommand(() => { _admin.Approve(r); _status("Approved " + r.Module + " for " + r.Person + "."); }), primary: true),
                    })).ToArray()),
            new SettingsGroup("Rules",
                new NoteSetting("Seat lists show who holds a licence. They are never used to rank people (Manual 14.5).", ChipKind.Warn),
                new ToggleSetting(_team, "admin.twostep", "Require two-step sign-in", true),
                new ToggleSetting(_team, "admin.claudepane", "Ask AI in the pane", false, "Organisation key for the AI provider you choose, 200,000 tokens per PC per day")),
        };

        // ---------- AI involvement (core/PaneAdminAI, U28; docs/AI_ASSISTED_MODELLER.md) ----------
        public static readonly string[] AiLevels = { "Off", "Suggest", "Fix with approval", "Auto in WIP" };

        public AiPolicy? Policy => _policy;
        public IReadOnlyList<AiQueueLine> Queue => _queue;
        public MessagesSetting AiMessages => _aiMessages;

        public async Task LoadAi()
        {
            _policy = await _ai.StatusAsync();
            _queue = await _ai.QueueAsync();
            _aiDraft.SetBool("ai.on", _policy.On);
            _aiDraft.Set("ai.involvement", _policy.Involvement.ToString());
            foreach (var g in _policy.Groups) _aiDraft.Set("ai.level." + g.Id, g.Level);
            if (_section == Sections[2]) Rebuild();
        }

        private IReadOnlyList<SettingsGroup> AiInvolvement()
        {
            var p = _policy;
            if (p == null) return new[] { new SettingsGroup("AI modelling", new NoteSetting("Reading the policy…", ChipKind.Grey)) };
            var store = new SettingStore(_aiDraft, "");
            var groups = new List<SettingsGroup>();

            var head = new List<SettingItem>();
            if (!p.Ok) head.Add(new NoteSetting(p.Message, ChipKind.Bad));
            groups.Add(new SettingsGroup("General AI switch",
                new NoteSetting(p.GeneralLine + (p.Project.Length > 0 ? " Project " + p.Project + "." : ""), p.General == "On" ? ChipKind.Good : p.General == "Stopped" ? ChipKind.Bad : ChipKind.Info),
                new NoteSetting("The one switch users see (top of the pane, and AI switch on the ribbon). On: AI may model in the open WIP model, every batch waits for one-click approval, the limits apply. Deleting, purging, running code, links and worksets stay with admins. The settings below are Advanced.", ChipKind.Grey)));
            if (!p.GuardSection) head.Add(new NoteSetting("Not set up: fmc_guard.json has no ai_modeller section yet. The AI switch creates it the first time anyone uses it.", ChipKind.Info));
            if (p.Rulebook.Length == 0)
                head.Add(new NoteSetting("The kit has no FMC_Rulebook_AIUse yet. AI modelling stays Off until the BIM Manager adds it through a kit change request (a proposal is in docs/kit-proposals).", ChipKind.Warn));
            if (p.Stop) head.Add(new NoteSetting("Stop AI is on: every AI change is refused.", ChipKind.Bad));
            head.Add(new ToggleSetting(store, "ai.on", "AI modelling (firm-wide switch)", false, "Off refuses every AI change, whatever the levels say. Only admins change it."));
            head.Add(new TextSetting("Involvement level, 0–100%", _aiDraft.Get("ai.involvement") ?? "20", "20", store: store, key: "ai.involvement",
                hint: "1–20 Assist · 21–50 Co-model · 51–80 Lead · 81–100 Full (bands from the kit rulebook)"));
            groups.Add(new SettingsGroup("Advanced · involvement (admins)", head.ToArray()));

            var levels = new List<SettingItem>();
            foreach (var g in p.Groups)
            {
                var options = g.AutoAllowed ? AiLevels : AiLevels.Take(3).ToArray();
                levels.Add(new ChoiceSetting(store, "ai.level." + g.Id, g.Name, options, Math.Max(0, Array.IndexOf(options, g.Level)), dropdown: true,
                    hint: (g.AllowedNow ? "Allowed now on " + p.Model : g.Why) + (g.AutoAllowed ? "" : " · never Auto")));
            }
            if (p.Groups.Count == 0) levels.Add(new NoteSetting("The groups come from the kit rulebook.", ChipKind.Grey));
            levels.Add(new ButtonsSetting("", new[] { new SettingButton("Save policy", new RelayCommand(AskSave), primary: true) }));
            levels.Add(_aiMessages);
            groups.Add(new SettingsGroup("Advanced · operation groups, level each (admins)", levels.ToArray()));

            var waiting = new List<SettingItem>();
            var pending = _queue.Where(q => q.Status == "pending").ToList();
            if (pending.Count == 0) waiting.Add(new NoteSetting("Nothing is waiting. A batch at Fix with approval waits here for the model's author.", ChipKind.Grey));
            foreach (var q in pending.Take(10))
                waiting.Add(new ButtonsSetting(q.Id + " · " + q.Summary + " · " + q.Model, new[]
                {
                    new SettingButton("Approve", new AsyncCommand(() => Decide(q.Id, true), _status), primary: true),
                    new SettingButton("Reject", new AsyncCommand(() => Decide(q.Id, false), _status)),
                }));
            if (_queue.Count > 0)
                waiting.Add(new TableSetting("Recent batches", new[] { "Batch", "Model", "What", "Status" },
                    _queue.Take(20).Select(q => new TableRow(q, q.Id, q.Model, q.Summary, q.Status))));
            groups.Add(new SettingsGroup("Waiting for approval", waiting.ToArray()));

            groups.Add(new SettingsGroup("Stop AI",
                new NoteSetting(p.Stop ? "Stopped. Resume lets AI work again at the levels above." : "Anyone on the project can stop AI at once; every AI change is then refused.", p.Stop ? ChipKind.Bad : ChipKind.Info),
                new ButtonsSetting("", new[] { p.Stop
                    ? new SettingButton("Resume AI", new AsyncCommand(() => StopAi(false), _status), primary: true)
                    : new SettingButton("Stop AI", new AsyncCommand(() => StopAi(true), _status)) })));

            groups.Add(new SettingsGroup("Admins only, always",
                new NoteSetting("Deleting, purging, running arbitrary code, links and coordinates, workset setup and structural framing; central, shared or published models; sync, issue and signatures; loads, sizes and demand factors. "
                                + (p.Limits.Length > 0 ? "Limits: " + p.Limits + ". " : "")
                                + "The AI log counts work per model, never per person (Manual 14.5).", ChipKind.Warn)));
            return groups;
        }

        private void AskSave()
        {
            if (_policy == null) return;
            bool on = _aiDraft.GetBool("ai.on", false);
            if (!int.TryParse(_aiDraft.Get("ai.involvement") ?? "", out int involvement) || involvement < 0 || involvement > 100)
            {
                _aiMessages.Show(ChipKind.Warn, "The involvement level is a whole number from 0 to 100.");
                return;
            }
            var levels = _policy.Groups.ToDictionary(g => g.Id, g => _aiDraft.Get("ai.level." + g.Id) ?? g.Level);
            var changes = new List<string>();
            if (on != _policy.On) changes.Add("AI modelling: " + (on ? "On" : "Off"));
            if (involvement != _policy.Involvement) changes.Add($"Involvement: {_policy.Involvement}% → {involvement}%");
            foreach (var g in _policy.Groups) if (levels[g.Id] != g.Level) changes.Add($"{g.Name}: {g.Level} → {levels[g.Id]}");
            if (changes.Count == 0) { _aiMessages.Show(ChipKind.Info, "Nothing changed."); return; }
            _ask(DialogViewModel.WithItems("Save the AI policy?", "It applies to every open model at once, and it is logged.",
                new SettingItem[] { new ReadOnlySetting("Changes", string.Join(Environment.NewLine, changes), mono: true) }, "Save", async () =>
                {
                    var r = await _ai.SaveAsync(on, involvement, levels);
                    _aiMessages.Show(r.Messages);
                    _status(r.Messages.FirstOrDefault()?.Text ?? "Saved.");
                    await LoadAi();
                    return null;
                }));
        }

        private async Task Decide(string id, bool approve)
        {
            var r = await _ai.DecideAsync(id, approve);
            _aiMessages.Show(r.Messages);
            _status(r.Messages.FirstOrDefault()?.Text ?? "");
            await LoadAi();
        }

        private async Task StopAi(bool stop)
        {
            var r = await _ai.StopAsync(stop);
            _aiMessages.Show(r.Messages);
            _status(r.Messages.FirstOrDefault()?.Text ?? "");
            await LoadAi();
        }

        private void AskInvite()
        {
            var store = new SettingStore(new InMemoryUserSettings());
            var email = new TextSetting("Email", placeholder: "name@company.com");
            var role = new ChoiceSetting(store, "role", "Role", new[] { "Modeller", "BIM Coordinator", "QS / Commercial", "Planner", "Engineer" }, dropdown: true);
            var modules = new MultiSetting(store, "modules", "Modules", new[] { "Manage", "Flow", "Model", "Build" }, new[] { "Manage" });
            _ask(DialogViewModel.WithItems("Invite a person", "", new SettingItem[] { email, role, modules }, "Send invite",
                () =>
                {
                    var problem = _admin.Invite(email.Value, role.Selected, modules.On.Select(m => (FmcModule)Enum.Parse(typeof(FmcModule), m)));
                    if (problem == null) _status("Invite sent to " + email.Value.Trim() + ".");
                    return Task.FromResult(problem);
                }));
        }
    }
}
