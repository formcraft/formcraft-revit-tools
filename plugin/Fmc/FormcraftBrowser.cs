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
using revit_mcp_plugin.UI;

namespace revit_mcp_plugin.Fmc
{
    /// <summary>
    /// The working Connect page of the Formcraft pane: Claude service, health, probe, families, files, activity and guard
    /// (it was the separate "Formcraft Browser" pane and "Claude" panel before the add-in became one pane). The page only
    /// reads Revit state; everything it changes goes through the server's own tool code (ServerCli), so the page and
    /// Claude can never disagree about what is allowed.
    /// </summary>
    public static class FormcraftBrowser
    {
        public const string Title = "Formcraft";
        public const string TabName = "Formcraft";

        public static FormcraftBrowserPage Page { get; private set; }
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
#if REVIT2024_OR_GREATER
            Theme.SetDark(UIThemeManager.CurrentTheme == UITheme.Dark);
            application.ThemeChanged += (s, e) =>
            {
                Theme.SetDark(UIThemeManager.CurrentTheme == UITheme.Dark);
                UpdateRibbon();
            };
#endif
            ServerCli.Locate();
            Page = new FormcraftBrowserPage();
            _serviceEvent = ExternalEvent.Create(new ToggleServiceHandler());

            application.Idling += OnIdling;
        }

        /// <summary>The Claude service button on the Core panel shows whether the service is on.</summary>
        public static void UpdateRibbon() => Shell.RibbonBuilder.UpdateService();

        // ---- Revit state --------------------------------------------------------------------------------------------

        /// <summary>
        /// Idling runs in API context after every burst of work, so it catches opening, closing, switching, saving and
        /// edits without one handler per event. It pushes to the pane only when the snapshot changed.
        /// </summary>
        private static void OnIdling(object sender, IdlingEventArgs e)
        {
            if (!(sender is UIApplication uiApp) || Page == null) return;
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
            Page.SetDocuments(docs);
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
            }
            UpdateRibbon();
            Page?.Refresh();
        }

        /// <summary>Opens Connect in the Formcraft pane, on one of its tabs (files, activity, guard) if given.</summary>
        public static void ShowPane(UIApplication app, string tab = null)
        {
            Shell.ShellHost.ShowConnect(app);
            if (tab != null) Page?.ShowTab(tab);
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
                catch (Exception ex) { TaskDialog.Show(Title, "The Claude service could not be switched: " + ex.Message); }
            }

            public string GetName() => "Formcraft Browser: start or stop the Claude service";
        }
    }

    // ---- Ribbon commands ------------------------------------------------------------------------------------------

    /// <summary>Starts or stops listening on port 8080 (the plugin's socket service), without dialogs.</summary>
    [Transaction(TransactionMode.Manual)]
    public class ToggleClaudeService : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            try
            {
                FormcraftBrowser.ToggleService(commandData.Application);
                return Result.Succeeded;
            }
            catch (Exception ex)
            {
                message = ex.Message;
                return Result.Failed;
            }
        }
    }

    /// <summary>Keeps the Formcraft buttons usable with no document open (Revit greys out commands by default there).</summary>
    public class AlwaysAvailable : IExternalCommandAvailability
    {
        public bool IsCommandAvailable(UIApplication applicationData, CategorySet selectedCategories) => true;
    }
}
