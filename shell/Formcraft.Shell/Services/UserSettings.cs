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
        event EventHandler? Changed;
    }

    public sealed class InMemoryUserSettings : IUserSettings
    {
        private readonly HashSet<string> _off = new HashSet<string>();

        public event EventHandler? Changed;

        public bool IsPartOn(string partId) => !_off.Contains(partId);

        public void SetPart(string partId, bool on)
        {
            if (on ? _off.Remove(partId) : _off.Add(partId)) Changed?.Invoke(this, EventArgs.Empty);
        }
    }

    /// <summary>Settings in a JSON file, by default %APPDATA%\Formcraft\settings.json. A broken file is set aside, not lost.</summary>
    public sealed class JsonUserSettings : IUserSettings
    {
        [DataContract]
        private sealed class Data
        {
            [DataMember(Name = "partsOff", Order = 1)] public List<string> PartsOff { get; set; } = new List<string>();
        }

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
                new DataContractJsonSerializer(typeof(Data)).WriteObject(file, _data);
            if (File.Exists(_path)) File.Delete(_path);
            File.Move(temp, _path);
        }

        private static Data Read(string path)
        {
            if (!File.Exists(path)) return new Data();
            try
            {
                using var file = File.OpenRead(path);
                var data = (Data?)new DataContractJsonSerializer(typeof(Data)).ReadObject(file);
                if (data != null && data.PartsOff == null) data.PartsOff = new List<string>();
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
