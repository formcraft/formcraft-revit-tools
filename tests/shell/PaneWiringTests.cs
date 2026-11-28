using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Threading;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>
    /// F03: the pane frame. The kit check must not freeze the pane, and the Revit host must not leave a page on a
    /// mock service by forgetting an argument.
    /// </summary>
    public class PaneWiringTests
    {
        private sealed class SlowKit : IKitService
        {
            private int _calls;
            public volatile int DelayMs;
            public volatile bool Found = true;
            public int Calls => Volatile.Read(ref _calls);

            public KitCheck Check(string folder)
            {
                Interlocked.Increment(ref _calls);
                if (DelayMs > 0) Thread.Sleep(DelayMs);
                var line = new KitCheckLine("FMC Kit", Found, Found ? "OK" : "Missing", Found ? ChipKind.Good : ChipKind.Bad);
                return new KitCheck(folder, new[] { line }, Found, false);
            }
        }

        private static ShellViewModel Pane(SlowKit kit, InMemoryUserSettings settings)
        {
            settings.SetBool(SettingKeys.SetupDone, true);
            settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
            var licence = new MockLicenceService();
            var vm = new ShellViewModel(licence, new MockConnectionService(), new MockDocumentContext(), settings, kit: kit, theme: new ThemeService());
            licence.SignInAsync("a@formcraft.example", "x").GetAwaiter().GetResult();
            licence.VerifyCodeAsync("123456").GetAwaiter().GetResult();
            return vm;
        }

        private static void Pump()
        {
            var frame = new DispatcherFrame();
            Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false));
            Dispatcher.PushFrame(frame);
        }

        [Test]
        public async Task A_kit_check_that_takes_5_s_does_not_block_the_state_and_its_answer_still_arrives()
        {
            var (elapsed, right, later) = Sta.Run(() =>
            {
                var kit = new SlowKit();
                var settings = new InMemoryUserSettings();
                var vm = Pane(kit, settings);
                kit.DelayMs = 5000;
                kit.Found = false;

                var sw = Stopwatch.StartNew();
                settings.Set(SettingKeys.KitFolder, @"C:\slow-kit-" + Guid.NewGuid().ToString("N"));
                var ms = sw.ElapsedMilliseconds;
                var r = vm.State;
                while (vm.State != PaneState.KitMissing && sw.ElapsedMilliseconds < 10000) { Pump(); Thread.Sleep(50); }
                return (ms, r, vm.State);
            });

            await Assert.That(elapsed).IsLessThan(1500);
            await Assert.That(right).IsEqualTo(PaneState.Normal);
            await Assert.That(later).IsEqualTo(PaneState.KitMissing);
        }

        [Test]
        public async Task The_kit_is_checked_once_per_folder_not_on_every_settings_change()
        {
            var (before, after) = Sta.Run(() =>
            {
                var kit = new SlowKit();
                var settings = new InMemoryUserSettings();
                Pane(kit, settings);
                var b = kit.Calls;
                settings.Set("general.example_one", "1");
                settings.Set("general.example_two", "2");
                settings.SetBool(SettingKeys.SetupDone, true);
                return (b, kit.Calls);
            });

            await Assert.That(after).IsEqualTo(before);
        }

        [Test]
        public async Task A_network_folder_that_does_not_answer_gives_up_after_the_timeout()
        {
            var kit = new FolderKitService(_ => { Thread.Sleep(5000); return true; }, TimeSpan.FromMilliseconds(300));
            var sw = Stopwatch.StartNew();
            var check = kit.Check(@"\\no-such-server\kit");
            var ms = sw.ElapsedMilliseconds;

            await Assert.That(ms).IsLessThan(2000);
            await Assert.That(check.KitFound).IsFalse();
            await Assert.That(check.Lines[0].Status).IsEqualTo("No answer");
            await Assert.That(FolderKitService.IsNetworkPath(@"\\server\share\kit")).IsTrue();
            await Assert.That(FolderKitService.NetworkTimeout.TotalMilliseconds).IsEqualTo(1500);
        }

        [Test]
        public async Task A_local_folder_is_looked_up_directly()
        {
            var calls = 0;
            var kit = new FolderKitService(_ => { calls++; return false; }, TimeSpan.FromMilliseconds(300));
            var check = kit.Check(Path.Combine(Path.GetTempPath(), "no-kit-" + Guid.NewGuid().ToString("N")));

            await Assert.That(calls).IsEqualTo(1);
            await Assert.That(check.Lines[0].Label).IsEqualTo("No folder at this path");
        }

        [Test]
        public async Task The_header_Help_button_is_hidden_until_there_is_a_guide()
        {
            var (available, status) = Sta.Run(() =>
            {
                var vm = Pane(new SlowKit(), new InMemoryUserSettings());
                vm.HelpCommand.Execute(null);
                return (vm.HelpAvailable, vm.Status);
            });

            await Assert.That(available).IsFalse();
            await Assert.That(status).Contains("isn't built yet");
        }

        // Services the Revit host deliberately leaves on a mock, with why. When one is wired for real, remove it here.
        private static readonly Dictionary<string, string> KnownMocks = new Dictionary<string, string>
        {
            ["admin"] = "F03/F08: no real admin service yet; ShellHost passes none, so Admin runs on MockAdminService",
        };

        private static readonly string[] KnownHostMocks = { "MockLicenceService" }; // U17 / D6: the licence service is not built

        [Test]
        public async Task The_Revit_host_passes_a_real_service_for_every_page_that_would_fall_back_to_a_mock()
        {
            var root = RepoRoot();
            var vm = File.ReadAllText(Path.Combine(root, "shell", "Formcraft.Shell", "ViewModels", "ShellViewModel.cs"));
            var host = File.ReadAllText(Path.Combine(root, "plugin", "Shell", "ShellHost.cs"));

            var fallbacks = Regex.Matches(vm, @"\b(\w+) \?\? new (Mock\w+)\(").Cast<Match>().Select(m => m.Groups[1].Value).Distinct().ToList();
            var start = host.IndexOf("new ShellViewModel(", StringComparison.Ordinal);
            var call = start < 0 ? "" : host.Substring(start, host.IndexOf("LogPath", start, StringComparison.Ordinal) - start);
            var passed = new HashSet<string>(Regex.Matches(call, @"\b(\w+):\s").Cast<Match>().Select(m => m.Groups[1].Value));
            var missing = fallbacks.Where(f => !passed.Contains(f)).OrderBy(f => f, StringComparer.Ordinal).ToList();
            var hostMocks = Regex.Matches(host, @"new (Mock\w+)\(").Cast<Match>().Select(m => m.Groups[1].Value).Distinct().OrderBy(x => x, StringComparer.Ordinal).ToList();

            await Assert.That(start).IsGreaterThanOrEqualTo(0);
            await Assert.That(fallbacks.Count).IsGreaterThan(20);
            await Assert.That(string.Join(",", missing)).IsEqualTo(string.Join(",", KnownMocks.Keys.OrderBy(k => k, StringComparer.Ordinal)));
            await Assert.That(string.Join(",", hostMocks)).IsEqualTo(string.Join(",", KnownHostMocks));
        }

        private static string RepoRoot()
        {
            var dir = AppContext.BaseDirectory;
            while (dir != null && !File.Exists(Path.Combine(dir, "global.json"))) dir = Path.GetDirectoryName(dir);
            return dir ?? throw new InvalidOperationException("Repo root (global.json) not found");
        }
    }
}
