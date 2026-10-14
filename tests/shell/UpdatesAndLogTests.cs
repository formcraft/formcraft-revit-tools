using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U09: the Log file window (board core/UI_Log) and Settings › Updates (board account/PaneUpdates).</summary>
    public class UpdatesAndLogTests
    {
        public static string SampleLog => Path.Combine(Path.GetDirectoryName(SetupTests.SampleKit)!, "FMC_MCP_FileLog.csv");

        [Test]
        public async Task Reads_the_real_sample_log_newest_first()
        {
            var rows = new CsvLogReader(SampleLog).Read();

            await Assert.That(rows.Count).IsEqualTo(5);
            await Assert.That(string.Join(" | ", rows.Select(r => r.Tool + " " + r.Kind)))
                .IsEqualTo("archive Run | create_point_based_element Refused | fmc_family.plan Check | save_as Run | save_as Dry run");
        }

        [Test]
        public async Task Quoted_fields_keep_their_commas_and_quotes()
        {
            var plan = new CsvLogReader(SampleLog).Read().Single(r => r.Tool == "fmc_family.plan");

            await Assert.That(plan.Result).IsEqualTo("3 ready, 3 blocked");
            await Assert.That(plan.Detail).IsEqualTo("FMC_A_Door_Single, FMC_A_Window_Fixed: missing \"FMC_Fire_Rating\"");
            await Assert.That(plan.Time).IsEqualTo(new DateTime(2026, 10, 13, 7, 51, 30, 2, DateTimeKind.Utc).ToLocalTime());
        }

        [Test]
        public async Task A_source_column_fills_From_and_a_missing_file_is_an_empty_log()
        {
            var path = Path.Combine(Path.GetTempPath(), "fmc-log-" + Guid.NewGuid().ToString("N") + ".csv");
            File.WriteAllText(path, "timestamp,action,dry_run,target,result,detail,source\r\n" +
                                    DateTime.UtcNow.ToString("o") + ",save_as,false,a.rvt,ok,,Pane\r\n" +
                                    DateTime.UtcNow.ToString("o") + ",model_statistics,false,b.rvt,ok,,Claude\r\n", Encoding.UTF8);
            try
            {
                var rows = new CsvLogReader(path).Read();
                await Assert.That(string.Join(",", rows.Select(r => r.From))).IsEqualTo("Claude,Pane");
                await Assert.That(rows[0].Kind).IsEqualTo("Read");
                await Assert.That(new CsvLogReader(path + ".missing").Read().Count).IsEqualTo(0);
            }
            finally
            {
                File.Delete(path);
            }
        }

        [Test]
        public async Task The_window_filters_like_the_board()
        {
            var path = Path.Combine(Path.GetTempPath(), "fmc-log-" + Guid.NewGuid().ToString("N") + ".csv");
            var now = DateTime.UtcNow.ToString("o");
            File.WriteAllText(path, "timestamp,action,dry_run,target,result,detail,source\r\n" +
                                    now + ",save_as,true,a.rvt,ok,,Pane\r\n" +
                                    now + ",create_wall,false,live.rvt,refused,Live-model lock,Claude\r\n" +
                                    now + ",model_statistics,false,live.rvt,ok,1840 tokens,Ask\r\n" +
                                    "2020-01-01T00:00:00Z,save_as,false,old.rvt,ok,,Pane\r\n", Encoding.UTF8);
            try
            {
                var counts = Sta.Run(() =>
                {
                    var vm = new LogViewModel(new CsvLogReader(path), _ => { }, _ => { });
                    var result = new Dictionary<string, int>();
                    foreach (var f in LogViewModel.Filters)
                    {
                        vm.Filter = f;
                        result[f] = vm.Rows.Count;
                    }
                    vm.Filter = "All";
                    vm.OnlyToday = false;
                    result["All days"] = vm.Rows.Count;
                    return result;
                });

                await Assert.That(counts["All"]).IsEqualTo(3);
                await Assert.That(counts["Pane clicks"]).IsEqualTo(1);
                await Assert.That(counts["AI"]).IsEqualTo(2);
                await Assert.That(counts["Refused"]).IsEqualTo(1);
                await Assert.That(counts["All days"]).IsEqualTo(4);
            }
            finally
            {
                File.Delete(path);
            }
        }

        [Test]
        public async Task Open_and_copy_go_through_the_host_and_copy_no_model_content()
        {
            var (opened, copied, pickFirst) = Sta.Run(() =>
            {
                var opens = new List<string>();
                var copies = new List<string>();
                var vm = new LogViewModel(new CsvLogReader(SampleLog), p => opens.Add(p), t => copies.Add(t)) { OnlyToday = false };
                vm.CopyRowCommand.Execute(null);
                var first = vm.Message;
                vm.Selected = vm.Rows.Single(r => r.Refused);
                vm.CopyRowCommand.Execute(null);
                vm.OpenCsvCommand.Execute(null);
                vm.OpenFolderCommand.Execute(null);
                return (opens, copies, first);
            });

            await Assert.That(pickFirst).IsEqualTo("Pick a row first.");
            await Assert.That(opened.Count).IsEqualTo(2);
            await Assert.That(opened[0]).EndsWith("FMC_MCP_FileLog.csv");
            await Assert.That(copied.Single()).Contains("create_point_based_element | THE OGALA RESIDENCE (live) | Refused | refused");
            await Assert.That(copied.Single()).DoesNotContain("Live-model lock: model-changing");
        }

        [Test]
        public async Task An_empty_log_says_so()
        {
            var text = Sta.Run(() => new LogViewModel(new CsvLogReader(Path.Combine(Path.GetTempPath(), "none-" + Guid.NewGuid() + ".csv")), _ => { }, _ => { }).EmptyText);
            await Assert.That(text).IsEqualTo("No log yet on this PC. Rows appear here when a pane button or an AI runs a Formcraft tool.");
        }

        private sealed class Pane
        {
            public MockLicenceService Licence { get; } = new MockLicenceService();
            public MockUpdateService Updates { get; } = new MockUpdateService();
            public ShellViewModel Vm { get; }
            public int LogOpened;

            public Pane()
            {
                var s = new InMemoryUserSettings();
                s.SetBool(SettingKeys.SetupDone, true);
                s.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), s, theme: new ThemeService(), updates: Updates);
                Vm.OpenLogRequested += (_, _) => LogOpened++;
                Licence.SignInAsync("a@formcraft.example", "x").GetAwaiter().GetResult();
                Licence.VerifyCodeAsync("123456").GetAwaiter().GetResult();
                Vm.OpenSettingsCommand.Execute(null);
                Vm.Settings.Open("Updates");
            }

            public SettingsTab Tab => Vm.Settings.Tabs.Single(t => t.Name == "Updates");
            public SettingButton Button(string label) => Tab.Groups.SelectMany(g => g.Items).OfType<ButtonsSetting>().SelectMany(b => b.Buttons).First(b => b.Label == label);
        }

        [Test]
        public async Task Updates_has_every_group_and_the_footer_checks_for_updates()
        {
            var (groups, footer, installed) = Sta.Run(() =>
            {
                var p = new Pane();
                return (string.Join(" | ", p.Tab.Groups.Select(g => g.Title)),
                        string.Join(",", p.Vm.FooterActions.Select(f => f.Label)),
                        p.Tab.Groups[0].Items.OfType<ReadOnlySetting>().First().Value);
            });

            await Assert.That(groups).IsEqualTo("Formcraft for Revit | Update available · sample feed (preview only) | Help and support | Legal");
            await Assert.That(footer).IsEqualTo("Check for updates,Save,Reset mine");
            await Assert.That(installed).IsEqualTo("0.1.0 · Core, Manage, Flow, Model (trial) · Revit 2025");
        }

        [Test]
        public async Task An_update_waits_for_Revit_to_close()
        {
            var (pending, note) = Sta.Run(() =>
            {
                var p = new Pane();
                p.Button("Update when Revit closes").Command.Execute(null);
                return (p.Updates.UpdatePending, p.Tab.Groups.Single(g => g.Title.StartsWith("Update available")).Items.OfType<NoteSetting>().Single().Text);
            });

            await Assert.That(pending).IsTrue();
            await Assert.That(note).IsEqualTo("0.1.1 installs when Revit closes. Your settings are kept; 0.1.0 is kept for rollback.");
        }

        [Test]
        public async Task The_beta_channel_offers_the_testers_build()
        {
            var version = Sta.Run(() =>
            {
                var p = new Pane();
                p.Tab.Groups[0].Items.OfType<ChoiceSetting>().Single().Selected = "Beta (testers)";
                p.Vm.CheckUpdatesCommand.Execute(null);
                return p.Updates.Available!.Version;
            });

            await Assert.That(version).IsEqualTo("0.1.2-beta");
        }

        [Test]
        public async Task Open_the_log_file_asks_the_view_to_open_the_window()
        {
            var opened = Sta.Run(() =>
            {
                var p = new Pane();
                p.Button("Open the log file").Command.Execute(null);
                return p.LogOpened;
            });

            await Assert.That(opened).IsEqualTo(1);
        }
    }
}
