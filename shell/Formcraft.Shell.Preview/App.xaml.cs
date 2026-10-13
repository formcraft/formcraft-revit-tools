using System;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.Preview
{
    public partial class App : Application
    {
        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);

            // dotnet run --project shell/Formcraft.Shell.Preview -- --snapshot <folder>
            // Saves the kit gallery and the pane, light and dark, at 440 and 360 px, then exits.
            if (e.Args.Length >= 1 && e.Args[0] == "--snapshot")
            {
                var folder = e.Args.Length >= 2 ? e.Args[1] : Path.Combine(Environment.CurrentDirectory, "snapshots");
                ShutdownMode = ShutdownMode.OnExplicitShutdown;
                Dispatcher.BeginInvoke(new Action(() =>
                {
                    try { Snapshots.Save(folder); }
                    catch (Exception ex) { Console.Error.WriteLine(ex); }
                    Shutdown();
                }), DispatcherPriority.ApplicationIdle);
                return;
            }

            new MainWindow().Show();
        }
    }

    internal static class Snapshots
    {
        public static void Save(string folder)
        {
            Directory.CreateDirectory(folder);
            foreach (var theme in new[] { ThemeChoice.Light, ThemeChoice.Dark })
            {
                ThemeService.Shared.Choice = theme;
                var name = theme.ToString().ToLowerInvariant();

                var gallery = new KitGalleryWindow { ShowActivated = false, Left = -20000, Top = -20000 };
                gallery.Show();
                var vm = (KitGalleryViewModel)gallery.DataContext;
                foreach (var width in new[] { 440.0, 360.0 })
                {
                    vm.PaneWidth = width;
                    Render(gallery.Pane, Path.Combine(folder, $"kit-{name}-{width}.png"));
                }
                vm.PaneWidth = 440;
                vm.DialogOpen = true;
                Render((FrameworkElement)gallery.Content, Path.Combine(folder, $"kit-{name}-dialog.png"));
                gallery.Close();

                var main = new MainWindow(new PreviewServices(new InMemoryUserSettings())) { ShowActivated = false, Left = -20000, Top = -20000, Width = 640, Height = 900 };
                main.Show();
                Render((FrameworkElement)main.Content, Path.Combine(folder, $"pane-{name}-signin.png"));

                // The main pane at the board widths, in each document state (boards: gen_panes.py pane(), core/ResponsivePane)
                main.Services.SignInToMainPane();
                foreach (var (doc, label) in new[] { (MockDocumentContext.LiveProject, "live"), (MockDocumentContext.SharedModel, "shared"), (MockDocumentContext.NewModel, "setup") })
                {
                    main.Services.OpenDocument = doc;
                    foreach (var width in new[] { 440.0, 360.0 })
                    {
                        main.Shell.Width = width;
                        Render(main.Shell, Path.Combine(folder, $"pane-{name}-{label}-{width}.png"));
                    }
                }
                // Search (U04): the board's three sample searches, and one that finds nothing
                foreach (var query in new[] { "sheet", "qa", "level", "roof" })
                {
                    main.Services.Pane.Search.Query = query;
                    foreach (var width in new[] { 440.0, 360.0 })
                    {
                        main.Shell.Width = width;
                        Render(main.Shell, Path.Combine(folder, $"pane-{name}-search-{query}-{width}.png"));
                    }
                }
                main.Services.Pane.Search.Close();

                // Parts switches (U03): Drawings and Touch off; then the Settings page with its switches
                main.Services.Settings.SetPart("manage.drawings", false);
                main.Services.Settings.SetPart("flow.touch", false);
                main.Shell.Width = 440;
                Render(main.Shell, Path.Combine(folder, $"pane-{name}-parts-off-440.png"));
                main.Services.Pane.OpenSettingsCommand.Execute(null);
                Render(main.Shell, Path.Combine(folder, $"pane-{name}-settings-440.png"));
                main.Services.Pane.OpenSettingsCommand.Execute(null);
                main.Services.Settings.SetPart("manage.drawings", true);
                main.Services.Settings.SetPart("flow.touch", true);

                main.Services.Pane.Account.ReleaseSeatCommand.Execute(null);
                main.Shell.Width = 440;
                Render(main.Shell, Path.Combine(folder, $"pane-{name}-dialog.png"));
                main.Close();
            }
            Console.WriteLine("Snapshots saved to " + folder);
        }

        private static void Render(FrameworkElement element, string path)
        {
            element.Dispatcher.Invoke(() => { }, DispatcherPriority.ApplicationIdle);
            element.UpdateLayout();
            var dpi = VisualTreeHelper.GetDpi(element);
            var bitmap = new RenderTargetBitmap(
                (int)Math.Ceiling(element.ActualWidth * dpi.DpiScaleX), (int)Math.Ceiling(element.ActualHeight * dpi.DpiScaleY),
                dpi.PixelsPerInchX, dpi.PixelsPerInchY, PixelFormats.Pbgra32);
            var host = new DrawingVisual();
            using (var dc = host.RenderOpen())
            {
                // True size from the top-left; anything wider than the element is clipped, not squeezed in.
                var brush = new VisualBrush(element)
                {
                    Stretch = Stretch.None,
                    AlignmentX = AlignmentX.Left,
                    AlignmentY = AlignmentY.Top,
                    ViewboxUnits = BrushMappingMode.Absolute,
                    Viewbox = new Rect(VisualTreeHelper.GetOffset(element).X, VisualTreeHelper.GetOffset(element).Y, element.ActualWidth, element.ActualHeight),
                };
                dc.DrawRectangle(brush, null, new Rect(0, 0, element.ActualWidth, element.ActualHeight));
            }
            bitmap.Render(host);
            var png = new PngBitmapEncoder();
            png.Frames.Add(BitmapFrame.Create(bitmap));
            using var file = File.Create(path);
            png.Save(file);
        }
    }
}
