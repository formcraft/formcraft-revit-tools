using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U07: Admin (boards core/PaneAdmin, account/PaneSeats).</summary>
    public class AdminTests
    {
        private sealed class Pane
        {
            public MockLicenceService Licence { get; } = new MockLicenceService();
            public MockAdminService AdminService { get; } = new MockAdminService();
            public ShellViewModel Vm { get; }

            public Pane()
            {
                var settings = new InMemoryUserSettings();
                settings.SetBool(SettingKeys.SetupDone, true);
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), settings, theme: new ThemeService(), admin: AdminService);
                Licence.SignInAsync("a@formcraft.example", "x").GetAwaiter().GetResult();
                Licence.VerifyCodeAsync("123456").GetAwaiter().GetResult();
            }

            public AdminViewModel A => Vm.Admin;
            public T Item<T>(string group, string label = "") where T : SettingItem =>
                A.Groups.Single(g => g.Title == group).Items.OfType<T>().First(i => label.Length == 0 || i.Label == label);
            public SettingButton Button(string label) =>
                A.Groups.SelectMany(g => g.Items).OfType<ButtonsSetting>().SelectMany(b => b.Buttons).First(b => b.Label == label);
            public T Row<T>(string label) where T : SettingItem => Vm.Dialog!.Items.OfType<T>().First(i => i.Label == label);
        }

        private static T OnSta<T>(Func<T> read) => Sta.Run(read);

        [Test]
        public async Task Both_sections_have_every_group_on_the_boards()
        {
            var (team, seats) = OnSta(() =>
            {
                var p = new Pane();
                var t = string.Join(" | ", p.A.Groups.Select(g => g.Title));
                p.A.Section = "Licences and seats";
                return (t, string.Join(" | ", p.A.Groups.Select(g => g.Title)));
            });

            await Assert.That(team).IsEqualTo("You | Team | Permissions by role | Project settings | AI | Automation | Project data · version bridge (Phase 2) | Modules and licences | Audit log | Handover | Author's considerations");
            await Assert.That(seats).IsEqualTo("Subscription | Seats by module | People | Requests | Rules");
        }

        [Test]
        public async Task Only_admins_open_Admin()
        {
            var (admin, notAdmin) = OnSta(() =>
            {
                var p = new Pane();
                p.Vm.Screen = ShellScreen.Main;
                p.Vm.OpenAdminCommand.Execute(null);
                var a = p.Vm.IsAdminOpen;

                var licence = new SectionsTests.TestLicence();
                var vm = new ShellViewModel(licence, new MockConnectionService(), new MockDocumentContext(), new InMemoryUserSettings(), theme: new ThemeService());
                licence.Grant((FmcModule.Manage, ModuleStatus.Active)); // TestLicence's account is not an admin
                vm.OpenAdminCommand.Execute(null);
                return (a, vm.IsAdminOpen || vm.IsAdmin);
            });

            await Assert.That(admin).IsTrue();
            await Assert.That(notAdmin).IsFalse();
        }

        [Test]
        public async Task The_footer_has_Open_team_file_and_Save()
        {
            var footer = OnSta(() =>
            {
                var p = new Pane();
                p.Vm.Screen = ShellScreen.Main;
                p.Vm.OpenAdminCommand.Execute(null);
                return string.Join(",", p.Vm.FooterActions.Select(f => f.Label));
            });

            await Assert.That(footer).IsEqualTo("Open team file,Save");
        }

        [Test]
        public async Task Add_person_checks_the_rows_and_logs_the_change()
        {
            var (problem, rows, audit) = OnSta(() =>
            {
                var p = new Pane();
                p.Button("Add person…").Command.Execute(null);
                p.Row<TextSetting>("Name").Value = "[NAME F]";
                p.Vm.Dialog!.ConfirmCommand!.Execute(null);
                var pr = p.Vm.Dialog?.Error;
                p.Row<TextSetting>("Revit user name").Value = "name.f";
                p.Row<ChoiceSetting>("Role").Selected = "Reviewer";
                p.Row<MultiSetting>("Disciplines").Options.Single(o => o.Name == "E").IsOn = true;
                p.Vm.Dialog!.ConfirmCommand!.Execute(null);
                var team = p.Item<TableSetting>("Team");
                return (pr, team.Rows.Count, p.AdminService.Audit[0].Change);
            });

            await Assert.That(problem).IsEqualTo("Enter their Revit user name: the plugin matches it to decide what they see.");
            await Assert.That(rows).IsEqualTo(7);
            await Assert.That(audit).IsEqualTo("Added name.f as Reviewer");
        }

        [Test]
        public async Task Change_role_needs_a_reason_for_the_audit_log()
        {
            var (problem, audit) = OnSta(() =>
            {
                var p = new Pane();
                var team = p.Item<TableSetting>("Team");
                team.Selected = team.Rows.Single(r => r.Cells[1] == "name.d");
                p.Button("Change role…").Command.Execute(null);
                p.Row<ChoiceSetting>("New role").Selected = "Lead";
                p.Vm.Dialog!.ConfirmCommand!.Execute(null);
                var pr = p.Vm.Dialog?.Error;
                p.Row<TextSetting>("Reason (goes in the audit log)").Value = "Leads the A model";
                p.Vm.Dialog!.ConfirmCommand!.Execute(null);
                return (pr, p.AdminService.Audit[0].Change);
            });

            await Assert.That(problem).IsEqualTo("Give a reason: it goes in the audit log.");
            await Assert.That(audit).IsEqualTo("name.d: Modeller → Lead · Leads the A model");
        }

        [Test]
        public async Task Remove_asks_first()
        {
            var (needsPick, title, after) = OnSta(() =>
            {
                var p = new Pane();
                p.Button("Remove").Command.Execute(null);
                var n = p.Vm.Status;
                var team = p.Item<TableSetting>("Team");
                team.Selected = team.Rows.Single(r => r.Cells[1] == "viewer01");
                p.Button("Remove").Command.Execute(null);
                var t = p.Vm.Dialog!.Title;
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                return (n, t, p.AdminService.Team.Any(m => m.RevitUser == "viewer01"));
            });

            await Assert.That(needsPick).IsEqualTo("Remove: pick a person in the team table first.");
            await Assert.That(title).IsEqualTo("Remove Client QS");
            await Assert.That(after).IsFalse();
        }

        [Test]
        public async Task Permissions_edit_and_reset_and_admin_rights_are_never_given_here()
        {
            var (edited, reset, adminUnchanged) = OnSta(() =>
            {
                var p = new Pane();
                p.Button("Edit permissions…").Command.Execute(null);
                p.Row<ChoiceSetting>("Role").Selected = "Reviewer";
                p.Row<ChoiceSetting>("Sheets").Selected = "Hidden";
                p.Vm.Dialog!.ConfirmCommand!.Execute(null);
                var e = p.AdminService.Permission("Sheets", "Reviewer");
                p.AdminService.SetPermission("Project", "Admin", "Read");
                var a = p.AdminService.Permission("Project", "Admin");
                p.Button("Reset to Formcraft defaults").Command.Execute(null);
                p.Vm.Dialog!.ConfirmCommand!.Execute(null);
                return (e, p.AdminService.Permission("Sheets", "Reviewer"), a);
            });

            await Assert.That(edited).IsEqualTo("—");
            await Assert.That(reset).IsEqualTo("Read");
            await Assert.That(adminUnchanged).IsEqualTo("Full");
        }

        [Test]
        public async Task Scheduled_sync_stays_off_and_locked()
        {
            var (locked, on) = OnSta(() =>
            {
                var p = new Pane();
                var sync = p.Item<ToggleSetting>("Automation", "Scheduled sync for this project");
                sync.IsOn = true;
                return (sync.Locked, sync.IsOn);
            });

            // CLAUDE.md rule 6: workshared models are never saved or synchronised by a tool.
            await Assert.That(locked).IsTrue();
            await Assert.That(on).IsFalse();
        }

        [Test]
        public async Task Modules_and_licences_follow_the_licence()
        {
            var rows = OnSta(() => string.Join(" | ", new Pane().Item<TableSetting>("Modules and licences").Rows.Select(r => string.Join(" ", r.Cells))));

            await Assert.That(rows).IsEqualTo("Core All Always | Manage 7 of 8 Licensed | Flow 9 of 10 Licensed | Model 2 of 2 trial Licensed | Build — Not yet");
        }

        [Test]
        public async Task Approving_a_request_clears_it()
        {
            var (before, after, holder) = OnSta(() =>
            {
                var p = new Pane();
                p.A.Section = "Licences and seats";
                var b = p.A.Groups.Single(g => g.Title == "Requests").Items.OfType<ButtonsSetting>().Single().Label;
                p.Button("Approve").Command.Execute(null);
                var a = p.A.Groups.Single(g => g.Title == "Requests").Items.OfType<NoteSetting>().Single().Text;
                return (b, a, p.AdminService.SeatHolders.Single(h => h.Person == "[NAME D]").Modules);
            });

            await Assert.That(before).IsEqualTo("[NAME D] asks for Build");
            await Assert.That(after).IsEqualTo("No requests waiting.");
            await Assert.That(holder).IsEqualTo("M B");
        }

        [Test]
        public async Task Invite_needs_an_email()
        {
            var (problem, audit) = OnSta(() =>
            {
                var p = new Pane();
                p.A.Section = "Licences and seats";
                p.Button("Invite a person").Command.Execute(null);
                p.Vm.Dialog!.ConfirmCommand!.Execute(null);
                var pr = p.Vm.Dialog?.Error;
                p.Row<TextSetting>("Email").Value = "new.person@formcraft.example";
                p.Vm.Dialog!.ConfirmCommand!.Execute(null);
                return (pr, p.AdminService.Audit[0].Change);
            });

            await Assert.That(problem).IsEqualTo("Enter their work email.");
            await Assert.That(audit).IsEqualTo("Invited new.person@formcraft.example as Modeller (Manage)");
        }

        [Test]
        public async Task Team_values_are_kept_and_the_audit_log_shows_changes()
        {
            var (cap, top) = OnSta(() =>
            {
                var p = new Pane();
                p.Item<TextSetting>("AI", "Team cap (USD/month)").Value = "60";
                p.A.Rebuild();
                p.Button("Add person…").Command.Execute(null);
                p.Row<TextSetting>("Name").Value = "[NAME G]";
                p.Row<TextSetting>("Revit user name").Value = "name.g";
                p.Vm.Dialog!.ConfirmCommand!.Execute(null);
                return (p.Item<TextSetting>("AI", "Team cap (USD/month)").Value, p.Item<TableSetting>("Audit log").Rows[0].Cells[2]);
            });

            await Assert.That(cap).IsEqualTo("60");
            await Assert.That(top).IsEqualTo("Added name.g as Modeller");
        }
    }
}
