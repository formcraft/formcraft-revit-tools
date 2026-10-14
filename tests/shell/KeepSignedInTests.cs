using System;
using System.Threading.Tasks;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.Tests
{
    /// <summary>F-014: "Keep me signed in on this PC" keeps the session across Revit restarts.</summary>
    public class KeepSignedInTests
    {
        private static async Task SignIn(MockLicenceService l)
        {
            await l.SignInAsync("a@formcraft.example", "pw");
            await l.VerifyCodeAsync("123456");
        }

        [Test]
        public async Task A_kept_session_comes_back_after_a_restart()
        {
            var settings = new InMemoryUserSettings();
            await SignIn(new MockLicenceService(settings));
            var next = new MockLicenceService(settings);          // Revit restarted
            await Assert.That(next.Current.SignedIn).IsTrue();
            await Assert.That(next.Current.Account!.Email).IsEqualTo("a@formcraft.example");
        }

        [Test]
        public async Task With_the_switch_off_or_after_sign_out_the_next_session_starts_signed_out()
        {
            var off = new InMemoryUserSettings();
            off.SetBool(SettingKeys.KeepSignedIn, false);
            await SignIn(new MockLicenceService(off));
            await Assert.That(new MockLicenceService(off).Current.SignedIn).IsFalse();

            var on = new InMemoryUserSettings();
            var l = new MockLicenceService(on);
            await SignIn(l);
            await l.SignOutAsync();
            await Assert.That(new MockLicenceService(on).Current.SignedIn).IsFalse();
        }

        [Test]
        public async Task The_offline_grace_still_runs_from_the_last_check()
        {
            var settings = new InMemoryUserSettings();
            settings.Set(MockLicenceService.SessionKey, "a@formcraft.example|" + DateTime.Now.AddDays(-20).ToString("o") + "|14");
            var l = new MockLicenceService(settings);
            await Assert.That(l.Current.GraceOver).IsTrue();
        }
    }
}
