using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.Tests
{
    /// <summary>F07: settings.json is saved atomically, two Revits keep each other's changes, and a bad file never throws.</summary>
    public class SettingsFileTests
    {
        private static string NewDir()
        {
            var dir = Path.Combine(Path.GetTempPath(), "fmc-settings-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            return dir;
        }

        [Test]
        public async Task Two_writers_keep_each_others_changes()
        {
            var path = Path.Combine(NewDir(), "settings.json");
            var a = new JsonUserSettings(path);
            var b = new JsonUserSettings(path);

            a.Set("general.one", "1");
            b.Set("general.two", "2");
            b.SetPart("model.casework", false);
            var c = new JsonUserSettings(path);

            await Assert.That(c.Get("general.one")).IsEqualTo("1");
            await Assert.That(c.Get("general.two")).IsEqualTo("2");
            await Assert.That(c.IsPartOn("model.casework")).IsFalse();
            await Assert.That(b.LastError).IsNull();
        }

        [Test]
        public async Task A_save_replaces_the_file_keeps_one_backup_and_leaves_no_temp()
        {
            var dir = NewDir();
            var path = Path.Combine(dir, "settings.json");
            var s = new JsonUserSettings(path);
            s.Set("general.one", "1");
            s.Set("general.one", "2");
            s.Set("general.one", "3");

            var files = Directory.GetFiles(dir).Select(Path.GetFileName).OrderBy(f => f, StringComparer.Ordinal).ToList();

            await Assert.That(string.Join(",", files)).IsEqualTo("settings.json,settings.json.bak");
            await Assert.That(new JsonUserSettings(path).Get("general.one")).IsEqualTo("3");
            await Assert.That(new JsonUserSettings(path + ".bak").Get("general.one")).IsEqualTo("2");
        }

        [Test]
        public async Task A_read_only_file_does_not_throw_and_says_why()
        {
            var path = Path.Combine(NewDir(), "settings.json");
            new JsonUserSettings(path).Set("general.one", "1");
            File.SetAttributes(path, FileAttributes.ReadOnly);
            try
            {
                var s = new JsonUserSettings(path);
                string? said = null;
                s.SaveFailed += (_, m) => said = m;
                Exception? thrown = null;
                try { s.Set("general.one", "2"); }
                catch (Exception ex) { thrown = ex; }

                await Assert.That(thrown).IsNull();
                await Assert.That(s.Get("general.one")).IsEqualTo("2");
                await Assert.That(s.LastError).StartsWith("Settings not saved:");
                await Assert.That(said).IsEqualTo(s.LastError);
                await Assert.That(Directory.GetFiles(Path.GetDirectoryName(path)!, "*.tmp").Length).IsEqualTo(0);
            }
            finally
            {
                File.SetAttributes(path, FileAttributes.Normal);
            }
        }

        [Test]
        public async Task A_locked_file_fails_the_save_and_the_read_without_throwing()
        {
            var path = Path.Combine(NewDir(), "settings.json");
            new JsonUserSettings(path).Set("general.one", "1");
            var s = new JsonUserSettings(path);
            JsonUserSettings? locked;
            Exception? thrown = null;
            using (new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None))
            {
                try
                {
                    s.Set("general.one", "2");
                    locked = new JsonUserSettings(path);
                }
                catch (Exception ex) { thrown = ex; locked = null; }
            }

            await Assert.That(thrown).IsNull();
            await Assert.That(s.LastError).StartsWith("Settings not saved:");
            await Assert.That(locked!.LastError).StartsWith("Settings not read:");
            await Assert.That(Directory.GetFiles(Path.GetDirectoryName(path)!, "*.tmp").Length).IsEqualTo(0);

            s.Set("general.one", "3");
            await Assert.That(s.LastError).IsNull();
            await Assert.That(new JsonUserSettings(path).Get("general.one")).IsEqualTo("3");
        }
    }
}
