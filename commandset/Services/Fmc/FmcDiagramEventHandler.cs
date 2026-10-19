using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Line diagrams (track LD) on the Revit main thread. scan: read-only, may open a closed file in the background
    /// (FmcDiagramScan). draw: drafting views from a DRAW_SPEC in documents already open, one transaction group, rolled
    /// back on a dry run (FmcDiagramDraw). Nothing is ever saved or synchronised here (rule 6); the live-model lock and
    /// the Generate button are checked by the server before a draw reaches Revit (rule 1, LD decision 1).
    /// </summary>
    public class FmcDiagramEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
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

        public string GetName() => "FMC line diagrams";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                switch (Action)
                {
                    case "scan":
                    {
                        using var target = FmcTarget.Resolve(app, Parameters, mayOpen: true);
                        Document doc = target.Doc;
                        if (doc.IsFamilyDocument) throw new InvalidOperationException("Line diagrams are scanned from a project model, not a family.");
                        Result = FmcDiagramScan.Scan(doc, Parameters);
                        break;
                    }
                    case "draw":
                    {
                        using var target = FmcTarget.Resolve(app, Parameters, mayOpen: false);
                        Document doc = target.Doc;
                        if (doc.IsFamilyDocument) throw new InvalidOperationException("Line diagrams are drawn in a project model, not a family.");
                        Result = FmcDiagramDraw.Draw(doc, Parameters);
                        break;
                    }
                    case "sheet":
                    {
                        // LD5: the register sheets and the drawn views on them (FmcDiagramSheet); a dry run rolls back
                        using var target = FmcTarget.Resolve(app, Parameters, mayOpen: false);
                        Document doc = target.Doc;
                        if (doc.IsFamilyDocument) throw new InvalidOperationException("Diagram sheets are made in a project model, not a family.");
                        Result = FmcDiagramSheet.Sheets(doc, Parameters);
                        break;
                    }
                    case "drawn":
                    {
                        // LD5 Gate D: read-only, like the scan
                        using var target = FmcTarget.Resolve(app, Parameters, mayOpen: true);
                        Document doc = target.Doc;
                        if (doc.IsFamilyDocument) throw new InvalidOperationException("Line diagrams are read from a project model, not a family.");
                        Result = FmcDiagramSheet.Drawn(doc, Parameters);
                        break;
                    }
                    default: Error = $"Unknown FMC diagram action '{Action}'"; break;
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
    }
}
