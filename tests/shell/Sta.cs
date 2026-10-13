using System;
using System.Runtime.ExceptionServices;
using System.Threading;
using System.Windows;

namespace Formcraft.Shell.Tests
{
    /// <summary>WPF objects need an STA thread; xUnit runs tests on MTA threads.</summary>
    internal static class Sta
    {
        static Sta()
        {
            // Touching Application registers the pack://application: scheme the theme URIs use.
            _ = Application.Current;
        }

        public static void Run(Action test)
        {
            Exception? failure = null;
            var thread = new Thread(() =>
            {
                try { test(); }
                catch (Exception ex) { failure = ex; }
            });
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            thread.Join();
            if (failure != null) ExceptionDispatchInfo.Capture(failure).Throw();
        }
    }
}
