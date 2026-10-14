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
    /// Ready to issue (U19) on the Revit main thread. facts reads the revisions and each sheet's current revision; export
    /// prints one PDF per sheet into a folder the server has already checked against the guard (01_WIP\_Issue). Neither
    /// changes the model: marking a revision issued stays a person's step in Revit.
    /// </summary>
    public class FmcIssueEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
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
                Document doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("Open a model first.");
                if (doc.IsFamilyDocument) throw new InvalidOperationException("Sheets live in a project model.");
                switch (Action)
                {
                    case "facts": Result = Facts(doc); break;
                    case "export": Result = Export(doc); break;
                    default: Error = $"Unknown FMC issue action '{Action}'"; break;
                }
            }
            catch (Exception ex)
            {
                Error = ex.Message;
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public string GetName() => "FMC issue";

        private static JObject Facts(Document doc)
        {
            var revisions = new JArray();
            foreach (ElementId id in Revision.GetAllRevisionIds(doc))
            {
                if (!(doc.GetElement(id) is Revision r)) continue;
                revisions.Add(new JObject
                {
                    ["id"] = r.Id.Value, ["sequence"] = r.SequenceNumber, ["number"] = r.RevisionNumber ?? "", ["description"] = r.Description ?? "",
                    ["date"] = r.RevisionDate ?? "", ["issued"] = r.Issued,
                });
            }
            var sheets = new JArray();
            foreach (ViewSheet s in new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>())
            {
                if (s.IsPlaceholder) continue;
                string current = "";
                if (doc.GetElement(s.GetCurrentRevision()) is Revision r) current = r.RevisionNumber ?? "";
                sheets.Add(new JObject { ["id"] = s.Id.Value, ["number"] = s.SheetNumber, ["current_revision"] = current });
            }
            return new JObject { ["model"] = doc.Title, ["revisions"] = revisions, ["sheets"] = sheets };
        }

        private JObject Export(Document doc)
        {
            string folder = Parameters.Value<string>("folder") ?? "";
            if (folder.Length == 0 || !Directory.Exists(folder)) throw new InvalidOperationException("The issue folder doesn't exist: " + folder);
            var done = new JArray();
            foreach (JObject s in (Parameters["sheets"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string file = s.Value<string>("file") ?? "";
                var result = new JObject { ["file"] = file + ".pdf" };
                if (!(doc.GetElement(new ElementId(s.Value<long>("id"))) is ViewSheet sheet)) { result["result"] = "sheet not found"; done.Add(result); continue; }
                if (File.Exists(Path.Combine(folder, file + ".pdf"))) { result["result"] = "exists, not overwritten"; done.Add(result); continue; }
#if REVIT2022_OR_GREATER
                try
                {
                    var options = new PDFExportOptions { FileName = file, Combine = true, PaperFormat = ExportPaperFormat.Default, ZoomType = ZoomType.Zoom, ZoomPercentage = 100 };
                    bool ok = doc.Export(folder, new List<ElementId> { sheet.Id }, options);
                    result["result"] = ok ? "exported" : "Revit didn't export it";
                }
                catch (Exception e)
                {
                    result["result"] = "failed: " + e.Message;
                }
#else
                result["result"] = "PDF export needs Revit 2022 or later";
#endif
                done.Add(result);
            }
            return new JObject { ["folder"] = folder, ["sheets"] = done };
        }
    }
}
