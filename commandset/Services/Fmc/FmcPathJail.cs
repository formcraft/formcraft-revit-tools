using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Microsoft.Win32.SafeHandles;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Project-folder gate, add-in side (Emlyn 28 Nov 2026; plan §3.4). The same rules as server/src/fmc/jail.ts, with a
    /// root the add-in derives itself from the document, never from request JSON:
    ///  - workshared: the central's folder + that document's local file, its &lt;name&gt;_backup folder and .NNNN backups;
    ///  - saved, not workshared: the project folder above 01_WIP, else only the file and its backups;
    ///  - unsaved: no root (no file IO);
    ///  - read_only_roots (fmc_guard.json): read and open only; %LOCALAPPDATA%\Formcraft and %APPDATA%\Formcraft:
    ///    read only; protected_roots and the forbidden-project floor (A-0001, HEBERT HOSTELS, + forbidden_projects): no writes.
    /// Paths are canonical before the compare: %VAR% expanded, GetFullPath, the deepest existing part resolved with
    /// GetFinalPathNameByHandle (junctions, symlinks, subst, 8.3), admin shares of this PC turned into the drive path,
    /// \\?\, \\.\, streams, NUL, device names, wildcards and trailing dots or spaces refused. Compare by whole segments.
    /// </summary>
    public static class FmcPathJail
    {
        public const string Outside = "FMC-JAIL-OUTSIDE", ReadOnly = "FMC-JAIL-READONLY", Shared = "FMC-JAIL-SHARED", BadPath = "FMC-JAIL-BADPATH",
            NoRoot = "FMC-JAIL-NOROOT", Forbidden = "FMC-JAIL-FORBIDDEN", Protected = "FMC-JAIL-PROTECTED";

        public static readonly string[] ForbiddenFloor = { "A-0001", "HEBERT HOSTELS" };

        public sealed class Root
        {
            public string Path; public string Kind; public string Why; public Regex Pattern;
            public bool Covers(string key)
            {
                if (Kind == "pattern") return Pattern != null && Pattern.IsMatch(key);
                string rk = Key(Path);
                return Kind == "file" ? key == rk : Inside(key, rk);
            }
        }

        public sealed class Roots
        {
            public string Document = "";
            public List<Root> Doc = new List<Root>();
            public List<Root> ReadOnlyRoots = new List<Root>();
            public List<Root> SharedRoots = new List<Root>();
            public List<Root> ProtectedRoots = new List<Root>();
            public List<string> ForbiddenNames = new List<string>(ForbiddenFloor);
            public List<string> Notes = new List<string>();
        }

        public sealed class Verdict
        {
            public bool Ok; public string Code = ""; public string Message = ""; public string Resolved = "";
            public static Verdict No(string code, string message, string resolved = "") => new Verdict { Ok = false, Code = code, Message = "[" + code + "] " + message, Resolved = resolved };
        }

        // ---------- canonical paths ----------

        static readonly Regex Device = new Regex(@"^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\..*)?$", RegexOptions.IgnoreCase);
        static readonly char[] Wild = { '*', '?', '<', '>', '"', '|' };

        public static string Key(string canonicalPath) =>
            string.Join("\\", (canonicalPath ?? "").ToLowerInvariant().Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries));

        public static bool Inside(string childKey, string rootKey) =>
            !string.IsNullOrEmpty(rootKey) && (childKey == rootKey || childKey.StartsWith(rootKey + "\\", StringComparison.Ordinal));

        /// <summary>The canonical path, or null with a problem.</summary>
        public static string Canonical(string raw, out string problem)
        {
            problem = null;
            if (string.IsNullOrWhiteSpace(raw)) { problem = "the path is empty"; return null; }
            if (raw.IndexOf('\0') >= 0) { problem = "the path holds a NUL character"; return null; }
            string p = raw.TrimStart().Replace('/', '\\');
            if (p.StartsWith(@"\\?\") || p.StartsWith(@"\\.\") || p.StartsWith(@"\??\")) { problem = @"device and \\?\ paths are refused"; return null; }
            if (Regex.IsMatch(p, @"%[^%\\]+%"))
            {
                p = Environment.ExpandEnvironmentVariables(p).Replace('/', '\\');
                if (Regex.IsMatch(p, @"%[^%\\]+%")) { problem = "the path names an environment variable that is not set"; return null; }
                if (p.StartsWith(@"\\?\") || p.StartsWith(@"\\.\")) { problem = @"device and \\?\ paths are refused"; return null; }
            }
            bool drive = Regex.IsMatch(p, @"^[a-zA-Z]:\\");
            bool unc = Regex.IsMatch(p, @"^\\\\[^\\]+\\[^\\]+");
            if (!drive && !unc) { problem = @"the path must be a full path (a drive letter or \\server\share)"; return null; }
            if (p.Substring(drive ? 2 : 0).IndexOf(':') >= 0) { problem = "alternate data streams (':' in the path) are refused"; return null; }
            foreach (string seg in p.Split('\\').Skip(drive ? 1 : 2))
            {
                if (seg.Length == 0 || seg == "." || seg == "..") continue;
                if (seg.IndexOfAny(Wild) >= 0) { problem = "wildcards are refused (" + seg + ")"; return null; }
                if (Device.IsMatch(seg)) { problem = "device names are refused (" + seg + ")"; return null; }
                if (seg.EndsWith(".") || seg.EndsWith(" ")) { problem = "a name ending in a dot or space is refused (" + seg + ")"; return null; }
            }
            try { p = System.IO.Path.GetFullPath(p); } catch (Exception e) { problem = "the path is not valid: " + e.Message; return null; }
            p = AdminShareToDrive(p);
            string[] segs = p.Split('\\');
            int head = Regex.IsMatch(segs[0], @"^[a-zA-Z]:$") ? 1 : 4;
            int cut = segs.Length;
            string real = null;
            while (cut >= head)
            {
                string probe = string.Join("\\", segs.Take(cut)) + (cut == 1 && head == 1 ? "\\" : "");
                if (Exists(probe))
                {
                    real = FinalPath(probe);
                    if (real == null) { problem = "the path could not be resolved (" + probe + ")"; return null; }
                    break;
                }
                cut--;
            }
            var tail = segs.Skip(cut).ToArray();
            if (tail.Any(s => Regex.IsMatch(s, @"~\d"))) { problem = "an 8.3 short name in a part of the path that does not exist is refused"; return null; }
            string full = real != null ? (tail.Length > 0 ? System.IO.Path.Combine(new[] { real }.Concat(tail).ToArray()) : real) : p;
            full = AdminShareToDrive(StripLong(full)).TrimEnd('\\');
            if (Regex.IsMatch(full, @"^[a-zA-Z]:$")) full += "\\";
            return full;
        }

        static bool Exists(string p)
        {
            try { File.GetAttributes(p); return true; } catch (Exception) { return false; }
        }

        static string StripLong(string p)
        {
            if (p.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + p.Substring(8);
            if (p.StartsWith(@"\\?\")) return p.Substring(4);
            return p;
        }

        static string AdminShareToDrive(string p)
        {
            var m = Regex.Match(p, @"^\\\\([^\\]+)\\([a-zA-Z])\$(\\.*)?$");
            if (!m.Success) return p;
            string host = m.Groups[1].Value.ToLowerInvariant();
            var local = new[] { "localhost", "127.0.0.1", "::1", "[::1]", Environment.MachineName.ToLowerInvariant() };
            if (!local.Contains(host)) return p;
            return m.Groups[2].Value.ToUpperInvariant() + ":" + (m.Groups[3].Success && m.Groups[3].Value.Length > 0 ? m.Groups[3].Value : "\\");
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint size, uint flags);

        /// <summary>The final path of an existing file or folder (reparse points followed), or null.</summary>
        static string FinalPath(string p)
        {
            const uint FILE_READ_ATTRIBUTES = 0x80, SHARE_ALL = 7, OPEN_EXISTING = 3, FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
            using (SafeFileHandle h = CreateFileW(p, FILE_READ_ATTRIBUTES, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero))
            {
                if (h.IsInvalid) return null;
                var sb = new StringBuilder(1024);
                uint n = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0);
                if (n == 0) return null;
                if (n > sb.Capacity) { sb = new StringBuilder((int)n + 1); n = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0); if (n == 0) return null; }
                return StripLong(sb.ToString());
            }
        }

        // ---------- the guard file (never request JSON) ----------

        static string GuardPath()
        {
            string path = Environment.GetEnvironmentVariable("FMC_GUARD_CONFIG");
            return string.IsNullOrWhiteSpace(path) ? System.IO.Path.Combine(Bridge.FmcAiJob.FormcraftDir(), "fmc_guard.json") : path;
        }

        static List<string> GuardList(JObject guard, string key) =>
            (guard?[key] as JArray)?.Where(t => t.Type == JTokenType.String).Select(t => t.ToString().Trim()).Where(s => s.Length > 0).ToList() ?? new List<string>();

        static JObject ReadGuard()
        {
            try { string p = GuardPath(); return File.Exists(p) ? JObject.Parse(File.ReadAllText(p)) : null; } catch (Exception) { return null; }
        }

        public static IEnumerable<string> SharedStateFolders()
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            if (!string.IsNullOrEmpty(local)) yield return System.IO.Path.Combine(local, "Formcraft");
            if (!string.IsNullOrEmpty(roaming)) yield return System.IO.Path.Combine(roaming, "Formcraft");
        }

        // ---------- roots ----------

        static Root Folder(string p, string why) { string c = Canonical(p, out _); return c == null ? null : new Root { Path = c, Kind = "folder", Why = why }; }
        static Root FileRoot(string p, string why) { string c = Canonical(p, out _); return c == null ? null : new Root { Path = c, Kind = "file", Why = why }; }

        static IEnumerable<Root> Backups(string file)
        {
            string c = Canonical(file, out _);
            if (c == null) yield break;
            string dir = System.IO.Path.GetDirectoryName(c) ?? "";
            string ext = System.IO.Path.GetExtension(c);
            string stem = System.IO.Path.GetFileNameWithoutExtension(c);
            Root folder = Folder(System.IO.Path.Combine(dir, stem + "_backup"), "the document's backup folder");
            if (folder != null) yield return folder;
            yield return new Root { Path = System.IO.Path.Combine(dir, stem + ".NNNN" + ext), Kind = "pattern", Why = "the document's .NNNN backups",
                Pattern = new Regex("^" + Regex.Escape(Key(dir)) + @"\\" + Regex.Escape(stem.ToLowerInvariant()) + @"\.\d{4}" + Regex.Escape(ext.ToLowerInvariant()) + "$") };
        }

        public static string ProjectRootOf(string file)
        {
            var segs = (file ?? "").Split('\\');
            int i = Array.FindIndex(segs, s => string.Equals(s, "01_WIP", StringComparison.OrdinalIgnoreCase));
            return i > 0 ? string.Join("\\", segs.Take(i)) : "";
        }

        /// <summary>The central model's user-visible path of a workshared document ("" when not workshared, detached or unknown).</summary>
        public static string CentralOf(Document doc)
        {
            try
            {
                if (!doc.IsWorkshared || doc.IsDetached) return "";
                ModelPath central = doc.GetWorksharingCentralModelPath();
                return central == null ? "" : ModelPathUtils.ConvertModelPathToUserVisiblePath(central) ?? "";
            }
            catch (Exception) { return ""; }
        }

        /// <summary>The document's own roots (no read-only or shared roots).</summary>
        public static List<Root> DocRoots(Document doc, List<string> notes)
        {
            var list = new List<Root>();
            string file = doc?.PathName ?? "";
            if (doc == null) { notes.Add("no document"); return list; }
            if (string.IsNullOrEmpty(file)) { notes.Add(doc.Title + " is not saved: no project folder, no file IO (Q2)"); return list; }
            if (FmcTarget.IsCloud(file)) { notes.Add("a cloud model has no folder on this PC"); return list; }
            if (doc.IsWorkshared)
            {
                string central = CentralOf(doc);
                bool isCentral = central.Length > 0 && FmcTarget.SamePath(central, file);
                if (central.Length > 0 && !FmcTarget.IsCloud(central)) { Root r = Folder(System.IO.Path.GetDirectoryName(central), "the central's folder"); if (r != null) list.Add(r); }
                else notes.Add("the central's path is not known: only the local and its backups are open");
                if (!isCentral) { Root r = FileRoot(file, "the document's local file"); if (r != null) list.Add(r); list.AddRange(Backups(file)); }
                return list;
            }
            string project = ProjectRootOf(file);
            if (project.Length > 0) { Root r = Folder(project, "the project folder above 01_WIP"); if (r != null) list.Add(r); }
            else { notes.Add("no 01_WIP above this model: only the file and its backups"); Root r = FileRoot(file, "the document's file"); if (r != null) list.Add(r); list.AddRange(Backups(file)); }
            return list;
        }

        /// <summary>The jail of one or more documents (each adds its own roots), plus the guard file's roots.</summary>
        public static Roots For(params Document[] docs)
        {
            var r = new Roots();
            foreach (Document d in docs.Where(d => d != null)) { r.Doc.AddRange(DocRoots(d, r.Notes)); r.Document += (r.Document.Length > 0 ? " + " : "") + (string.IsNullOrEmpty(d.PathName) ? d.Title : d.PathName); }
            JObject guard = ReadGuard();
            r.ReadOnlyRoots.AddRange(GuardList(guard, "read_only_roots").Select(p => Folder(p, "read_only_roots")).Where(x => x != null));
            r.ProtectedRoots.AddRange(GuardList(guard, "protected_roots").Select(p => Folder(p, "protected_roots")).Where(x => x != null));
            r.ForbiddenNames.AddRange(GuardList(guard, "forbidden_projects"));
            r.SharedRoots.AddRange(SharedStateFolders().Select(p => Folder(p, "shared state")).Where(x => x != null));
            return r;
        }

        // ---------- the check ----------

        static string Norm(string s) => Regex.Replace((s ?? "").ToUpperInvariant(), @"[\s_\-.~]+", " ").Trim();

        public static string ForbiddenProject(string text, IEnumerable<string> names)
        {
            var list = names.Distinct().Select(n => new { Name = n, Norm = Norm(n), Code = n.Any(char.IsDigit) }).ToList();
            foreach (string seg in (text ?? "").Split('\\', '/'))
            {
                string s = Norm(Regex.Replace(seg, @"\.(rvt|rfa|rte|rft)$", "", RegexOptions.IgnoreCase));
                if (s.Length == 0) continue;
                foreach (var n in list)
                {
                    if (n.Norm.Length == 0) continue;
                    if (s.StartsWith(n.Norm, StringComparison.Ordinal)) return n.Name;
                    if (!n.Code && (" " + s).Contains(" " + n.Norm)) return n.Name;
                }
            }
            return null;
        }

        static string Show(List<Root> roots) => roots.Count == 0 ? "(none)" : string.Join("; ", roots.Select(x => x.Path));

        /// <summary>kind: read, list, open or write.</summary>
        public static Verdict Check(string kind, string raw, Roots roots, string param = null)
        {
            string label = string.IsNullOrEmpty(param) ? "" : param + ": ";
            string c = Canonical(raw, out string problem);
            if (c == null) return Verdict.No(BadPath, label + problem + ": " + raw);
            string key = Key(c);
            if (kind == "write")
            {
                string forbidden = ForbiddenProject(c, roots.ForbiddenNames) ?? ForbiddenProject(raw, roots.ForbiddenNames);
                if (forbidden != null) return Verdict.No(Forbidden, label + c + " is in a forbidden project (" + forbidden + "): never written.", c);
                Root sh = roots.SharedRoots.FirstOrDefault(x => x.Covers(key));
                if (sh != null) return Verdict.No(Shared, label + c + " is Formcraft shared state (" + sh.Path + "): the AI may read it, never change it.", c);
                Root ro = roots.ReadOnlyRoots.FirstOrDefault(x => x.Covers(key));
                if (ro != null) return Verdict.No(ReadOnly, label + c + " is under a read-only root (" + ro.Path + "): writes there are always refused.", c);
                Root pr = roots.ProtectedRoots.FirstOrDefault(x => x.Covers(key));
                if (pr != null) return Verdict.No(Protected, label + c + " is under protected_roots (" + pr.Path + "): writes are refused.", c);
                if (roots.Doc.Count == 0) return Verdict.No(NoRoot, label + "no project folder for " + (roots.Document.Length > 0 ? roots.Document : "this call") + (roots.Notes.Count > 0 ? " (" + roots.Notes[0] + ")" : "") + ": " + c + " is refused.", c);
                if (roots.Doc.Any(x => x.Covers(key))) return new Verdict { Ok = true, Resolved = c };
                return Verdict.No(Outside, label + c + " is outside the project folder of " + roots.Document + " (" + Show(roots.Doc) + ").", c);
            }
            if (roots.Doc.Any(x => x.Covers(key)) || roots.ReadOnlyRoots.Any(x => x.Covers(key)) || roots.SharedRoots.Any(x => x.Covers(key)))
                return new Verdict { Ok = true, Resolved = c };
            return Verdict.No(roots.Doc.Count > 0 ? Outside : NoRoot, label + c + " is outside the project folder of " + (roots.Document.Length > 0 ? roots.Document : "this call") +
                " (" + Show(roots.Doc) + ") and outside read_only_roots (" + Show(roots.ReadOnlyRoots) + ").", c);
        }

        /// <summary>Throws the refusal; returns the canonical path to use for the IO.</summary>
        public static string Require(string kind, string raw, Roots roots, string param = null)
        {
            Verdict v = Check(kind, raw, roots, param);
            if (!v.Ok) throw new InvalidOperationException(v.Message);
            return v.Resolved;
        }

        /// <summary>The open project documents (not families, not links).</summary>
        public static List<Document> OpenProjects(Autodesk.Revit.ApplicationServices.Application app) =>
            app.Documents.Cast<Document>().Where(d => !d.IsFamilyDocument && !d.IsLinked).ToList();

        /// <summary>
        /// A family's jail: its own roots, plus the project it is meant for (the named one, else the only open project).
        /// Two or more projects open and none named: the family's own roots only.
        /// </summary>
        public static Roots ForFamily(Document family, string projectTitle = null) => For(family, ProjectFor(family.Application, projectTitle));

        /// <summary>The named open project (title or path), else the only open project, else null.</summary>
        public static Document ProjectFor(Autodesk.Revit.ApplicationServices.Application app, string projectTitle)
        {
            var projects = OpenProjects(app);
            return !string.IsNullOrEmpty(projectTitle)
                ? projects.FirstOrDefault(d => string.Equals(d.Title, projectTitle, StringComparison.OrdinalIgnoreCase) || FmcTarget.SamePath(d.PathName ?? "", projectTitle))
                : (projects.Count == 1 ? projects[0] : null);
        }

        /// <summary>
        /// May a family be loaded into this project? The project must be saved, not a forbidden project, not a workshared
        /// central (open a local), and its file must be inside its own jail (not under protected_roots, read_only_roots or
        /// shared state). Throws the refusal.
        /// </summary>
        public static void RequireLoadTarget(Document project)
        {
            string file = project.PathName ?? "";
            if (file.Length == 0) throw new InvalidOperationException("[" + NoRoot + "] " + project.Title + " is not saved: save the project first, then load the family.");
            Roots r = For(project);
            string forbidden = ForbiddenProject(file, r.ForbiddenNames) ?? ForbiddenProject(project.Title, r.ForbiddenNames);
            if (forbidden != null) throw new InvalidOperationException("[" + Forbidden + "] " + project.Title + " is a forbidden project (" + forbidden + "): never changed.");
            string central = CentralOf(project);
            if (project.IsWorkshared && central.Length > 0 && FmcTarget.SamePath(central, file))
                throw new InvalidOperationException("[" + Outside + "] " + project.Title + " is the workshared central: open a local copy and load the family there.");
            Require("write", file, r, "project");
        }
    }
}
