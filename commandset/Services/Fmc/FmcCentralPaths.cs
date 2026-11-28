using System;
using System.IO;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Path rules shared by FmcCentral (no Revit types): a build or throwaway path must be a local strict
    /// subfolder of %LOCALAPPDATA%\Formcraft\central-temp, never the temp root itself.
    /// </summary>
    public static class FmcCentralPaths
    {
        public static string TempRoot()
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrEmpty(local)) local = Path.GetTempPath();
            return Path.GetFullPath(Path.Combine(local, "Formcraft", "central-temp"));
        }

        public static string Canonical(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return "";
            try { return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar); }
            catch (Exception) { return ""; }
        }

        public static bool IsUnc(string path)
        {
            string c = Canonical(path);
            string raw = (path ?? "").Trim();
            return c.StartsWith(@"\\", StringComparison.Ordinal) || raw.StartsWith(@"\\", StringComparison.Ordinal);
        }

        public static bool IsNetwork(string path)
        {
            if (IsUnc(path)) return true;
            string c = Canonical(path);
            if (c.Length < 2 || c[1] != ':') return false;
            try { return new DriveInfo(c.Substring(0, 2)).DriveType == DriveType.Network; }
            catch (Exception) { return true; } // fail closed: an unreadable drive is not a safe temp
        }

        /// <summary>True when path is root itself or a file/folder inside it.</summary>
        public static bool IsUnder(string path, string root)
        {
            string c = Canonical(path), r = Canonical(root);
            if (c.Length == 0 || r.Length == 0) return false;
            return c.Equals(r, StringComparison.OrdinalIgnoreCase)
                || c.StartsWith(r + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>A build or throwaway path must canonicalise to a local (non-UNC, non-network) strict subfolder of TempRoot(), never the root itself.</summary>
        public static bool IsSafeTempPath(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || IsUnc(path) || IsNetwork(path)) return false;
            string c = Canonical(path), r = Canonical(TempRoot());
            if (c.Length == 0 || r.Length == 0) return false;
            if (c.Equals(r, StringComparison.OrdinalIgnoreCase)) return false;
            return c.StartsWith(r + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }
    }
}
