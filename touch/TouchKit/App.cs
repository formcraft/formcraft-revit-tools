using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Windows;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using TouchKit.Core.Settings;
using TouchKit.Diagnostics;
using TouchKit.Input;
using TouchKit.Navigation;
using TouchKit.Takeover;
using TouchKit.UI;

namespace TouchKit
{
    /// <summary>One open view as the pane lists it in Settings › Flow › Touch.</summary>
    public sealed record TouchViewInfo(long Id, string Name, string Type, bool OnScreen, bool IsActive, bool On);

    /// <summary>
    /// Formcraft Flow's touch engine (formerly the TouchKit add-in, 0.2). The Formcraft add-in starts it from its own
    /// OnStartup; it has no ribbon or manifest of its own. The Flow ribbon panel and the pane's Settings › Flow › Touch
    /// drive it through the public members below.
    /// </summary>
    public sealed class App
    {
        public static App? Current { get; private set; }

        // Kept at its TouchKit 0.2 location so settings and per-view choices people already made carry over.
        internal static readonly string DataFolder =
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Formcraft", "TouchKit");

        internal IntPtr RevitWindow { get; private set; }
        internal PointerHook Hook { get; private set; } = null!;
        internal ProbeLog Log { get; } = new();
        internal ViewRegionTracker Views { get; } = new();
        internal TakeoverService Takeover { get; private set; } = null!;
        internal TouchRouter Router { get; private set; } = null!;

        /// <summary>The live settings (gestures, views, appearance). Change them with <see cref="ChangeSettings"/>.</summary>
        public TouchSettings Settings { get; private set; } = new();

        /// <summary>Raised on Revit's UI thread when the master switch, a view's switch, the open views or a setting change.</summary>
        public event Action? Changed;

        private JsonFileStore<TouchSettings> _settingsStore = null!;
        private SyntheticInput _input = null!;
        private NavigationController _navigation = null!;
        private RevitActionQueue _actions = null!;
        private ViewOverlayManager? _overlays;
        private string _revitVersion = "?";
        private string? _startupError;
        private IReadOnlyList<TouchViewInfo> _openViews = Array.Empty<TouchViewInfo>();
        private string _openViewsKey = "";

        /// <summary>Starts touch for this Revit session. Call once from the Formcraft add-in's OnStartup.</summary>
        public static App Start(UIControlledApplication application)
        {
            var app = new App();
            app.OnStartup(application);
            return app;
        }

        private void OnStartup(UIControlledApplication application)
        {
            Current = this;
            RevitWindow = application.MainWindowHandle;

            var app = application.ControlledApplication;
            _revitVersion = $"{app.VersionName} ({app.VersionNumber}, build {app.VersionBuild})";

            // Settings first: everything else reads them.
            _settingsStore = new JsonFileStore<TouchSettings>(Path.Combine(DataFolder, "settings.json"));
            Settings = _settingsStore.Load();

            // OnStartup runs on Revit's UI thread, which is exactly the thread the hook has to watch.
            Hook = new PointerHook(Views, Log.Add, RevitWindow);
            Hook.Install();

            try
            {
                Takeover = new TakeoverService(() => Settings, Path.Combine(DataFolder, "views.json"));
                _actions = new RevitActionQueue();
                _input = new SyntheticInput();
                _navigation = new NavigationController(_input, _actions, () => Settings);
                Router = new TouchRouter(_navigation, Takeover, () => Settings);
                Hook.Router = Router;

                _overlays = new ViewOverlayManager(RevitWindow, Views, Takeover, () => Settings, ToggleView);
                Router.Overlays = _overlays;
                Takeover.Changed += OnTakeoverChanged;
            }
            catch (Exception ex)
            {
                // Touch navigation failed to start; the probe still works for diagnosis.
                _startupError = ex.ToString();
                Hook.Router = null;
            }

            application.Idling += OnIdling;
            application.ViewActivated += OnViewActivated;
        }

        /// <summary>Call from the Formcraft add-in's OnShutdown.</summary>
        public void Stop(UIControlledApplication application)
        {
            application.Idling -= OnIdling;
            application.ViewActivated -= OnViewActivated;

            _overlays?.Dispose();
            Router?.Dispose();
            _input?.ReleaseAll();
            Hook?.Dispose();
            _settingsStore?.Save(Settings);
            Current = null;
        }

