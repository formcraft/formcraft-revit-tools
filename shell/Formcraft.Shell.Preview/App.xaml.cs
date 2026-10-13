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

                var main = new MainWindow { ShowActivated = false, Left = -20000, Top = -20000 };
                main.Show();
                Render((FrameworkElement)main.Content, Path.Combine(folder, $"pane-{name}-signin.png"));
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
                dc.DrawRectangle(new VisualBrush(element), null, new Rect(0, 0, element.ActualWidth, element.ActualHeight));
            }
            bitmap.Render(host);
            var png = new PngBitmapEncoder();
            png.Frames.Add(BitmapFrame.Create(bitmap));
            using var file = File.Create(path);
            png.Save(file);
        }
    }
}
