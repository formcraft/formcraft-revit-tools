using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using revit_mcp_plugin.Core;

namespace revit_mcp_plugin.Fmc
{
    /// <summary>
    /// What the Formcraft pane needs from Revit outside its own view models: the Revit version, the open documents
    /// (pushed on Idling, for Setup › Templates), the Claude service switch, and opening the guard file and reports
    /// folder. (It was the separate "Formcraft Browser" pane before the add-in became one pane; its page now lives in
    /// the pane as Connect, Setup › Families and Setup › Templates.)
    /// </summary>
    public static class FormcraftBrowser
    {
        public const string Title = "Formcraft";
        public const string TabName = "Formcraft";

        /// <summary>The documents open in Revit changed (opened, closed, switched, saved, edited).</summary>
        public static event Action<IReadOnlyList<DocState>> DocumentsChanged;
        public static string RevitVersion { get; private set; } = "";
        /// <summary>The update and build, e.g. "2025.4 · build 25.4.0.32" (Connect's health check).</summary>
        public static string RevitBuild { get; private set; } = "";

        private static ExternalEvent _serviceEvent;
        private static List<DocState> _lastDocs = new List<DocState>();

        /// <summary>Called from OnStartup: Revit accepts pane registration and ExternalEvent.Create only there or in API context.</summary>
        public static void Register(UIControlledApplication application)
        {
            RevitVersion = application.ControlledApplication.VersionNumber;
#if REVIT2024_OR_GREATER
            RevitBuild = application.ControlledApplication.SubVersionNumber + " · build " + application.ControlledApplication.VersionBuild;
#else
            RevitBuild = RevitVersion + " · build " + application.ControlledApplication.VersionBuild;
#endif
            ServerCli.Locate();
            _serviceEvent = ExternalEvent.Create(new ToggleServiceHandler());

            application.Idling += OnIdling;
        }

        // ---- Revit state --------------------------------------------------------------------------------------------

        /// <summary>
        /// Idling runs in API context after every burst of work, so it catches opening, closing, switching, saving and
        /// edits without one handler per event. It pushes to the pane only when the snapshot changed.
        /// </summary>
        private static void OnIdling(object sender, IdlingEventArgs e)
        {
            if (!(sender is UIApplication uiApp)) return;
            Document active = uiApp.ActiveUIDocument?.Document;
            var docs = new List<DocState>();
            foreach (Document d in uiApp.Application.Documents)
            {
                if (d.IsLinked) continue;
                docs.Add(new DocState
                {
                    Title = d.Title,
                    Path = d.PathName ?? "",
                    IsFamily = d.IsFamilyDocument,
                    IsWorkshared = d.IsWorkshared,
                    IsModified = d.IsModified,
                    IsActive = active != null && d.Equals(active),
                });
            }
            if (docs.Count == _lastDocs.Count && docs.Zip(_lastDocs, (a, b) => a.SameAs(b)).All(x => x)) return;
            _lastDocs = docs;
            DocumentsChanged?.Invoke(docs);
        }

        public static void RequestToggleService() => _serviceEvent?.Raise();

        internal static void ToggleService(UIApplication app)
        {
            SocketService service = SocketService.Instance;
            if (service.IsRunning)
            {
                service.Stop();
            }
            else
            {
                service.Initialize(app);
                service.Start();
                if (!service.IsRunning)
                    TaskDialog.Show("Connect AI", "The AI connection couldn't start.\n\n" + service.LastError);
            }
        }

        internal static void OpenGuardFile()
        {
            string path = GuardStatus.DefaultConfigPath();
            if (File.Exists(path)) Launch("notepad.exe", "\"" + path + "\"");
        }

        internal static void OpenReports(GuardStatus guard)
        {
            string dir = GuardStatus.ExpandEnv(guard.ReportsDir);
            try { Directory.CreateDirectory(dir); } catch (Exception) { /* the folder dialog below says why */ }
            Launch("explorer.exe", "\"" + dir + "\"");
        }

        internal static void Launch(string exe, string args)
        {
            try { Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = true }); }
            catch (Exception ex) { TaskDialog.Show(Title, ex.Message); }
        }

        private sealed class ToggleServiceHandler : IExternalEventHandler
        {
            public void Execute(UIApplication app)
            {
                try { ToggleService(app); }
                catch (Exception ex) { TaskDialog.Show(Title, "The AI connection could not be switched: " + ex.Message); }
            }

            public string GetName() => "Formcraft: switch the AI connection on or off";
        }
    }

    // ---- Ribbon commands ------------------------------------------------------------------------------------------

    /// <summary>Keeps the Formcraft buttons usable with no document open (Revit greys out commands by default there).</summary>
    public class AlwaysAvailable : IExternalCommandAvailability
    {
        public bool IsCommandAvailable(UIApplication applicationData, CategorySet selectedCategories) => true;
    }
}
