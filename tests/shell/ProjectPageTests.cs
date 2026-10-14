using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U13: Setup › Project (board manage/PaneProject).</summary>
    public class ProjectPageTests
    {
        private sealed class Refusing : IProjectTools
        {
            public Task<ToolResult> RunAsync(ProjectRequest request, bool dryRun) =>
                Task.FromResult(ToolResult.Refused(@"Z:\Projects\F26001 isn't empty (old.rvt). The tree is only built in an empty folder (D5)"));
        }

        private sealed class Pane
        {
            public MockLicenceService Licence { get; } = new MockLicenceService();
            public MockProjectTools Tools { get; } = new MockProjectTools();
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public ShellViewModel Vm { get; }

            public Pane(IProjectTools? tools = null)
            {
                Settings.SetBool(SettingKeys.SetupDone, true);
                Settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), Settings, theme: new ThemeService(),
                                        project: tools ?? Tools);
                Licence.SetSignedIn();
                Vm.SelectSectionCommand.Execute(Vm.Groups.SelectMany(g => g.Sections).Single(s => s.Name == "Project"));
            }
        }

        private static T OnSta<T>(Func<T> read) => Sta.Run(read);

        [Test]
        public async Task Project_has_the_boards_groups_and_footer()
        {
            var (groups, footer) = OnSta(() =>
            {
                var p = new Pane();
                return (p.Vm.Project.Groups.Select(g => g.Title).ToList(), string.Join(",", p.Vm.FooterActions.Select(a => a.Label)));
            });
            await Assert.That(groups).IsEquivalentTo(new[] { "Where", "Project details · written to Project Information", "Who and what",
                "Naming convention · from the kit", "Stage and issue", "Project manifest", "Start", "Author's considerations" });
            await Assert.That(footer).IsEqualTo("Start (dry run),Preview");
        }

        [Test]
        public async Task Folder_and_code_are_checked_as_you_type()
        {
            var dir = Path.Combine(Path.GetTempPath(), "fmc_project_" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            try
            {
                var checks = OnSta(() =>
                {
                    var p = new Pane();
                    p.Settings.Set("settings.project.folder", dir);
                    p.Settings.Set("settings.project.code", "f26001");
                    p.Vm.Project.Opened();
                    return p.Vm.Project.Groups[0].Items.OfType<CheckListSetting>().Single().Rows.Select(r => r.Label + "=" + r.Status).ToList();
                });
                await Assert.That(checks).IsEquivalentTo(new[] { "Folder exists=OK", "Folder is empty=OK", "Project code=F26001 passes" });
            }
            finally { Directory.Delete(dir, true); }
        }

        [Test]
        public async Task Request_takes_codes_roles_details_and_stage()
        {
            var q = OnSta(() =>
            {
                var p = new Pane();
                p.Settings.Set("settings.project.folder", @"Z:\Projects\F26001");
                p.Settings.Set("settings.project.code", "f26001");
                p.Settings.Set("settings.project.d.FMC_Project_Name", "Pilot House");
                p.Settings.Set("settings.project.d.FMC_Plot_No", "  ");
                return p.Vm.Project.Request();
            });
            await Assert.That(q.Code).IsEqualTo("F26001");
            await Assert.That(q.Roles).IsEquivalentTo(new[] { "A", "S", "M", "E", "P" });
            await Assert.That(q.Details["FMC_Project_Name"]).IsEqualTo("Pilot House");
            await Assert.That(q.Details.ContainsKey("FMC_Plot_No")).IsFalse();
            await Assert.That(q.Stage).IsEqualTo("G3");
            await Assert.That(q.Originator + q.Volume + q.Level).IsEqualTo("FMCZZZZ");
        }

        [Test]
        public async Task Start_runs_a_dry_run_asks_then_starts()
        {
            var (title, runs, message) = OnSta(() =>
            {
                var p = new Pane();
                p.Settings.Set("settings.project.code", "F26001");
                p.Vm.Project.StartCommand.Execute(null);
                var t = p.Vm.Dialog!.Title;
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                return (t, p.Tools.Runs.Select(r => r.Dry).ToList(), p.Vm.Project.Messages.Lines.Single().Text);
            });
            await Assert.That(title).IsEqualTo("Start F26001?");
            await Assert.That(runs).IsEquivalentTo(new[] { true, false });
            await Assert.That(message).Contains("Started F26001");
        }

        [Test]
        public async Task A_refused_start_says_why_and_asks_nothing()
        {
            var (dialog, message) = OnSta(() =>
            {
                var p = new Pane(new Refusing());
                p.Vm.Project.StartCommand.Execute(null);
                return (p.Vm.Dialog, p.Vm.Project.Messages.Lines.Single().Text);
            });
            await Assert.That(dialog).IsNull();
            await Assert.That(message).Contains("isn't empty");
        }
    }
}
