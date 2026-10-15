using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Per-op progress of an fmc_doc apply (F-029), in %APPDATA%\Formcraft\Progress\fmc_doc_&lt;session&gt;.json. Written
    /// before every op and when the batch ends, so when the server stops waiting it can still say which op Revit was on,
    /// and a stepwise build can pick up a chunk that finished late. Small and overwritten each time; a failed write never
    /// stops the build. It moves to the job model (fmc_job) once that is merged.
    /// </summary>
    public static class FmcDocProgress
    {
        public static string PathFor(string session)
        {
            string safe = string.Concat((session ?? "").Select(c => char.IsLetterOrDigit(c) || c == '_' || c == '-' ? c : '_'));
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Formcraft", "Progress", "fmc_doc_" + safe + ".json");
        }

        public static void Write(string file, JObject state)
        {
            if (string.IsNullOrEmpty(file)) return;
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(file));
                state["updated"] = DateTime.UtcNow.ToString("o");
                string tmp = file + ".tmp";
                File.WriteAllText(tmp, state.ToString(Formatting.None));
                if (File.Exists(file)) File.Delete(file);
                File.Move(tmp, file);
            }
            catch (Exception)
            {
                // progress helps when something hangs; it never stops the work
            }
        }
    }
}
