using RvtApp = Autodesk.Revit.ApplicationServices.Application;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Revit's shared parameter file is the person's setting (F-037). A tool that needs the kit's file switches to it with
    /// Use(...) and the person's file comes back when the scope ends, in a finally. The person's value is taken once, before
    /// the first switch; if putting it back fails (or a scope is left open by a hang), the next Formcraft call puts it back
    /// before doing anything else, and never mistakes the kit's file for the person's.
    /// All calls run on Revit's main thread (external events), so there is no locking.
    /// </summary>
    public static class FmcSharedParams
    {
        private static string _person;
        private static int _depth;
        private static bool _pending;
        private static string _lastError = "";

        /// <summary>Switches to the kit's file until the returned scope is disposed. An empty kit file changes nothing.</summary>
        public static IDisposable Use(RvtApp app, string kitFile)
        {
            if (string.IsNullOrEmpty(kitFile)) return new Scope(null);
            if (_depth == 0 && !_pending) _person = app.SharedParametersFilename ?? "";
            _depth++;
            try { app.SharedParametersFilename = kitFile; }
            catch (Exception)
            {
                _depth--;
                if (_depth == 0) Restore(app);
                throw;
            }
            return new Scope(app);
        }

        /// <summary>Puts the person's file back if an earlier restore didn't (call at the start and end of every handler run).</summary>
        public static void RestoreIfPending(RvtApp app)
        {
            if (_pending && _depth == 0) Restore(app);
        }

        /// <summary>For results: whether Revit points at the person's file again.</summary>
        public static JObject Status(RvtApp app)
        {
            string now = "";
            try { now = app.SharedParametersFilename ?? ""; } catch (Exception) { /* unreadable */ }
            var o = new JObject { ["restored"] = !_pending && _depth == 0, ["person_file"] = _person ?? now, ["revit_now"] = now };
            if (_pending && _lastError.Length > 0) o["error"] = _lastError;
            return o;
        }

        private static void Restore(RvtApp app)
        {
            try
            {
                app.SharedParametersFilename = _person ?? "";
                _pending = !string.Equals(app.SharedParametersFilename ?? "", _person ?? "", StringComparison.OrdinalIgnoreCase);
                _lastError = _pending ? "Revit kept " + app.SharedParametersFilename : "";
            }
            catch (Exception e)
            {
                _pending = true;
                _lastError = e.Message;
            }
        }

        private sealed class Scope : IDisposable
        {
            private RvtApp _app;
            public Scope(RvtApp app) { _app = app; }
            public void Dispose()
            {
                if (_app == null) return;
                RvtApp app = _app;
                _app = null;
                _depth = Math.Max(0, _depth - 1);
                if (_depth == 0) Restore(app);
            }
        }
    }
}
