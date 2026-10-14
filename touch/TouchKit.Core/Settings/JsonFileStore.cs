using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TouchKit.Core.Settings
{
    /// <summary>
    /// Saves and loads a settings object as JSON. Unknown or missing fields fall back to the class defaults,
    /// so files from older or newer versions still load. A broken file is set aside, never fatal.
    /// </summary>
    public sealed class JsonFileStore<T> where T : class, new()
    {
        public static readonly JsonSerializerOptions JsonOptions = new()
        {
            WriteIndented = true,
            Converters = { new JsonStringEnumConverter() },
            ReadCommentHandling = JsonCommentHandling.Skip,
            AllowTrailingCommas = true,
        };

        public JsonFileStore(string path)
        {
            Path = path;
        }

        public string Path { get; }

        /// <summary>Last problem reading or writing, for diagnostics.</summary>
        public string? LastError { get; private set; }

        public T Load()
        {
            try
            {
                if (!File.Exists(Path)) return new T();
                return Read(Path);
            }
            catch (Exception ex)
            {
                LastError = $"Could not read {Path}: {ex.Message}";
                TrySetAside(Path);
                return new T();
            }
        }

        public bool Save(T value)
        {
            try
            {
                Write(Path, value);
                LastError = null;
                return true;
            }
            catch (Exception ex)
            {
                LastError = $"Could not save {Path}: {ex.Message}";
                return false;
            }
        }

        public static T Read(string path) =>
            JsonSerializer.Deserialize<T>(File.ReadAllText(path), JsonOptions) ?? new T();

        public static void Write(string path, T value)
        {
            string? dir = System.IO.Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

            // Write to a temp file then swap, so a crash mid-write never leaves a half-written file.
            string temp = path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(value, JsonOptions));
            File.Move(temp, path, overwrite: true);
        }

        private static void TrySetAside(string path)
        {
            try { File.Move(path, path + $".broken-{DateTime.Now:yyyyMMddHHmmss}", overwrite: true); }
            catch { /* best effort */ }
        }
    }
}
