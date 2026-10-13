using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U05: sign in and first-run setup (boards account/PaneSignIn, account/PaneWelcome).</summary>
    public class SetupTests
    {
        private sealed class Pane
        {
            public MockLicenceService Licence { get; } = new MockLicenceService();
            public InMemoryUserSettings Settings { get; }
            public ShellViewModel Vm { get; }

            public Pane(InMemoryUserSettings? settings = null)
            {
                Settings = settings ?? new InMemoryUserSettings();
                Settings.Set(SettingKeys.KitFolder, SampleKit);
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), Settings);
            }

            public void TypeAndSignIn()
            {
                Vm.SignIn.Email = "a@formcraft.example";
                Vm.SignIn.Password = "x";
                Vm.SignIn.SignInCommand.Execute(null);
            }

            public void EnterCode(string code)
            {
                Vm.Dialog!.Input = code;
                Vm.Dialog.ConfirmCommand!.Execute(null);
            }

            public string Footer => string.Join(",", Vm.FooterActions.Select(a => a.Label));
        }

        private static T OnSta<T>(Func<T> read) => Sta.Run(read);

        public static string SampleKit => Path.Combine(RepoRoot(), "tests", "shell", "fixtures", "kit");

        [Test]
        public async Task Sample_kit_passes_every_check()
        {
            var check = new FolderKitService().Check(SampleKit);

            await Assert.That(check.KitFound).IsTrue();
            await Assert.That(check.IsSample).IsTrue();
            await Assert.That(check.AllGood).IsTrue();
            await Assert.That(string.Join(" | ", check.Lines.Select(l => l.Label + " " + l.Status)))
                .IsEqualTo("FMC Kit v2.2 found (sample) OK | Shared parameters file OK | Rulebooks v0.2 OK | Write folders (01_WIP, _Staging) OK");
        }

        [Test]
        public async Task A_missing_folder_or_a_folder_without_the_kit_says_so()
        {
            var missing = new FolderKitService().Check(Path.Combine(Path.GetTempPath(), "no-such-kit-" + Guid.NewGuid().ToString("N")));
            var empty = Path.Combine(Path.GetTempPath(), "empty-kit-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(empty);
            try
            {
                var notKit = new FolderKitService().Check(empty);
                await Assert.That(missing.KitFound).IsFalse();
                await Assert.That(missing.Lines.Single().Label).IsEqualTo("No folder at this path");
                await Assert.That(notKit.KitFound).IsFalse();
                await Assert.That(notKit.Lines[0].Label).IsEqualTo("No Formcraft kit here (FMC_Kit.json)");
                await Assert.That(notKit.Lines[0].Kind).IsEqualTo(ChipKind.Bad);
                await Assert.That(notKit.Lines[2].Status).IsEqualTo("Not listed");
            }
            finally
            {
                Directory.Delete(empty);
            }
        }

        [Test]
        public async Task Two_step_sign_in_asks_for_the_code_in_a_dialog()
        {
            var (title, label, primary, footer) = OnSta(() =>
            {
                var p = new Pane();
                var f = p.Footer;
                p.TypeAndSignIn();
                return (p.Vm.Dialog!.Title, p.Vm.Dialog.InputLabel, p.Vm.Dialog.PrimaryText, f);
            });

            await Assert.That(footer).IsEqualTo("Sign in,Work offline");
            await Assert.That(title).IsEqualTo("Check your phone");
            await Assert.That(label).IsEqualTo("6-digit code");
            await Assert.That(primary).IsEqualTo("Verify");
        }

        [Test]
        public async Task A_wrong_code_keeps_the_dialog_open_with_why()
        {
            var (open, error, screen) = OnSta(() =>
            {
                var p = new Pane();
                p.TypeAndSignIn();
                p.EnterCode("000000");
                return (p.Vm.IsDialogOpen, p.Vm.Dialog?.Error, p.Vm.Screen);
            });

            await Assert.That(open).IsTrue();
            await Assert.That(error).IsEqualTo("That code didn't match. Try again.");
            await Assert.That(screen).IsEqualTo(ShellScreen.SignIn);
        }

        [Test]
        public async Task The_right_code_starts_setup_at_step_2()
        {
            var (open, screen, title, footer, status, backEnabled) = OnSta(() =>
            {
                var p = new Pane();
                p.TypeAndSignIn();
                p.EnterCode("123 456");
                return (p.Vm.IsDialogOpen, p.Vm.Screen, p.Vm.Welcome.Title, p.Footer, p.Vm.Status, p.Vm.Welcome.BackCommand.CanExecute(null));
            });

            await Assert.That(open).IsFalse();
            await Assert.That(screen).IsEqualTo(ShellScreen.Welcome);
            await Assert.That(title).IsEqualTo("Set up this PC · step 2 of 4");
            await Assert.That(footer).IsEqualTo("Back,Next");
            await Assert.That(status).IsEqualTo("Step 2 of 4");
            await Assert.That(backEnabled).IsFalse();
        }

        [Test]
        public async Task Four_steps_from_sign_in_to_the_pane_then_straight_in_next_time()
        {
            var (steps, finishLabel, screen, done, nextTime) = OnSta(() =>
            {
                var p = new Pane();
                p.TypeAndSignIn();
                p.EnterCode("123456");
                var seen = p.Vm.Welcome.Title;
                p.Vm.Welcome.NextCommand.Execute(null);
                seen += " / " + p.Vm.Welcome.Title;
                p.Vm.Welcome.NextCommand.Execute(null);
                seen += " / " + p.Vm.Welcome.Title;
                var finish = p.Footer;
                p.Vm.Welcome.NextCommand.Execute(null);
                var s = p.Vm.Screen;
                var d = p.Settings.GetBool(SettingKeys.SetupDone, false);

                // Same PC, signs in again: no setup this time.
                var again = new Pane(p.Settings);
                again.TypeAndSignIn();
                again.EnterCode("123456");
                return (seen, finish, s, d, again.Vm.Screen);
            });

            await Assert.That(steps).IsEqualTo("Set up this PC · step 2 of 4 / Set up this PC · step 3 of 4 / Set up this PC · step 4 of 4");
            await Assert.That(finishLabel).IsEqualTo("Back,Finish");
            await Assert.That(screen).IsEqualTo(ShellScreen.Main);
            await Assert.That(done).IsTrue();
            await Assert.That(nextTime).IsEqualTo(ShellScreen.Main);
        }

        [Test]
        public async Task Setup_choices_are_saved_for_the_person()
        {
            var (kit, disciplines, partsOff, role) = OnSta(() =>
            {
                var p = new Pane();
                p.TypeAndSignIn();
                p.EnterCode("123456");
                var w = p.Vm.Welcome;
                w.KitFolder = "  " + SampleKit + "  ";
                w.NextCommand.Execute(null);
                foreach (var d in w.Disciplines.Where(d => d.Code == "A" || d.Code == "FP")) d.IsOn = true;
                var r = w.Role;
                w.NextCommand.Execute(null);
                w.Parts.Single(m => m.Module == FmcModule.Flow).Switches.Single(s => s.Name == "Touch").IsOn = false;
                return (p.Settings.Get(SettingKeys.KitFolder), p.Settings.Get(SettingKeys.Disciplines), !p.Settings.IsPartOn("flow.touch"), r);
            });

            await Assert.That(kit).IsEqualTo(SampleKit);
            await Assert.That(disciplines).IsEqualTo("A,FP");
            await Assert.That(partsOff).IsTrue();
            await Assert.That(role).IsEqualTo("BIM Coordinator");
        }

        [Test]
        public async Task A_done_step_can_be_opened_again_but_not_a_later_one()
        {
            var (afterLater, afterEarlier) = OnSta(() =>
            {
                var p = new Pane();
                p.TypeAndSignIn();
                p.EnterCode("123456");
                var w = p.Vm.Welcome;
                w.NextCommand.Execute(null); // step 3
                w.GoToCommand.Execute(w.Steps[3]); // step 4: not reached yet
                var later = w.Step;
                w.GoToCommand.Execute(w.Steps[1]); // step 2: done
                return (later, w.Step);
            });

            await Assert.That(afterLater).IsEqualTo(3);
            await Assert.That(afterEarlier).IsEqualTo(2);
        }

        [Test]
        [Arguments(SignInProvider.Microsoft)]
        [Arguments(SignInProvider.Google)]
        public async Task Microsoft_and_Google_sign_in_through_the_browser(SignInProvider provider)
        {
            var (screen, message) = OnSta(() =>
            {
                var p = new Pane();
                (provider == SignInProvider.Microsoft ? p.Vm.SignIn.MicrosoftCommand : p.Vm.SignIn.GoogleCommand).Execute(null);
                return (p.Vm.Screen, p.Vm.SignIn.Message);
            });

            await Assert.That(screen).IsEqualTo(ShellScreen.Welcome);
            await Assert.That(message).IsEqualTo("Signed in with " + provider + ". Licence checked.");
        }

        [Test]
        public async Task An_offline_licence_file_works_for_30_days()
        {
            var (wrong, screen, days, checkedOnline) = OnSta(() =>
            {
                var p = new Pane();
                p.Vm.SignIn.UseOfflineLicenceAsync(@"C:\Downloads\licence.txt").GetAwaiter().GetResult();
                var w = p.Vm.SignIn.Message;
                p.Vm.SignIn.UseOfflineLicenceAsync(@"C:\Downloads\FMC_Licence_PC-042.lic").GetAwaiter().GetResult();
                return (w, p.Vm.Screen, p.Licence.Current.OfflineDaysLeft, p.Licence.Current.LastOnlineCheck != null);
            });

            await Assert.That(wrong).IsEqualTo("That isn't a Formcraft licence file. It's named FMC_Licence_<PC>.lic.");
            await Assert.That(screen).IsEqualTo(ShellScreen.Welcome);
            await Assert.That(days).IsEqualTo(30);
            await Assert.That(checkedOnline).IsFalse();
        }

        [Test]
        public async Task The_links_say_where_help_is()
        {
            var (forgot, ask) = OnSta(() =>
            {
                var p = new Pane();
                p.Vm.SignIn.ForgotPasswordCommand.Execute(null);
                var f = p.Vm.Status;
                p.Vm.SignIn.AskAdminCommand.Execute(null);
                return (f, p.Vm.Status);
            });

            await Assert.That(forgot).IsEqualTo("Forgot password: the Formcraft account website resets it, outside Revit.");
            await Assert.That(ask).IsEqualTo("No account? Ask your admin to invite you in Admin › Licences and seats.");
        }

        [Test]
        public async Task Settings_values_are_saved_and_read_back()
        {
            var dir = Path.Combine(Path.GetTempPath(), "fmc-settings-" + Guid.NewGuid().ToString("N"));
            var path = Path.Combine(dir, "settings.json");
            try
            {
                var first = new JsonUserSettings(path);
                first.Set(SettingKeys.KitFolder, @"Z:\00_Standards");
                first.SetBool(SettingKeys.SetupDone, true);
                first.SetPart("flow.touch", false);

                var again = new JsonUserSettings(path);
                await Assert.That(again.Get(SettingKeys.KitFolder)).IsEqualTo(@"Z:\00_Standards");
                await Assert.That(again.GetBool(SettingKeys.SetupDone, false)).IsTrue();
                await Assert.That(again.IsPartOn("flow.touch")).IsFalse();
                await Assert.That(File.ReadAllText(path)).Contains("\"kitFolder\"");
            }
            finally
            {
                if (Directory.Exists(dir)) Directory.Delete(dir, true);
            }
        }

        private static string RepoRoot()
        {
            var dir = AppContext.BaseDirectory;
            while (dir != null && !File.Exists(Path.Combine(dir, "global.json"))) dir = Path.GetDirectoryName(dir);
            return dir ?? throw new InvalidOperationException("Repo root (global.json) not found");
        }
    }
}
