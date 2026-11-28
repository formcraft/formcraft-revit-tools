using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Threading;

namespace Formcraft.Shell.Services
{
    /// <summary>
    /// One person's pane settings. Saved for them, never the team's, and never loosens a team rule.
    /// U03 stores the parts switches; U06 adds the rest of Settings.
    /// </summary>
    public interface IUserSettings
    {
        bool IsPartOn(string partId);
        void SetPart(string partId, bool on);
        /// <summary>A saved value, or null when the person never set it (the caller's default applies).</summary>
        string? Get(string key);
        void Set(string key, string? value);
        event EventHandler? Changed;
    }

    /// <summary>Setting keys and typed helpers, so every caller spells them the same way.</summary>
    public static class SettingKeys
    {
        public const string KitFolder = "kitFolder";
        public const string Disciplines = "disciplines";
        public const string SetupDone = "setupDone";
        public const string KeepSignedIn = "keepSignedIn";
        public const string ShowTour = "showTour";

        public static bool GetBool(this IUserSettings s, string key, bool fallback) =>
            s.Get(key) is string v ? v == "true" : fallback;

        public static void SetBool(this IUserSettings s, string key, bool value) => s.Set(key, value ? "true" : "false");
    }

    public sealed class InMemoryUserSettings : IUserSettings
    {
        private readonly HashSet<string> _off = new HashSet<string>();
        private readonly Dictionary<string, string> _values = new Dictionary<string, string>();

        public event EventHandler? Changed;

        public bool IsPartOn(string partId) => !_off.Contains(partId);

        public void SetPart(string partId, bool on)
        {
            if (on ? _off.Remove(partId) : _off.Add(partId)) Changed?.Invoke(this, EventArgs.Empty);
        }

        public string? Get(string key) => _values.TryGetValue(key, out var v) ? v : null;

        public void Set(string key, string? value)
        {
            if (Get(key) == value) return;
            if (value == null) _values.Remove(key);
            else _values[key] = value;
            Changed?.Invoke(this, EventArgs.Empty);
        }
    }

    /// <summary>Settings in a JSON file, by default %APPDATA%\Formcraft\settings.json. A broken file is set aside, not lost.</summary>
    public sealed class JsonUserSettings : IUserSettings
    {
        [DataContract]
        private sealed class Data
        {
            [DataMember(Name = "partsOff", Order = 1)] public List<string> PartsOff { get; set; } = new List<string>();
            [DataMember(Name = "values", Order = 2)] public Dictionary<string, string> Values { get; set; } = new Dictionary<string, string>();
        }

        private static readonly DataContractJsonSerializerSettings Format = new DataContractJsonSerializerSettings { UseSimpleDictionaryFormat = true };

        private readonly string _path;
        private readonly string _mutexName;
        private Data _data;
        private (DateTime, long)? _seen;

        public JsonUserSettings(string path)
        {
            _path = path;
            _mutexName = MutexName(path);
            _data = ReadReporting(path);
            _seen = Stamp(path);
        }

        /// <summary>The last save or read problem (file locked, read-only, no access), or null. The value stays in memory.</summary>
        public string? LastError { get; private set; }

        /// <summary>Raised with a plain message when the file could not be saved (F07: shown in the footer).</summary>
        public event EventHandler<string>? SaveFailed;

        public static string DefaultPath =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Formcraft", "settings.json");

        public event EventHandler? Changed;

        public bool IsPartOn(string partId) => !_data.PartsOff.Contains(partId);

        public string? Get(string key) => _data.Values.TryGetValue(key, out var v) ? v : null;

        public void Set(string key, string? value)
        {
            if (Get(key) == value) return;
            void Apply(Data d)
            {
                if (value == null) d.Values.Remove(key);
                else d.Values[key] = value;
            }
            Apply(_data);
            Save(Apply);
            Changed?.Invoke(this, EventArgs.Empty);
        }

