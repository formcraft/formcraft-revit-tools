using System;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>The families and files tools in the pane's own design (Setup › Families, Setup › Templates).</summary>
    public class SetupPagesTests
    {
        private sealed class Picker : IFilePicker
        {
            public string? Next { get; set; }
            public string? Open(string title, string filter, string startFolder) => Next;
            public string? Save(string title, string filter, string fileName, string startFolder) => Next;
            public string? Folder(string title, string startFolder) => Next;
        }

        private sealed class Pane
        {
            public MockLicenceService Licence { get; } = new MockLicenceService();
            public MockFamilyTools Families { get; } = new MockFamilyTools();
            public MockFileTools Files { get; } = new MockFileTools();
            public MockTemplateTools Templates { get; } = new MockTemplateTools();
            public MockLibraryTools Library { get; } = new MockLibraryTools();
            public Picker Picker { get; } = new Picker();
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public ShellViewModel Vm { get; }

            public Pane()
            {
                Settings.SetBool(SettingKeys.SetupDone, true);
                Settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), Settings, theme: new ThemeService(),
                                        families: Families, files: Files, picker: Picker, templates: Templates, library: Library);
                Licence.SetSignedIn();
            }

            public void Open(string section) => Vm.SelectSectionCommand.Execute(Vm.Groups.SelectMany(g => g.Sections).Single(s => s.Name == section));
        }

        private static T OnSta<T>(Func<T> read) => Sta.Run(read);

        [Test]
        public async Task Families_opens_its_own_page_with_the_pilot_set_ticked_and_planned()
        {
            var (host, picked, status, footer) = OnSta(() =>
            {
                var p = new Pane();
                p.Open("Families");
                var rows = p.Vm.Families.List.Rows;
                return (p.Vm.HostContent == p.Vm.Families, rows.Where(r => r.On).Select(r => r.Family).ToList(),
                        rows.Single(r => r.Family.Contains("FanCoil")).Status, string.Join(",", p.Vm.FooterActions.Select(a => a.Label)));
            });
            await Assert.That(host).IsTrue();
            await Assert.That(picked).IsEquivalentTo(new[] { "FMC_E_ElecFixture_SocketDouble", "FMC_P_PlumbFixture_WCSuite" });
            await Assert.That(status).IsEqualTo("Problem");
            await Assert.That(footer).IsEqualTo("Scan file,Bring in,Build");
        }

        [Test]
        public async Task Build_runs_a_dry_run_asks_then_builds()
        {
            var (title, builtBefore, built, chip) = OnSta(() =>
            {
                var p = new Pane();
                p.Open("Families");
                p.Vm.Families.BuildCommand.Execute(null);
                var t = p.Vm.Dialog!.Title;
                var before = p.Families.Built.Count;
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                return (t, before, p.Families.Built.ToList(), p.Vm.Families.List.Rows.First(r => r.On).Status);
            });
            await Assert.That(title).IsEqualTo("Build 2 families?");
            await Assert.That(builtBefore).IsEqualTo(0);
            await Assert.That(built.Count).IsEqualTo(2);
            await Assert.That(chip).IsEqualTo("Built");
        }

        [Test]
        public async Task Selection_is_remembered_and_quick_picks_work()
        {
            var (saved, none) = OnSta(() =>
            {
                var p = new Pane();
                p.Open("Families");
                var buttons = p.Vm.Families.Groups.Single(g => g.Title == "Build from the kit").Items.OfType<ButtonsSetting>().First().Buttons;
                buttons.Single(b => b.Label == "All").Command.Execute(null);
                var s = p.Settings.Get("settings.families.selection")!.Split('|').Length;
                buttons.Single(b => b.Label == "None").Command.Execute(null);
                p.Vm.Families.BuildCommand.Execute(null);
                return (s, p.Vm.Families.Messages.Lines.Single().Text);
            });
            await Assert.That(saved).IsEqualTo(4);
            await Assert.That(none).IsEqualTo("No families selected.");
        }

        [Test]
        public async Task The_scan_counts_states_lists_families_and_opens_one()
        {
            var (summary, rows, selected) = OnSta(() =>
            {
                var p = new Pane();
                p.Open("Families");
                p.Vm.Families.ScanCommand.Execute(null);
                var scan = p.Vm.Families.Groups.Single(g => g.Title.StartsWith("Compliance scan")).Items.OfType<ReadOnlySetting>().Single().Value;
                var table = p.Vm.Families.Groups.Single(g => g.Title.StartsWith("Families ·")).Items.OfType<TableSetting>().Single();
                var r = table.Rows.Select(x => x.Cells[0] + "|" + x.Cells[3]).ToList();
                p.Vm.Families.Select("Vendor_Socket_MK");
                var sel = p.Vm.Families.Groups.Single(g => g.Title.StartsWith("Selected ·")).Items.OfType<NoteSetting>().Last().Text;
                return (scan, r, sel);
            });
            await Assert.That(summary).IsEqualTo("3 scanned · 1 compliant · 1 fixable in one pass · 1 need a person");
            await Assert.That(rows).IsEquivalentTo(new[] { "F26001_E_ElecFixture_Isolator|Fixable", "Vendor_Socket_MK|Needs a person" });
            await Assert.That(selected).IsEqualTo("Next: The kit has no spec for this family");
        }

        [Test]
        public async Task Bring_in_checks_the_file_shows_each_step_then_runs_after_a_yes()
        {
            var (steps, title, runs) = OnSta(() =>
            {
                var p = new Pane();
                p.Open("Families");
                p.Picker.Next = @"C:\Downloads\Vendor_Socket_MK.rfa";
                p.Vm.Families.Groups.Single(g => g.Title == "Bring in a family from outside").Items.OfType<ButtonsSetting>().First().Buttons.Single().Command.Execute(null);
                p.Settings.Set("settings.families.bring.description", "socket mk");
                p.Settings.Set("settings.families.bring.keynote", "E.SOC_04");
                p.Vm.Families.CheckCommand.Execute(null);
                var st = p.Vm.Families.Groups.Single(g => g.Title == "Bring in a family from outside").Items.OfType<CheckListSetting>().Single().Rows.Select(r => r.Label + "=" + r.Status).ToList();
                p.Vm.Families.BringInCommand.Execute(null);
                var t = p.Vm.Dialog!.Title;
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                return (st, t, p.Library.BringIns.Select(b => b.Dry).ToList());
            });
            await Assert.That(steps[1]).IsEqualTo("Rename to the naming rule=→ FMC_E_ElecFixture_SocketMk");
            await Assert.That(steps[3]).IsEqualTo("Set the keynote=E.SOC_04");
            await Assert.That(title).IsEqualTo("Bring in Vendor_Socket_MK.rfa?");
            await Assert.That(runs).IsEquivalentTo(new[] { true, false });
        }

        [Test]
        public async Task Keynotes_search_and_a_new_one_is_a_request()
        {
            var (codes, next, request) = OnSta(() =>
            {
                var p = new Pane();
                p.Open("Families");
                p.Settings.Set("settings.families.keyquery", "socket");
                p.Vm.Families.SearchKeynotesCommand.Execute(null);
                var group = p.Vm.Families.Groups.Single(g => g.Title == "Keynotes");
                var c = group.Items.OfType<TableSetting>().Single().Rows.Select(r => r.Cells[0]).ToList();
                var n = group.Items.OfType<ReadOnlySetting>().Single(r => r.Label == "Next code").Value;
                p.Settings.Set("settings.families.keytext", "13 A switched socket outlet, MK");
                p.Vm.Families.RequestKeynoteCommand.Execute(null);
                return (c, n, p.Library.Requests.Single());
            });
            await Assert.That(codes).IsEquivalentTo(new[] { "E.SOC_00", "E.SOC_01", "E.SOC_02", "E.SOC_03" });
            await Assert.That(next).IsEqualTo("E.SOC_04");
            await Assert.That(request).IsEqualTo("E.SOC: 13 A switched socket outlet, MK");
        }

        [Test]
        public async Task Templates_lists_open_files_and_never_saves_a_workshared_one_or_closes_the_active_one()
        {
            var rows = OnSta(() =>
            {
                var p = new Pane();
                p.Open("Templates");
                return p.Vm.Templates.Documents.Rows.Select(r => r.CanSaveAs + "|" + r.CanClose + "|" + r.State).ToList();
            });
            await Assert.That(rows[0]).IsEqualTo("False|False|Active · Live project: AI reads, never models · workshared");
            await Assert.That(rows[1]).IsEqualTo("True|True|Family · unsaved changes");
        }

        [Test]
        public async Task A_new_model_comes_from_the_kit_template_named_by_the_project_with_its_information()
        {
            var (warning, request, title, runs) = OnSta(() =>
            {
                var p = new Pane();
                p.Open("Templates");
                p.Vm.Templates.NewFileCommand.Execute(null);
                var w = p.Vm.Templates.Messages.Lines.Single().Text;
                p.Settings.Set("settings.project.folder", @"Z:\Projects\F26001");
                p.Settings.Set("settings.project.code", "F26001");
                p.Settings.Set("settings.project.d.FMC_Project_Name", "Pilot House");
                p.Vm.Templates.Rebuild();
                p.Vm.Templates.NewFileCommand.Execute(null);
                var t = p.Vm.Dialog!.Title;
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                return (w, p.Files.Runs.Last().Request, t, p.Files.Runs.Select(r => r.Dry).ToList());
            });
            await Assert.That(warning).Contains("set the project folder and code");
            await Assert.That(request.TemplatePath).EndsWith("FMC_A_Template_v2.2.rte");
            await Assert.That(request.SavePath).IsEqualTo(@"Z:\Projects\F26001\01_WIP\A\F26001-FMC-ZZ-ZZ-M3-A-0001.rvt");
            await Assert.That(request.ProjectInfo["Project Number"]).IsEqualTo("F26001");
            await Assert.That(request.ProjectInfo["Project Name"]).IsEqualTo("Pilot House");
            await Assert.That(title).IsEqualTo("Create F26001-FMC-ZZ-ZZ-M3-A-0001.rvt?");
            await Assert.That(runs).IsEquivalentTo(new[] { true, false });
        }

        [Test]
        public async Task A_family_needs_its_template_and_target()
        {
            var (warning, runs) = OnSta(() =>
            {
                var p = new Pane();
                p.Settings.Set("settings.templates.kind", "Family");
                p.Open("Templates");
                p.Vm.Templates.NewFileCommand.Execute(null);
                var w = p.Vm.Templates.Messages.Lines.Single().Text;
                p.Picker.Next = @"C:\ProgramData\Autodesk\RVT 2025\Family Templates\English\Generic Model.rft";
                p.Vm.Templates.Groups[0].Items.OfType<ButtonsSetting>().First().Buttons.Single().Command.Execute(null);
                p.Picker.Next = @"Z:\00_Standards\04_Families\_Staging\E\FMC_E_ElecFixture_SocketMK.rfa";
                p.Vm.Templates.Groups[0].Items.OfType<ButtonsSetting>().ElementAt(1).Buttons.Single().Command.Execute(null);
                p.Vm.Templates.NewFileCommand.Execute(null);
                p.Vm.Dialog!.ConfirmCommand!.Execute(null);
                return (w, p.Files.Runs.Select(r => r.Request.Kind + ":" + r.Dry).ToList());
            });
            await Assert.That(warning).Contains("Choose a family template");
            await Assert.That(runs).IsEquivalentTo(new[] { "family:True", "family:False" });
        }

        [Test]
        public async Task The_brand_pack_comes_from_the_kit_and_is_previewed_before_it_applies()
        {
            var (fonts, title, runs) = OnSta(() =>
            {
                var p = new Pane();
                p.Open("Templates");
                var brand = p.Vm.Templates.Groups.Single(g => g.Title == "Firm look · brand pack");
                var f = string.Join(",", brand.Items.OfType<ReadOnlySetting>().Select(r => r.Value));
                p.Vm.Templates.ApplyLookCommand.Execute(null);
                var t = p.Vm.Dialog!.Title;
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                return (f, t, p.Templates.Brands.Select(b => System.IO.Path.GetFileName(b.Path) + ":" + b.Dry).ToList());
            });
            await Assert.That(fonts).IsEqualTo("Arial,Arial Bold");
            await Assert.That(title).IsEqualTo("Apply the brand pack: preview");
            await Assert.That(runs).IsEquivalentTo(new[] { "FMC_A_Template_v2.3.rte:True", "FMC_A_Template_v2.3.rte:False" });
        }

        [Test]
        public async Task The_audit_lists_its_lines_and_filters_by_severity()
        {
            var (all, must) = OnSta(() =>
            {
                var p = new Pane();
                p.Open("Templates");
                p.Vm.Templates.AuditCommand.Execute(null);
                CheckListSetting List() => p.Vm.Templates.Groups.Single(g => g.Title == "Audit a template").Items.OfType<CheckListSetting>().Single();
                var a = List().Rows.Count;
                p.Settings.Set("settings.templates.show", "Must");
                p.Vm.Templates.Rebuild();
                return (a, List().Rows.Select(r => r.Label + "=" + r.Status).ToList());
            });
            await Assert.That(all).IsEqualTo(6);
            await Assert.That(must).IsEquivalentTo(new[] { "Shared parameters vs FMC_SharedParameters.txt=2 differ" });
        }

        [Test]
        public async Task The_library_lists_released_and_staging_templates_from_the_kit()
        {
            var rows = OnSta(() =>
            {
                var p = new Pane();
                p.Open("Templates");
                var table = p.Vm.Templates.Groups.Single(g => g.Title == "Template library").Items.OfType<TableSetting>().Single();
                return table.Rows.Select(r => string.Join("|", r.Cells)).ToList();
            });
            await Assert.That(rows).IsEquivalentTo(new[] { "FMC_A_Template|2.3|Staging", "FMC_A_Template|2.2|Released", "FMC_S_Template|2.2|Released" });
        }

        [Test]
        public async Task Closing_a_file_with_changes_asks_how()
        {
            var (title, runs) = OnSta(() =>
            {
                var p = new Pane();
                p.Open("Templates");
                p.Vm.Templates.Documents.Rows[1].CloseCommand.Execute(null);
                var t = p.Vm.Dialog!.Title;
                p.Vm.Dialog.Items.OfType<ChoiceSetting>().Single().Selected = "Save and close";
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                return (t, p.Files.Runs.Select(r => r.Request.Action + ":" + r.Request.Save + ":" + r.Dry).ToList());
            });
            await Assert.That(title).IsEqualTo("Close FMC_E_ElecFixture_SocketDouble.rfa?");
            await Assert.That(runs).IsEquivalentTo(new[] { "close:True:True", "close:True:False" });
        }
    }
}
