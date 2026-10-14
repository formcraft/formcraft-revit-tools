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
        public static readonly string[] Sections = { "Team and roles", "Licences and seats" };
        private static readonly string[] DisciplineCodes = { "Z", "A", "S", "M", "E", "P", "FP", "C", "L" };

        private readonly IAdminService _admin;
        private readonly ILicenceService _licence;
        private readonly SettingStore _team;
        private readonly Action<string> _status;
        private readonly Action<DialogViewModel> _ask;
        private string _section = Sections[0];
        private IReadOnlyList<SettingsGroup> _groups = new SettingsGroup[0];
        private TableSetting? _teamTable;

        public AdminViewModel(IAdminService admin, ILicenceService licence, Action<string> status, Action<DialogViewModel> ask)
        {
            _admin = admin;
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
            }
        }

        public string SectionHint => _section == Sections[0]
            ? "Only admins see this. Roles hide and lock the plugin's own buttons; real file protection comes from folder permissions or a common data environment."
            : "Plan and renewal, seats per module, who holds which modules, invites, offline licence files and module requests. Payments stay on the account website.";

        public IReadOnlyList<SettingsGroup> Groups { get => _groups; private set => Set(ref _groups, value); }

        public void Rebuild() => Groups = _section == Sections[0] ? TeamAndRoles() : LicencesAndSeats();

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
