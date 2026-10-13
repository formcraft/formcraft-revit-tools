using System;
using System.Runtime.ExceptionServices;
using System.Threading;
using System.Windows;

namespace Formcraft.Shell.Tests
{
    /// <summary>
    /// WPF objects need an STA thread; test runners use MTA threads. Run the WPF part here and return
    /// plain values, then assert on them in the test. One at a time: TUnit runs tests in parallel, and WPF's
    /// XAML loader is not safe to use from several threads at once (in Revit everything runs on one UI thread).
    /// </summary>
    internal static class Sta
    {
        private static readonly object Gate = new object();

        static Sta()
        {
            // Touching Application registers the pack://application: scheme the theme URIs use.
            _ = Application.Current;
        }

        public static T Run<T>(Func<T> work)
        {
            lock (Gate) return RunOnSta(work);
        }

        private static T RunOnSta<T>(Func<T> work)
        {
            T result = default!;
            Exception? failure = null;
            var thread = new Thread(() =>
            {
                try { result = work(); }
                catch (Exception ex) { failure = ex; }
            });
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            thread.Join();
            if (failure != null) ExceptionDispatchInfo.Capture(failure).Throw();
            return result;
        }
    }
}