        // ---- what the pane and the ribbon use ---------------------------------------------------------

        /// <summary>True when touch navigation started; false means only the probe is available.</summary>
        public bool TouchAvailable => _startupError is null && Takeover is not null && Router is not null;

        /// <summary>The master switch: off makes Flow ignore touch everywhere.</summary>
        public bool MasterOn => TouchAvailable && Takeover.MasterOn;

        /// <summary>Views open in the active model: the ones on screen first, then background tabs.</summary>
        public IReadOnlyList<TouchViewInfo> OpenViews => _openViews;

        public void SetMaster(bool on)
        {
            if (!TouchAvailable) return;
            Takeover.SetMaster(on);
        }

        public void SetView(long viewId, bool on)
        {
            if (!TouchAvailable) return;
            if (Router.IsBusy) Router.Abort();
            Takeover.Set(viewId, on);
        }

        public void SetAllViews(bool on)
        {
            if (!TouchAvailable) return;
            if (Router.IsBusy) Router.Abort();
            foreach (var v in _openViews) Takeover.Set(v.Id, on);
        }

        /// <summary>Changes settings, applies them at once and saves them (there is no OK button anywhere).</summary>
        public void ChangeSettings(Action<TouchSettings> change)
        {
            change(Settings);
            OnSettingsChanged();
        }

        /// <summary>Every setting, including the advanced recognition ones, in a window of its own.</summary>
        public void ShowSettingsWindow() =>
            SettingsWindow.ShowSingleton(RevitWindow, () => Settings, ReplaceSettings, OnSettingsChanged);

        /// <summary>The touch probe: which touch and pen messages reach Revit, and a report for support.</summary>
        public void ShowProbe(UIApplication uiApp)
        {
            Views.Refresh(uiApp);
            ShowProbe();
        }

        /// <summary>The probe from the pane (no API context: view positions come from the last Idling refresh).</summary>
        public void ShowProbe() => ProbeWindow.ShowSingleton(RevitWindow, Hook, Log, Views, DescribeEnvironment);

        internal void ToggleView(ViewRegion region)
        {
            if (!TouchAvailable) return;
            if (Router.IsBusy) Router.Abort();
            Takeover.Toggle(region);
        }

        internal void ReplaceSettings(TouchSettings settings) => Settings = settings;

        internal void OnSettingsChanged()
        {
            Router?.ApplySettings();
            Takeover?.Refresh();
            _settingsStore.Save(Settings);
            Changed?.Invoke();
        }

        private void OnTakeoverChanged()
        {
            if (!Takeover.MasterOn && Router.IsBusy) Router.Abort();
            RebuildOpenViews(force: true);
        }

        // ---- Revit events ---------------------------------------------------------------------------

        private void OnIdling(object? sender, IdlingEventArgs e)
        {
            if (sender is not UIApplication uiApp) return;
            Views.RefreshIfDue(uiApp);
            Takeover?.UpdateProject(uiApp.ActiveUIDocument?.Document);
            RebuildOpenViews(force: false);
        }

        private void OnViewActivated(object? sender, ViewActivatedEventArgs e)
        {
            if (sender is not UIApplication uiApp) return;
            Views.Refresh(uiApp);
            Takeover?.UpdateProject(uiApp.ActiveUIDocument?.Document);
            RebuildOpenViews(force: false);
        }

        /// <summary>The pane's view list, from the tracker's snapshot: on screen first, then background tabs.</summary>
        private void RebuildOpenViews(bool force)
        {
            var list = Views.Regions.Select(r => new TouchViewInfo(
                    r.ViewId, r.ViewName, TypeName(r),
                    OnScreen: r.OnScreen,
                    IsActive: r.IsActive,
                    On: TouchAvailable && Takeover.IsOnIgnoringMaster(r)))
                .OrderByDescending(v => v.OnScreen).ThenByDescending(v => v.IsActive).ThenBy(v => v.Name)
                .ToList();
            string key = string.Join("|", list.Select(v => $"{v.Id}:{v.On}:{v.OnScreen}:{v.IsActive}:{v.Name}"));
            if (!force && key == _openViewsKey) return;
            _openViews = list;
            _openViewsKey = key;
            Changed?.Invoke();
        }

