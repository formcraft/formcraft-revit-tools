using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;

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
        private Data _data;

        public JsonUserSettings(string path)
        {
            _path = path;
            _data = Read(path);
        }

        public static string DefaultPath =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Formcraft", "settings.json");

        public event EventHandler? Changed;

        public bool IsPartOn(string partId) => !_data.PartsOff.Contains(partId);

        public string? Get(string key) => _data.Values.TryGetValue(key, out var v) ? v : null;

        public void Set(string key, string? value)
        {
            if (Get(key) == value) return;
            if (value == null) _data.Values.Remove(key);
            else _data.Values[key] = value;
            Save();
            Changed?.Invoke(this, EventArgs.Empty);
        }

        public void SetPart(string partId, bool on)
        {
            var changed = on ? _data.PartsOff.Remove(partId) : !_data.PartsOff.Contains(partId);
            if (!changed) return;
            if (!on) _data.PartsOff.Add(partId);
            _data.PartsOff = _data.PartsOff.Distinct().OrderBy(p => p, StringComparer.Ordinal).ToList();
            Save();
            Changed?.Invoke(this, EventArgs.Empty);
        }

        private void Save()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            var temp = _path + ".tmp";
            using (var file = File.Create(temp))
                new DataContractJsonSerializer(typeof(Data), Format).WriteObject(file, _data);
            if (File.Exists(_path)) File.Delete(_path);
            File.Move(temp, _path);
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
                File.Copy(path, path + ".broken", overwrite: true);
                return new Data();
            }
        }
    }
}
