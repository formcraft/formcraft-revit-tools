using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_doc sessions (plan B1a) on the Revit main thread. A session is a background document: new from a template the
    /// server checked (.rft), or a family file in staging. It never shows in Revit's window and is never a project or
    /// workshared model. open, report, screenshot, save (to a path the server checked) and close. A session is never
    /// closed silently (F-046): background reports how long each has been idle, the server marks the ones idle longer
    /// than the guard's session_idle_hours as stale, and fmc_recipe cleanup closes them without saving, after a dry run.
    /// </summary>
    public class FmcDocEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private sealed class Session
        {
            public Document Doc;
            public string Source = "";
            public DateTime Opened;
            public DateTime Used;
            /// <summary>The file was already open in Revit (the person's window or another tool): never close it (F-023).</summary>
            public bool Borrowed;
        }

        private static readonly Dictionary<string, Session> Sessions = new Dictionary<string, Session>();
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public string Action { get; set; } = "";
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                FmcSharedParams.RestoreIfPending(app.Application);
                switch (Action)
                {
                    case "open": Result = Open(app); break;
                    case "report": Result = Report(Get()); break;
                    case "screenshot": Result = Screenshot(Get()); break;
                    case "save": Result = Save(Get()); break;
                    case "close": Result = Close(app); break;
                    case "background": Result = Background(app); break;
                    case "flex": Result = FmcDocGeometry.Flex(Get().Doc); break;
                    case "apply":
                        var s = Get();
                        Result = FmcDocOps.Apply(s.Doc, Parameters["ops"] as JArray ?? new JArray(), Parameters.Value<bool?>("dry_run") != false,
                            Parameters.Value<string>("shared_parameter_file") ?? "", FmcDocProgress.PathFor(Parameters.Value<string>("session") ?? ""));
                        break;
                    default: Error = $"Unknown fmc_doc action '{Action}'"; break;
                }
            }
            catch (Exception ex)
            {
                Error = ex.Message;
            }
            finally
            {
                // F-037: whatever happened, Revit points at the person's shared parameter file again
                try { FmcSharedParams.RestoreIfPending(app.Application); } catch (Exception) { /* reported by the next result */ }
                _resetEvent.Set();
            }
        }

        public string GetName() => "FMC doc";

        /// <summary>Only background documents this tool opened itself are closed; never the person's window (F-023).</summary>
        private static bool CanClose(UIApplication app, Session s)
        {
            if (s.Borrowed || !s.Doc.IsValidObject) return false;
            Document active = app.ActiveUIDocument?.Document;
            if (active != null && active.Equals(s.Doc)) return false;
            // Shown in any Revit window: the person's now, even if a session opened it (F-023, F-040)
            try { if (new UIDocument(s.Doc).GetOpenUIViews().Count > 0) return false; } catch (Exception) { /* no UI: background */ }
            return true;
        }

        private Session Get()
        {
            string id = Parameters.Value<string>("session") ?? "";
            if (!Sessions.TryGetValue(id, out Session s) || !s.Doc.IsValidObject)
            {
                Sessions.Remove(id);
                throw new InvalidOperationException($"No open session '{id}' (closed, closed by fmc_recipe cleanup, or Revit restarted). Open it again.");
            }
            s.Used = DateTime.Now;
            return s;
        }

        private JObject Open(UIApplication app)
        {
            string template = Parameters.Value<string>("template") ?? "";
            string file = Parameters.Value<string>("file") ?? "";
            Document doc;
            bool borrowed = false;
            if (template.Length > 0)
            {
                if (!File.Exists(template)) throw new FileNotFoundException("Template not found: " + template);
                doc = app.Application.NewFamilyDocument(template) ?? throw new InvalidOperationException("Revit could not start a family from " + template);
            }
            else if (file.Length > 0)
            {
                if (!File.Exists(file)) throw new FileNotFoundException("File not found: " + file);
                // Already open (in the person's window, or a session that wasn't closed): use it, never close it (F-023).
                Document already = app.Application.Documents.Cast<Document>().FirstOrDefault(d =>
                    !d.IsLinked && string.Equals(d.PathName, file, StringComparison.OrdinalIgnoreCase));
                borrowed = already != null;
                doc = already ?? app.Application.OpenDocumentFile(file);
                if (!doc.IsFamilyDocument || doc.IsWorkshared)
                {
                    if (!borrowed) doc.Close(false);
                    throw new InvalidOperationException("fmc_doc opens family files only (project templates come in B5).");
                }
            }
            else throw new InvalidOperationException("open needs a template (.rft) or a staging file (.rfa).");
            string id = Guid.NewGuid().ToString("N").Substring(0, 8);
            Sessions[id] = new Session { Doc = doc, Source = template.Length > 0 ? template : file, Opened = DateTime.Now, Used = DateTime.Now, Borrowed = borrowed };
            var r = Report(Sessions[id]);
            r["session"] = id;
            if (borrowed) r["already_open"] = "This file was already open in Revit; the session uses it and close will leave it open.";
            return r;
        }

        private static JObject Report(Session s)
        {
            Document doc = s.Doc;
            var r = new JObject { ["title"] = doc.Title, ["source"] = s.Source, ["family"] = doc.IsFamilyDocument, ["path"] = doc.PathName ?? "" };
            if (doc.IsFamilyDocument)
            {
                FamilyManager fm = doc.FamilyManager;
                r["category"] = doc.OwnerFamily?.FamilyCategory?.Name ?? "";
                r["parameters"] = new JArray(fm.GetParameters().Select(p => new JObject
                {
                    ["name"] = p.Definition.Name, ["instance"] = p.IsInstance, ["shared"] = p.IsShared,
                    ["guid"] = p.IsShared ? p.GUID.ToString() : "", ["formula"] = p.Formula ?? "",
                }));
                r["types"] = new JArray(fm.Types.Cast<FamilyType>().Select(t => t.Name).Where(n => !string.IsNullOrWhiteSpace(n)));
            }
            r["reference_planes"] = new JArray(new FilteredElementCollector(doc).OfClass(typeof(ReferencePlane)).Cast<ReferencePlane>().Select(p => p.Name));
            r["solids"] = new FilteredElementCollector(doc).OfClass(typeof(GenericForm)).GetElementCount();
            r["connectors"] = new FilteredElementCollector(doc).OfClass(typeof(ConnectorElement)).GetElementCount();
            r["dimensions"] = new FilteredElementCollector(doc).OfClass(typeof(Dimension)).GetElementCount();
            r["warnings"] = doc.GetWarnings().Count;
            r["views"] = new JArray(new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(v => !v.IsTemplate && v.CanBePrinted).Select(v => v.Name));
            return r;
        }

        /// <summary>A PNG of the family's 3D view (and front elevation when there is one), into the folder the server gave.</summary>
        private JObject Screenshot(Session s)
        {
            Document doc = s.Doc;
            string folder = Parameters.Value<string>("folder") ?? "";
            if (folder.Length == 0) throw new InvalidOperationException("screenshot needs a folder");
            Directory.CreateDirectory(folder);
            var views = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(v => !v.IsTemplate && v.CanBePrinted).ToList();
            var pick = new List<View>();
            var v3 = views.OfType<View3D>().FirstOrDefault();
            if (v3 != null) pick.Add(v3);
            var front = views.FirstOrDefault(v => v.ViewType == ViewType.Elevation && v.Name.IndexOf("Front", StringComparison.OrdinalIgnoreCase) >= 0);
            if (front != null) pick.Add(front);
            if (pick.Count == 0 && views.Count > 0) pick.Add(views[0]);
            if (pick.Count == 0) throw new InvalidOperationException("The document has no view to capture.");
            var files = new JArray();
            foreach (View v in pick)
            {
                string stem = Path.Combine(folder, Safe(doc.Title) + "_" + Safe(v.Name) + "_" + DateTime.Now.ToString("HHmmss"));
                var options = new ImageExportOptions
                {
                    ExportRange = ExportRange.SetOfViews, FilePath = stem, HLRandWFViewsFileType = ImageFileType.PNG,
                    ShadowViewsFileType = ImageFileType.PNG, ImageResolution = ImageResolution.DPI_150, ZoomType = ZoomFitType.FitToPage,
                    PixelSize = 1200, FitDirection = FitDirectionType.Horizontal,
                };
                options.SetViewsAndSheets(new List<ElementId> { v.Id });
                doc.ExportImage(options);
                string made = Directory.GetFiles(folder, Path.GetFileName(stem) + "*.png").FirstOrDefault() ?? "";
                if (made.Length > 0) files.Add(made);
            }
            return new JObject { ["files"] = files };
        }

        private static string Safe(string s) => string.Concat((s ?? "").Select(c => Path.GetInvalidFileNameChars().Contains(c) || c == ' ' ? '_' : c));

        private JObject Save(Session s)
        {
            string path = Parameters.Value<string>("path") ?? "";
            if (path.Length == 0) throw new InvalidOperationException("save needs the path the server checked");
            int backups = Math.Max(1, Parameters.Value<int?>("max_backups") ?? 3);
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            if (File.Exists(path) && Parameters.Value<bool?>("overwrite") != true)
                throw new InvalidOperationException(path + " exists: pass overwrite (a person decided) or save under another name.");
            var options = new SaveAsOptions { OverwriteExistingFile = Parameters.Value<bool?>("overwrite") == true, MaximumBackups = backups };
            s.Doc.SaveAs(path, options);
            return new JObject { ["saved"] = path, ["title"] = s.Doc.Title };
        }

        /// <summary>
        /// F-040 (read-only): the sessions this add-in holds, each with whether close may close it (never the person's window,
        /// F-023), and the other family documents open without a window, which only the person closes.
        /// </summary>
        private static JObject Background(UIApplication app)
        {
            var sessions = new JArray();
            var held = new List<Document>();
            foreach (var kv in Sessions.ToList())
            {
                Session s = kv.Value;
                bool valid = s.Doc.IsValidObject;
                if (valid) held.Add(s.Doc);
                bool closable = valid && CanClose(app, s);
                sessions.Add(new JObject
                {
                    ["session"] = kv.Key, ["title"] = valid ? s.Doc.Title : "", ["source"] = s.Source, ["valid"] = valid,
                    ["opened"] = s.Opened.ToString("s"), ["used"] = s.Used.ToString("s"), ["closable"] = closable,
                    // F-046: the server marks a session idle longer than the guard's limit as stale
                    ["idle_minutes"] = Math.Round((DateTime.Now - s.Used).TotalMinutes),
                    ["reason"] = !valid ? "already closed" : closable ? "opened by a Formcraft session, not in a Revit window"
                        : s.Borrowed ? "the person had this file open: it stays (F-023)" : "shown in a Revit window: it stays",
                });
            }
            var other = new JArray();
            foreach (Document d in app.Application.Documents.Cast<Document>())
            {
                if (d.IsLinked || !d.IsFamilyDocument || held.Any(h => h.Equals(d))) continue;
                int views = 0;
                try { views = new UIDocument(d).GetOpenUIViews().Count; } catch (Exception) { views = 0; }
                if (views > 0) continue;
                other.Add(new JObject { ["title"] = d.Title, ["path"] = d.PathName ?? "", ["note"] = "not opened by a Formcraft session: close it in Revit if it isn't needed" });
            }
            return new JObject { ["sessions"] = sessions, ["other_background"] = other, ["shared_parameter_file"] = FmcSharedParams.Status(app.Application) };
        }

        private JObject Close(UIApplication app)
        {
            string id = Parameters.Value<string>("session") ?? "";
            if (!Sessions.TryGetValue(id, out Session s)) return new JObject { ["closed"] = false, ["reason"] = "No such session" };
            try
            {
                if (!s.Doc.IsValidObject) return new JObject { ["closed"] = true, ["reason"] = "already closed" };
                if (!CanClose(app, s))
                    return new JObject { ["closed"] = false, ["left_open"] = true,
                        ["reason"] = "Open in a Revit window, so it stays for the person to close (F-023). The session is released." };
                s.Doc.Close(false);
                return new JObject { ["closed"] = true, ["unsaved_changes_discarded"] = true };
            }
            finally { Sessions.Remove(id); }
        }
    }
}