        public void SetPart(string partId, bool on)
        {
            var changed = on ? _data.PartsOff.Contains(partId) : !_data.PartsOff.Contains(partId);
            if (!changed) return;
            void Apply(Data d)
            {
                d.PartsOff.RemoveAll(p => p == partId);
                if (!on) d.PartsOff.Add(partId);
                d.PartsOff = d.PartsOff.Distinct().OrderBy(p => p, StringComparer.Ordinal).ToList();
            }
            Apply(_data);
            Save(Apply);
            Changed?.Invoke(this, EventArgs.Empty);
        }

        // F07: the old save deleted settings.json and then moved a fixed-name temp over it, so a crash in between lost
        // the file and two Revits could clash on the same .tmp and overwrite each other's changes. Now: one writer at a
        // time across processes (a named mutex), re-read and apply this one change when another Revit wrote the file
        // since we last saw it, a unique temp, File.Replace with one .bak, and no exception out of Set.
        private void Save(Action<Data> change)
        {
            string? temp = null;
            Mutex? mutex = null;
            var owned = false;
            try
            {
                mutex = new Mutex(false, _mutexName);
                try { owned = mutex.WaitOne(TimeSpan.FromSeconds(2)); }
                catch (AbandonedMutexException) { owned = true; }

                var dir = Path.GetDirectoryName(_path);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                var now = Stamp(_path);
                if (now != null && now != _seen)
                {
                    var disk = Read(_path);
                    change(disk);
                    _data = disk;
                }
                temp = _path + "." + Guid.NewGuid().ToString("N") + ".tmp";
                using (var file = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    new DataContractJsonSerializer(typeof(Data), Format).WriteObject(file, _data);
                if (File.Exists(_path)) File.Replace(temp, _path, _path + ".bak", ignoreMetadataErrors: true);
                else File.Move(temp, _path);
                temp = null;
                _seen = Stamp(_path);
                LastError = null;
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
            {
                Fail("Settings not saved: " + ex.Message + " The change applies until Revit closes.");
            }
            finally
            {
                if (temp != null) try { File.Delete(temp); } catch (Exception) { /* best effort */ }
                if (owned) try { mutex!.ReleaseMutex(); } catch (ApplicationException) { /* not owned */ }
                mutex?.Dispose();
            }
        }

        private void Fail(string message)
        {
            LastError = message;
            SaveFailed?.Invoke(this, message);
        }

        private Data ReadReporting(string path)
        {
            try { return Read(path); }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
            {
                LastError = "Settings not read: " + ex.Message + " Defaults are used.";
                return new Data();
            }
        }

        private static (DateTime, long)? Stamp(string path)
        {
            try
            {
                var info = new FileInfo(path);
                return info.Exists ? (info.LastWriteTimeUtc, info.Length) : ((DateTime, long)?)null;
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
            {
                return null;
            }
        }

        /// <summary>One name per settings file, the same in every process (string.GetHashCode is not).</summary>
        private static string MutexName(string path)
        {
            uint hash = 2166136261;
            foreach (var ch in Path.GetFullPath(path).ToLowerInvariant())
            {
                hash ^= ch;
                hash *= 16777619;
            }
            return @"Local\Formcraft.Settings." + hash.ToString("x8");
        }

        private static Data Read(string path)
        {
            if (!File.Exists(path)) return new Data();
            try
            {
                using var file = File.OpenRead(path);
                var data = (Data?)new DataContractJsonSerializer(typeof(Data), Format).ReadObject(file);
                if (data != null && data.PartsOff == null) data.PartsOff = new List<string>();
                if (data != null && data.Values == null) data.Values = new Dictionary<string, string>();
                return data ?? new Data();
            }
            catch (SerializationException)
            {
                // Keep the broken file for whoever wants to look, and start from the defaults.
                try { File.Copy(path, path + ".broken", overwrite: true); }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException) { /* the defaults still apply */ }
                return new Data();
            }
        }
    }
}
