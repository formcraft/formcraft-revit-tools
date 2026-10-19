using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Windows.Media.Imaging;
using Autodesk.Revit.UI;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;
using revit_mcp_plugin.Core;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Shell
{
    /// <summary>
    /// The Formcraft tab (boards core/Ribbon and manage|flow|model|build/R_*): a Core panel (Pane, Connect AI, Log file),
    /// then one panel per licensed module with its parts switch and its two small buttons. Three tools per module, never
    /// more; everything else is in the pane and Ctrl+K. Revit has no checkbox in a split button, so the parts switch is a
    /// drop-down whose items toggle the part and show a tick.
    /// </summary>
    public static class RibbonBuilder
    {
        private static readonly FmcModule[] Modules = { FmcModule.Manage, FmcModule.Flow, FmcModule.Model, FmcModule.Build };

        // Settings › <module> › ribbon buttons: the options and the defaults (SettingsViewModel.Ribbon).
        public static readonly Dictionary<FmcModule, string[]> SmallOptions = new Dictionary<FmcModule, string[]>
        {
            [FmcModule.Manage] = new[] { "Run QA", "Raise issue", "Ready to issue", "Sync reminder" },
            [FmcModule.Flow] = new[] { "Touch on", "Section box", "Tag Tidy", "Align", "Mark" },
            [FmcModule.Model] = new[] { "Check system", "Quantities", "Diagram" },
            [FmcModule.Build] = new[] { "Workspace", "Web app" },
        };

        private static readonly Dictionary<string, string> Icon = new Dictionary<string, string>
        {
            ["Run QA"] = "qa", ["Raise issue"] = "issue", ["Ready to issue"] = "check", ["Sync reminder"] = "work",
            ["Touch on"] = "touch", ["Section box"] = "box", ["Tag Tidy"] = "check", ["Align"] = "pane", ["Mark"] = "issue",
            ["Check system"] = "check", ["Quantities"] = "qty", ["Diagram"] = "work", ["Workspace"] = "work", ["Web app"] = "web",
        };

        // Where each small button's action lives in the pane until the tool itself is built.
        private static readonly Dictionary<string, string> Section = new Dictionary<string, string>
        {
            ["Run QA"] = "QA", ["Raise issue"] = "Review", ["Ready to issue"] = "Issue", ["Sync reminder"] = "Workshare",
            ["Check system"] = "Systems", ["Diagram"] = "Systems", ["Quantities"] = "Build", ["Workspace"] = "Build", ["Web app"] = "Build",
        };

        private static readonly Dictionary<FmcModule, RibbonPanel> Panels = new Dictionary<FmcModule, RibbonPanel>();
        private static PushButton _connect;
        private static bool? _connectShown;

        private static string ConnectTip(bool on) =>
            (on ? "The AI connection is on: AI apps that speak MCP (Claude, ChatGPT, Copilot, a local model) on this PC can reach Revit. Click to switch it off."
                : "The AI connection is off. Click to switch it on, so AI apps that speak MCP (Claude, ChatGPT, Copilot, a local model) on this PC can reach Revit.")
            + " Settings (start with Revit, port): " + ConnectSettings.FilePath + ". Health check: the chip next to the pane title.";

        /// <summary>Shows the AI connection's state on the Connect AI button (called at idle; changes only when it changed).</summary>
        public static void ShowConnection(bool on)
        {
            if (_connect == null || _connectShown == on) return;
            _connectShown = on;
            int port = SocketService.Instance.Port;
            _connect.ItemText = on ? (port == ConnectSettings.DefaultPort ? "AI: on" : "AI: on · " + port) : "AI: off";
            _connect.ToolTip = ConnectTip(on) + (on ? " This Revit's port: " + port + "." : "");
        }
        private static readonly Dictionary<string, PushButton> PartButtons = new Dictionary<string, PushButton>();
        private static readonly Dictionary<(FmcModule, int), PushButton> SmallButtons = new Dictionary<(FmcModule, int), PushButton>();
        private static ShellViewModel _pane;
        private static IUserSettings _settings;
        private static ILicenceService _licence;

        public static void Create(UIControlledApplication app, ShellViewModel pane, IUserSettings settings, ILicenceService licence)
        {
            _pane = pane;
            _settings = settings;
            _licence = licence;
            string assembly = Assembly.GetExecutingAssembly().Location;
            try { app.CreateRibbonTab(FormcraftBrowser.TabName); }
            catch (Autodesk.Revit.Exceptions.ArgumentException) { /* made already by the Formcraft Browser or another Formcraft add-in */ }

            // Core: Pane, Connect AI, Log file (board core/Ribbon). Connect AI switches the AI connection on and off in
            // one click, for any AI app that speaks MCP, not one vendor; its label shows the state.
            var core = app.CreateRibbonPanel(FormcraftBrowser.TabName, "Core");
            core.AddItem(Button("FMC_Pane", "Formcraft\npane", typeof(TogglePaneCommand), "pane", "Shows or hides the Formcraft pane.", assembly, large: true));
            var stacked = core.AddStackedItems(
                Button("FMC_ConnectAI", "AI: off", typeof(ConnectAiCommand), "ai", ConnectTip(false), assembly),
                Button("FMC_LogFile", "Log file", typeof(LogFileCommand), "log", "Opens today's log for this PC: every action, dry run and refusal.", assembly));
            _connect = stacked[0] as PushButton;

            foreach (var m in Modules)
            {
                var panel = app.CreateRibbonPanel(FormcraftBrowser.TabName, m.ToString());
                Panels[m] = panel;
                var pulldown = (PulldownButton)panel.AddItem(new PulldownButtonData("FMC_" + m + "Parts", m + "\nparts")
                {
                    ToolTip = "Which parts of " + m + " show in the pane. Same list as Settings › " + m + " › parts in the pane.",
                    LargeImage = Png("parts", 32),
                    Image = Png("parts", 16),
                });
                foreach (var part in SectionRegistry.Default.Parts.Where(p => p.Module == m))
                {
                    var b = pulldown.AddPushButton(Button("FMC_Part_" + part.Id.Replace('.', '_'), part.Name, PartCommands.For(part.Id), "parts", "Shows or hides " + part.Name + " in the pane.", assembly));
                    PartButtons[part.Id] = b;
                }

                if (m == FmcModule.Build)
                {
                    // Board build/R_Build: Build parts, Workspace, Web app (fixed).
                    panel.AddStackedItems(
                        Button("FMC_BuildSmall1", "Workspace", SmallCommands.For(m, 1), "work", "Opens the Build workspace window.", assembly),
                        Button("FMC_BuildSmall2", "Web app", SmallCommands.For(m, 2), "web", "Opens the Build web app for outsiders.", assembly));
                }
                else
                {
                    panel.AddStackedItems(
                        Button("FMC_" + m + "Small1", Small(m, 1), SmallCommands.For(m, 1), Icon[Small(m, 1)], "Settings › " + m + " › Small button 1.", assembly),
                        Button("FMC_" + m + "Small2", Small(m, 2), SmallCommands.For(m, 2), Icon[Small(m, 2)], "Settings › " + m + " › Small button 2.", assembly));
                }
                foreach (var item in panel.GetItems().OfType<PushButton>())
                    if (item.Name.EndsWith("Small1")) SmallButtons[(m, 1)] = item;
                    else if (item.Name.EndsWith("Small2")) SmallButtons[(m, 2)] = item;
            }

            licence.Changed += (s, e) => Update();
            settings.Changed += (s, e) => Update();
            Update();
        }

        /// <summary>How often Update ran and how often it actually changed the ribbon (F-008 diagnostics, in the log at exit).</summary>
        public static int Updates { get; private set; }
        public static int RibbonChanges { get; private set; }

        /// <summary>
        /// Panels show only for licensed modules; part ticks and small-button labels follow the settings. Runs on every
        /// settings change (a keystroke in the pane saves one), so it writes to the ribbon only what differs: each write
        /// makes Revit re-lay the ribbon, and constant re-layouts swallowed clicks on the Formcraft tab (F-008).
        /// </summary>
        public static void Update()
        {
            Updates++;
            try
            {
                foreach (var m in Modules)
                {
                    bool show = _licence.Current.For(m).CanUse;
                    if (Panels.TryGetValue(m, out var panel) && panel.Visible != show) { panel.Visible = show; RibbonChanges++; }
                }
                foreach (var p in PartButtons)
                {
                    var text = (_settings.IsPartOn(p.Key) ? "✓ " : "    ") + SectionRegistry.Default.Part(p.Key).Name;
                    if (p.Value.ItemText != text) { p.Value.ItemText = text; RibbonChanges++; }
                }
                foreach (var b in SmallButtons)
                {
                    if (b.Key.Item1 == FmcModule.Build) continue;
                    var label = Small(b.Key.Item1, b.Key.Item2);
                    if (b.Value.ItemText == label) continue;
                    b.Value.ItemText = label;
                    b.Value.Image = Png(Icon[label], 16);
                    b.Value.LargeImage = Png(Icon[label], 32);
                    RibbonChanges++;
                }
            }
            catch (Exception) { /* cosmetic only */ }
        }

        /// <summary>The action on a small button, as chosen in Settings (defaults: the first two options).</summary>
        public static string Small(FmcModule m, int slot)
        {
            var options = SmallOptions[m];
            if (m == FmcModule.Build) return options[slot - 1];
            var saved = _settings?.Get("settings." + m.ToString().ToLowerInvariant() + ".small" + slot);
            return saved != null && options.Contains(saved) ? saved : options[slot - 1];
        }

        public static void TogglePart(string id) => _settings.SetPart(id, !_settings.IsPartOn(id));

        /// <summary>Runs a small button: opens the pane where its tool lives (each tool arrives with its section).</summary>
        public static void RunSmall(UIApplication app, FmcModule m, int slot)
        {
            var action = Small(m, slot);
            if (m == FmcModule.Flow && action == "Touch on")
            {
                ToggleTouch();
                return;
            }
            if (m == FmcModule.Flow)
            {
                // Already in Revit's API context: the tool runs now (asks first, one Undo).
                _pane.Status = action + ": " + Formcraft.Shell.ViewModels.ShellViewModel.FlowHint(action);
                FlowTools.Run(app, action);
                return;
            }
            ShellHost.ShowPane(app);
            if (Section.TryGetValue(action, out var name))
            {
                var section = _pane.Groups.SelectMany(g => g.Sections).FirstOrDefault(s => s.Name == name);
                if (section != null) _pane.SelectSectionCommand.Execute(section);
            }
            _pane.Status = action + ": from the ribbon. It runs here with a dry run first once its section is built.";
        }

        /// <summary>Flow › Touch on: the master switch for touch everywhere, as in Settings › Flow › Touch.</summary>
        private static void ToggleTouch()
        {
#if REVIT2025_OR_GREATER
            var touch = ShellHost.Touch;
            if (touch == null || !touch.TouchAvailable)
            {
                TaskDialog.Show("Formcraft Flow", "Touch didn't start on this PC. Open Settings › Flow › Touch in the pane for the touch probe.");
                return;
            }
            touch.SetMaster(!touch.MasterOn);
            _pane.Status = touch.MasterOn ? "Touch is on: fingers pan, zoom, orbit and select in views with touch on." : "Touch is off everywhere. Revit gets touch as usual.";
#else
            TaskDialog.Show("Formcraft Flow", "Touch runs in Revit 2025 and later.");
#endif
        }

        private static PushButtonData Button(string id, string text, Type command, string icon, string tip, string assembly, bool large = false) =>
            new PushButtonData(id, text, assembly, command.FullName)
            {
                ToolTip = tip,
                Image = Png(icon, 16),
                LargeImage = Png(icon, 32),
                AvailabilityClassName = typeof(AlwaysAvailable).FullName,
            };

        /// <summary>Ribbon icons from resources/icons/png (Revit's ribbon needs bitmaps), embedded in this assembly.</summary>
        public static BitmapImage Png(string name, int size)
        {
            try
            {
                var image = new BitmapImage();
                image.BeginInit();
                image.UriSource = new Uri("pack://application:,,,/RevitMCPPlugin;component/Ribbon/ribbon-" + name + "-" + size + ".png", UriKind.Absolute);
                image.CacheOption = BitmapCacheOption.OnLoad;
                image.EndInit();
                image.Freeze();
                return image;
            }
            catch (Exception)
            {
                return null;
            }
        }
    }
}
