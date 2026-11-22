using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// The JSON-RPC parameters of the command running now. Legacy handlers read the document from here
    /// instead of <c>ActiveUIDocument</c>. One command runs at a time on the external-event queue.
    /// </summary>
    public static class FmcCallContext
    {
        public static JObject Parameters { get; private set; } = new JObject();
        static Document _cached;

        public static void Begin(JObject parameters)
        {
            Parameters = parameters ?? new JObject();
            _cached = null;
        }

        /// <summary>The call's document. A given document that is not open throws FMC-DOC-NOT-FOUND and does not use the active document.</summary>
        public static Document Document(UIApplication app, bool mayOpen = false)
        {
            if (_cached != null && _cached.IsValidObject) return _cached;
            using (FmcTarget target = FmcTarget.Resolve(app, Parameters ?? new JObject(), mayOpen))
            {
                _cached = target.Doc;
                return _cached;
            }
        }
    }
}
