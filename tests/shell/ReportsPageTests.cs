using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U21: Check › Reports (board manage/PaneReports).</summary>
    public class ReportsPageTests
    {
        private static (ShellViewModel Vm, MockReportTools Tools, InMemoryUserSettings Settings) Pane(bool project = true)
        {
            var tools = new MockReportTools();
            var s = new InMemoryUserSettings();
            s.SetBool(SettingKeys.SetupDone, true);
            s.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
            if (project) { s.Set("settings.project.folder", @"Z:\Projects\F26001"); s.Set("settings.project.code", "F26001"); }
            var licence = new MockLicenceService();
            var vm = new ShellViewModel(licence, new MockConnectionService(), new MockDocumentContext(), s, theme: new ThemeService(), reports: tools);
            licence.SetSignedIn();
            vm.SelectSectionCommand.Execute(vm.Groups.SelectMany(g => g.Sections).Single(x => x.Name == "Reports"));
            return (vm, tools, s);
        }

        [Test]
        public async Task A_client_report_is_previewed_then_made_with_the_choices()
        {
            var (leftOut, made, recent) = Sta.Run(() =>
            {
                var (vm, tools, s) = Pane();
                s.Set("settings.reports.audience", "Client");
                s.Set("settings.reports.kind", "Review register");
                vm.Reports.PreviewCommand.Execute(null);
                var note = vm.Dialog!.Items.OfType<NoteSetting>().Single().Text;
                vm.Dialog.ConfirmCommand!.Execute(null);
                var table = vm.Reports.Groups.Single(g => g.Title == "Recent reports").Items.OfType<TableSetting>().Single();
                return (note, tools.Made.Single(), table.Rows.Count);
            });
            await Assert.That(leftOut).Contains("names");
            await Assert.That(made.Audience).IsEqualTo("Client");
            await Assert.That(made.Kind).IsEqualTo("Review register");
            await Assert.That(made.ProjectCode).IsEqualTo("F26001");
            await Assert.That(recent).IsEqualTo(1);
        }

        [Test]
        public async Task Without_a_project_or_a_format_nothing_is_made()
        {
            var (noProject, noFormat, made) = Sta.Run(() =>
            {
                var (vm1, _, _) = Pane(project: false);
                vm1.Reports.MakeCommand.Execute(null);
                var a = vm1.Status;
                var (vm2, tools, s) = Pane();
                s.Set("settings.reports.formats", "");
                vm2.Reports.MakeCommand.Execute(null);
                return (a, vm2.Status, tools.Made.Count);
            });
            await Assert.That(noProject).Contains("project folder");
            await Assert.That(noFormat).Contains("format");
            await Assert.That(made).IsEqualTo(0);
        }
    }
}
