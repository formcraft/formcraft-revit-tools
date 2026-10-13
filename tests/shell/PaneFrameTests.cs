using System;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Media;
using Formcraft.Shell.Controls;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U02: the pane frame against the boards (gen_panes.py pane(), core/PaneShell, core/ResponsivePane).</summary>
    public class PaneFrameTests
    {
        private sealed class Pane
        {
            public MockLicenceService Licence { get; } = new MockLicenceService();
            public MockConnectionService Connection { get; } = new MockConnectionService();
            public MockDocumentContext Document { get; } = new MockDocumentContext();
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public ShellViewModel Vm { get; }

            public Pane(bool signIn = true)
            {
                Vm = new ShellViewModel(Licence, Connection, Document, Settings);
                if (!signIn) return;
                Licence.SignInAsync("a@formcraft.example", "x").GetAwaiter().GetResult();
                Licence.VerifyCodeAsync("123456").GetAwaiter().GetResult();
                for (var i = 0; i < 3; i++) Vm.Welcome.NextCommand.Execute(null);
            }
        }

        // Commands touch WPF's CommandManager, so view models are built on the STA thread too.
        private static T OnSta<T>(Func<Pane, T> read, bool signIn = true) => Sta.Run(() => read(new Pane(signIn)));

        [Test]
        public async Task Every_section_has_an_icon_that_matches_its_svg()
        {
            var problems = Sta.Run(() =>
            {
                var icons = new System.Windows.ResourceDictionary
                {
                    Source = new Uri("pack://application:,,,/Formcraft.Shell;component/Theme/FmcIcons.xaml", UriKind.Absolute),
                };
                var vm = new Pane(signIn: false).Vm;
                var keys = vm.Groups.SelectMany(g => g.Sections).Select(s => s.IconKey)
                    .Concat(new[] { "Icon.Connect", "Icon.Settings", "Icon.Admin", "Icon.Search" });
                var found = keys.Where(k => !(icons.Contains(k) && icons[k] is Geometry g && !g.Bounds.IsEmpty))
                    .Select(k => k + " missing or empty").ToList();

                // Each Icon.X equals the path in resources/icons/pane-x.svg.
                var dir = Path.Combine(RepoRoot(), "resources", "icons");
                foreach (var file in Directory.GetFiles(dir, "pane-*.svg"))
                {
                    var stem = Path.GetFileNameWithoutExtension(file).Substring(5);
                    var key = "Icon." + (stem == "qa" ? "QA" : char.ToUpperInvariant(stem[0]) + stem.Substring(1));
                    var d = Regex.Match(File.ReadAllText(file), " d=\"([^\"]+)\"").Groups[1].Value;
                    var xaml = File.ReadAllText(Path.Combine(RepoRoot(), "shell", "Formcraft.Shell", "Theme", "FmcIcons.xaml"));
                    if (!xaml.Contains($"<Geometry x:Key=\"{key}\">{d}</Geometry>")) found.Add($"{key} differs from {Path.GetFileName(file)}");
                }
                return found;
            });

            await Assert.That(string.Join("; ", problems)).IsEqualTo("");
        }

        [Test]
        public async Task Quick_tools_show_only_with_Flow()
        {
            var (signedOut, withFlow) = (OnSta(p => p.Vm.ShowQuickTools, signIn: false), OnSta(p => p.Vm.ShowQuickTools));

            await Assert.That(signedOut).IsFalse();
            await Assert.That(withFlow).IsTrue();
            await Assert.That(string.Join(", ", OnSta(p => p.Vm.QuickTools))).IsEqualTo("Touch, Section Box, Tag Tidy");
        }

        [Test]
        public async Task Admin_is_for_admins_only()
        {
            var (signedOut, admin, page) = OnSta(p =>
            {
                var before = p.Vm.IsAdmin;
                p.Vm.OpenAdminCommand.Execute(null);
                return (before, p.Vm.IsAdmin, p.Vm.Page);
            }, signIn: false);
            await Assert.That(signedOut).IsFalse();
            await Assert.That(admin).IsFalse();
            await Assert.That(page).IsEqualTo(ShellPage.Section);

            var (isAdmin, opened) = OnSta(p =>
            {
                p.Vm.OpenAdminCommand.Execute(null);
                return (p.Vm.IsAdmin, p.Vm.IsAdminOpen);
            });
            await Assert.That(isAdmin).IsTrue();
            await Assert.That(opened).IsTrue();
        }

        [Test]
        [Arguments(DocState.Setup, "Setup tools open")]
        [Arguments(DocState.Shared, "Shared model: Claude in shared models is on")]
        [Arguments(DocState.Live, "Live project: Claude reads and reports")]
        public async Task Banner_text_matches_the_boards(DocState state, string text)
        {
            var doc = new[] { MockDocumentContext.NewModel, MockDocumentContext.SharedModel, MockDocumentContext.LiveProject }.Single(d => d.State == state);
            var (shown, lockText) = OnSta(p =>
            {
                p.Document.Open(doc);
                return (p.Vm.Document.State, p.Vm.Document.LockText);
            });

            await Assert.That(shown).IsEqualTo(state);
            await Assert.That(lockText).IsEqualTo(text);
        }

        [Test]
        public async Task A_live_project_is_the_safe_default()
        {
            await Assert.That(new MockDocumentContext().Current.State).IsEqualTo(DocState.Live);
        }

        [Test]
        public async Task Connected_chip_opens_Connect_and_closes_it_again()
        {
            var (open, title, noTabSelected, backToSection) = OnSta(p =>
            {
                p.Vm.OpenConnectCommand.Execute(null);
                var o = p.Vm.IsConnectOpen;
                var t = p.Vm.Body!.Title;
                var none = p.Vm.Groups.All(g => !g.IsSelected && g.Sections.All(s => !s.IsSelected));
                p.Vm.OpenConnectCommand.Execute(null);
                return (o, t, none, p.Vm.Page == ShellPage.Section && p.Vm.Body!.Title == "Setup › Project");
            });

            await Assert.That(open).IsTrue();
            await Assert.That(title).IsEqualTo("Connect");
            await Assert.That(noTabSelected).IsTrue();
            await Assert.That(backToSection).IsTrue();
        }

        [Test]
        public async Task Chip_text_follows_the_service()
        {
            var (before, after) = OnSta(p =>
            {
                var b = p.Vm.ConnectionText;
                p.Connection.Set(ConnectionState.NotConnected);
                return (b, p.Vm.ConnectionText);
            });

            await Assert.That(before).IsEqualTo("Connected");
            await Assert.That(after).IsEqualTo("Not connected");
        }

        [Test]
        [Arguments(320, true)]
        [Arguments(399, true)]
        [Arguments(400, false)]
        [Arguments(560, false)]
        public async Task Compact_below_400_px(double width, bool compact)
        {
            await Assert.That(Fmc.IsCompact(width)).IsEqualTo(compact);
        }

        [Test]
        public async Task Release_seat_asks_first_and_cancel_changes_nothing()
        {
            var (title, primary, stillSignedIn, closed) = OnSta(p =>
            {
                p.Vm.Account.ReleaseSeatCommand.Execute(null);
                var d = p.Vm.Dialog!;
                d.CancelCommand.Execute(null);
                return (d.Title, d.PrimaryText, p.Licence.Current.SignedIn, !p.Vm.IsDialogOpen);
            });

            await Assert.That(title).IsEqualTo("Release this seat");
            await Assert.That(primary).IsEqualTo("Release");
            await Assert.That(stillSignedIn).IsTrue();
            await Assert.That(closed).IsTrue();
        }

        [Test]
        public async Task Release_seat_runs_after_the_yes()
        {
            var (signedIn, closed) = OnSta(p =>
            {
                p.Vm.Account.ReleaseSeatCommand.Execute(null);
                p.Vm.Dialog!.ConfirmCommand!.Execute(null);
                return (p.Licence.Current.SignedIn, !p.Vm.IsDialogOpen);
            });

            await Assert.That(signedIn).IsFalse();
            await Assert.That(closed).IsTrue();
        }

        [Test]
        public async Task Esc_closes_the_dialog()
        {
            var closed = OnSta(p =>
            {
                p.Vm.Account.ReleaseSeatCommand.Execute(null);
                p.Vm.IsDialogOpen = false; // what FmcDialog does on Esc or the close button
                return p.Vm.Dialog == null && p.Licence.Current.SignedIn;
            });

            await Assert.That(closed).IsTrue();
        }

        [Test]
        [Arguments(new double[] { 50, 50, 50, 50 }, 400, new double[] { 100, 100, 100, 100 })]
        [Arguments(new double[] { 50, 150, 50, 50 }, 400, new double[] { 250 / 3.0, 150, 250 / 3.0, 250 / 3.0 })]
        [Arguments(new double[] { 100, 300 }, 200, new double[] { 50, 150 })]
        public async Task Flex_row_shares_like_the_boards(double[] needs, double space, double[] expected)
        {
            var widths = FlexRow.Widths(needs, space);
            await Assert.That(string.Join(",", widths.Select(w => w.ToString("0.###"))))
                .IsEqualTo(string.Join(",", expected.Select(w => w.ToString("0.###"))));
        }

        private static string RepoRoot()
        {
            var dir = AppContext.BaseDirectory;
            while (dir != null && !File.Exists(Path.Combine(dir, "global.json"))) dir = Path.GetDirectoryName(dir);
            return dir ?? throw new InvalidOperationException("Repo root (global.json) not found");
        }
    }
}