        private static string TypeName(ViewRegion r) => r.Kind switch
        {
            ViewKind.Model3D => "3D",
            ViewKind.Sheet => "Sheet",
            ViewKind.Schedule => "Schedule",
            _ => r.ViewType switch
            {
                Autodesk.Revit.DB.ViewType.FloorPlan or Autodesk.Revit.DB.ViewType.CeilingPlan or Autodesk.Revit.DB.ViewType.EngineeringPlan
                    or Autodesk.Revit.DB.ViewType.AreaPlan => "Plan",
                Autodesk.Revit.DB.ViewType.Section => "Section",
                Autodesk.Revit.DB.ViewType.Elevation => "Elevation",
                Autodesk.Revit.DB.ViewType.DraftingView => "Drafting",
                _ => r.ViewType.ToString(),
            },
        };

        // ---- diagnostics ----------------------------------------------------------------------------

        /// <summary>Everything we know about the machine that could explain touch behaviour.</summary>
        internal string DescribeEnvironment()
        {
            int digitizer = NativeMethods.GetSystemMetrics(NativeMethods.SM_DIGITIZER);
            int maxTouches = NativeMethods.GetSystemMetrics(NativeMethods.SM_MAXIMUMTOUCHES);

            var sb = new StringBuilder();
            sb.AppendLine($"Flow touch:      {Assembly.GetExecutingAssembly().GetName().Version}");
            sb.AppendLine($"Revit:           {_revitVersion}");
            sb.AppendLine($"Windows:         {Environment.OSVersion.VersionString}");
            sb.AppendLine($".NET runtime:    {Environment.Version}");
            sb.AppendLine($"Digitizer flags: 0x{digitizer:X2} ({DescribeDigitizer(digitizer)})");
            sb.AppendLine($"Max touches:     {maxTouches}");
            sb.AppendLine($"Revit window DPI:{NativeMethods.GetDpiForWindow(RevitWindow)} (96 = 100% scaling)");
            sb.AppendLine($"Primary screen:  {SystemParameters.PrimaryScreenWidth} x {SystemParameters.PrimaryScreenHeight} (device-independent px)");
            sb.AppendLine($"Virtual screen:  {SystemParameters.VirtualScreenWidth} x {SystemParameters.VirtualScreenHeight} at ({SystemParameters.VirtualScreenLeft},{SystemParameters.VirtualScreenTop})");
            if (NativeMethods.GetWindowRect(RevitWindow, out var r))
                sb.AppendLine($"Revit window:    [{r.Left},{r.Top} - {r.Right},{r.Bottom}] (physical px)");
            sb.AppendLine($"Hook:            {(Hook.IsInstalled ? $"installed, thread {Hook.ThreadId}" : $"FAILED, error {Hook.LastInstallError}")}");
            sb.AppendLine($"Probe blocking:  touch={Hook.BlockTouchInViews}, pen={Hook.BlockPenInViews}");
            sb.AppendLine($"Touch nav:       {(_startupError is null ? "running" : "FAILED TO START")}, master={(Takeover?.MasterOn.ToString() ?? "-")}");
            sb.AppendLine($"Project key:     {Takeover?.ProjectKey ?? "-"}");
            sb.AppendLine($"Gestures:        {Router?.GesturesHandled ?? 0} handled, last action: {_navigation?.LastAction}");
            sb.AppendLine($"Errors:          router={Router?.LastError ?? "none"}; revit actions={_actions?.LastError ?? "none"}; sendinput failures={_input?.FailedSends ?? 0}; views={Views.LastError ?? "none"}; settings={_settingsStore?.LastError ?? "none"}");
            sb.AppendLine($"Settings file:   {_settingsStore?.Path}");
            if (_startupError is not null) sb.AppendLine("Startup error:   " + _startupError);
            return sb.ToString().TrimEnd();
        }

        private static string DescribeDigitizer(int flags)
        {
            if (flags == 0) return "no touch/pen digitizer reported";
            var parts = new StringBuilder();
            if ((flags & 0x01) != 0) parts.Append("integrated-touch ");
            if ((flags & 0x02) != 0) parts.Append("external-touch ");
            if ((flags & 0x04) != 0) parts.Append("integrated-pen ");
            if ((flags & 0x08) != 0) parts.Append("external-pen ");
            if ((flags & 0x40) != 0) parts.Append("multi-input ");
            if ((flags & 0x80) != 0) parts.Append("ready ");
            return parts.ToString().Trim();
        }
    }
}
