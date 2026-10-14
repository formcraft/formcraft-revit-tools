using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Services
{
    /// <summary>
    /// What the fmc_ui MCP tool can read and do in the pane (U11): read its state, open a section or page, set the mock
    /// licence (test builds only) and save a picture of it. Nothing here touches the Revit model. Results are plain
    /// dictionaries and lists so the add-in can send them as JSON. Call on the pane's UI thread.
    /// </summary>
    public sealed class UiBridge
    {
        public static readonly string[] Presets = { "signed_out", "signed_in", "online", "offline", "grace_over" };

        private readonly ShellViewModel _pane;
        private readonly ILicenceService _licence;
        private readonly MockLicenceService? _mock;
        private readonly bool _allowMockLicence;
        private readonly Func<FrameworkElement?> _view;

        public UiBridge(ShellViewModel pane, ILicenceService licence, bool allowMockLicence, Func<FrameworkElement?> view)
        {
            _pane = pane;
            _licence = licence;
            _mock = licence as MockLicenceService;
            _allowMockLicence = allowMockLicence;
            _view = view;
        }

        /// <summary>Everything the pane shows that a test needs: screen, licence, where it is, dialog, banner, footer.</summary>
        public Dictionary<string, object?> GetState()
        {
            return new Dictionary<string, object?>
            {
                ["screen"] = _pane.Screen.ToString(),
                ["signed_in"] = _licence.Current.SignedIn,
                ["licence"] = LicenceOf(),
                ["page"] = _pane.IsMain ? _pane.Page.ToString() : null,
                ["group"] = _pane.IsMain && _pane.Page == ShellPage.Section ? _pane.CurrentGroup?.Name : null,
                ["section"] = _pane.IsMain && _pane.Page == ShellPage.Section ? _pane.Body?.Section.Name : null,
                ["section_locked"] = _pane.IsMain && _pane.Page == ShellPage.Section ? _pane.Body?.Locked : null,
                ["settings_tab"] = _pane.IsMain && _pane.SettingsOpen ? _pane.Settings.CurrentName : null,
                ["groups"] = _pane.Groups.Select(g => new Dictionary<string, object?>
                {
                    ["name"] = g.Name,
                    ["sections"] = g.Sections.Select(s => s.Name).ToList(),
                }).ToList(),
                ["dialog"] = _pane.Dialog == null ? null : new Dictionary<string, object?>
                {
                    ["title"] = _pane.Dialog.Title,
                    ["message"] = _pane.Dialog.Message,
                    ["primary"] = _pane.Dialog.PrimaryText,
                },
                ["banner"] = _pane.StateBanner == null ? null : new Dictionary<string, object?>
                {
                    ["state"] = _pane.StateBanner.State.ToString(),
                    ["says"] = _pane.StateBanner.Says,
                    ["still_works"] = _pane.StateBanner.StillWorks,
                    ["action"] = _pane.StateBanner.Action,
                },
                ["footer"] = new Dictionary<string, object?>
                {
                    ["status"] = _pane.Status,
                    ["actions"] = _pane.FooterActions.Select(a => a.Label).ToList(),
                },
                ["connection"] = _pane.ConnectionText,
                ["document"] = new Dictionary<string, object?>
                {
                    ["title"] = _pane.Document.Title,
                    ["state"] = _pane.Document.State.ToString(),
                },
                ["theme"] = ThemeService.Shared.Effective.ToString(),
            };
        }

        private Dictionary<string, object?> LicenceOf()
        {
            var l = _licence.Current;
            return new Dictionary<string, object?>
            {
                ["signed_in"] = l.SignedIn,
                ["account"] = l.Account == null ? null : l.Account.Name + " · " + l.Account.Role + (l.Account.IsAdmin ? " · admin" : ""),
                ["online"] = l.SignedIn && l.Online,
                ["offline"] = l.Offline,
                ["grace_over"] = l.GraceOver,
                ["offline_days_left"] = l.SignedIn ? l.OfflineDaysLeft : (int?)null,
                ["modules"] = l.Modules.ToDictionary(m => m.Module.ToString(), m => (object?)m.Status.ToString()),
            };
        }

        /// <summary>
        /// Opens a section by name ("Systems", or "Model › Systems"), a header page ("Connect", "Admin") or Settings
        /// with an optional tab ("Settings", "Settings › Flow"). Returns the state after; throws with the valid names.
        /// </summary>
        public Dictionary<string, object?> OpenSection(string target)
        {
            if (!_pane.IsMain)
                throw new InvalidOperationException("The pane shows " + _pane.Screen + ". Sign in and finish set-up first (or set_mock_licence signed_in).");
            var t = Normalise(target);
            if (t.Length == 0) throw new ArgumentException("Name a section, Connect, Settings or Admin.");

            if (Same(t, "Connect")) _pane.OpenConnectCommand.Execute(null);
            else if (Same(t, "Admin"))
            {
                if (!_pane.IsAdmin) throw new InvalidOperationException("Admin is only open to admins.");
                _pane.OpenAdminCommand.Execute(null);
            }
            else if (Same(t, "Settings") || t.StartsWith("Settings ›", StringComparison.OrdinalIgnoreCase))
            {
                var tab = t.Length > "Settings".Length ? t.Substring(t.IndexOf('›') + 1).Trim() : "";
                if (tab.Length > 0 && !_pane.Settings.TabNames.Any(n => Same(n, tab)))
                    throw new ArgumentException("No Settings tab \"" + tab + "\". Tabs: " + string.Join(", ", _pane.Settings.TabNames) + ".");
                if (!_pane.SettingsOpen) _pane.OpenSettingsCommand.Execute(null);
                if (tab.Length > 0) _pane.Settings.Open(_pane.Settings.TabNames.First(n => Same(n, tab)));
            }
            else
            {
                string? group = null, name = t;
                int split = t.IndexOf('›');
                if (split > 0) { group = t.Substring(0, split).Trim(); name = t.Substring(split + 1).Trim(); }
                var section = _pane.Groups.Where(g => group == null || Same(g.Name, group))
                                          .SelectMany(g => g.Sections).FirstOrDefault(s => Same(s.Name, name));
                if (section == null)
                    throw new ArgumentException("No section \"" + target + "\" in the pane (parts switched off or not licensed sections are hidden). Open: "
                                                + string.Join(", ", _pane.Groups.SelectMany(g => g.Sections.Select(s => g.Name + " › " + s.Name)))
                                                + "; or Connect, Settings, Settings › <tab>, Admin.");
                _pane.SelectSectionCommand.Execute(section);
            }
            return GetState();
        }

        /// <summary>Test builds only: puts the mock licence in a known state, and optionally sets module statuses.</summary>
        public Dictionary<string, object?> SetMockLicence(string preset, IDictionary<string, string>? modules = null)
        {
            if (!_allowMockLicence || _mock == null)
                throw new InvalidOperationException("set_mock_licence works in test mode only: a Debug build, FMC_UI_TEST=1 set before Revit starts, or the test PC's %APPDATA%\\Formcraft\\fmc_test.json naming this PC.");
            switch ((preset ?? "").Trim().ToLowerInvariant())
            {
                case "": break;
                case "signed_out": _mock.SignOutAsync().GetAwaiter().GetResult(); break;
                case "signed_in": _mock.SetSignedIn(); break;
                case "online": _mock.SetOnline(); break;
                case "offline": _mock.SetOffline(3, 11); break;
                case "grace_over": _mock.SetGraceOver(); break;
                default: throw new ArgumentException("Unknown preset \"" + preset + "\". Presets: " + string.Join(", ", Presets) + ".");
            }
            foreach (var kv in modules ?? new Dictionary<string, string>())
            {
                if (!Enum.TryParse<FmcModule>(kv.Key, true, out var module) || module == FmcModule.Core)
                    throw new ArgumentException("Unknown module \"" + kv.Key + "\". Modules: Manage, Flow, Model, Build.");
                if (!Enum.TryParse<ModuleStatus>(kv.Value, true, out var status))
                    throw new ArgumentException("Unknown status \"" + kv.Value + "\". Statuses: " + string.Join(", ", Enum.GetNames(typeof(ModuleStatus))) + ".");
                if (!_mock.Current.SignedIn) throw new InvalidOperationException("Sign in first (preset signed_in) to set modules.");
                _mock.SetModule(module, status, status == ModuleStatus.Trial ? DateTime.Today.AddDays(14) : status == ModuleStatus.Active ? new DateTime(DateTime.Today.Year, 12, 31) : (DateTime?)null);
            }
            return GetState();
        }

        /// <summary>Saves a PNG of the pane as it is now to <paramref name="folder"/> and returns its path.</summary>
        public string ScreenshotPane(string folder)
        {
            var view = _view();
            if (view == null || !view.IsVisible || view.ActualWidth < 1 || view.ActualHeight < 1)
                throw new InvalidOperationException("The pane isn't showing. Open it (Formcraft › Core › Formcraft pane) and open a model, then try again.");
            var dpi = VisualTreeHelper.GetDpi(view);
            var bitmap = new RenderTargetBitmap((int)Math.Ceiling(view.ActualWidth * dpi.DpiScaleX), (int)Math.Ceiling(view.ActualHeight * dpi.DpiScaleY),
                                                dpi.PixelsPerInchX, dpi.PixelsPerInchY, PixelFormats.Pbgra32);
            // Draw on the pane's background so a transparent root doesn't come out black.
            var visual = new DrawingVisual();
            using (var dc = visual.RenderOpen())
            {
                var background = view.TryFindResource("Fmc.SurfaceBrush") as Brush ?? Brushes.White;
                dc.DrawRectangle(background, null, new Rect(0, 0, view.ActualWidth, view.ActualHeight));
                dc.DrawRectangle(new VisualBrush(view) { Stretch = Stretch.None, AlignmentX = AlignmentX.Left, AlignmentY = AlignmentY.Top },
                                 null, new Rect(0, 0, view.ActualWidth, view.ActualHeight));
            }
            bitmap.Render(visual);
            Directory.CreateDirectory(folder);
            var path = Path.Combine(folder, "FMC_Pane_" + DateTime.Now.ToString("yyyyMMdd_HHmmss_fff") + ".png");
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(bitmap));
            using (var file = File.Create(path)) encoder.Save(file);
            return path;
        }

        private static string Normalise(string? s) => (s ?? "").Replace(">", "›").Replace("/", "›").Trim();
        private static bool Same(string a, string b) => string.Equals(a.Trim(), b.Trim(), StringComparison.OrdinalIgnoreCase);
    }
}
