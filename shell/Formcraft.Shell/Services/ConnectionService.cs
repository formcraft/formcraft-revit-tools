using System;

namespace Formcraft.Shell.Services
{
    /// <summary>The Revit/Claude service behind the header's Connected chip.</summary>
    /// <summary>Connected; not connected (start the Claude service); or Revit is busy and nothing new starts.</summary>
    public enum ConnectionState { Connected, NotConnected, RevitBusy }

    /// <summary>Whether the Formcraft service in Revit answers. Real checks arrive in U12 (Connect).</summary>
    public interface IConnectionService
    {
        ConnectionState State { get; }
        event EventHandler? Changed;
    }

    /// <summary>
    /// F09: works out the connection state from what the add-in knows, so Revit busy reaches the pane. "Busy" is a
    /// command running or waiting for Revit's API thread, or the bridge's timed-out job (BridgeBusy). It must last
    /// <see cref="Settle"/> before the pane shows it, so a quick read doesn't flash the banner; it clears at once.
    /// </summary>
    public sealed class BusyState
    {
        public static readonly TimeSpan Settle = TimeSpan.FromSeconds(1);
        private DateTime? _since;

        public ConnectionState Next(bool running, bool busy, DateTime nowUtc)
        {
            if (!running) { _since = null; return ConnectionState.NotConnected; }
            if (!busy) { _since = null; return ConnectionState.Connected; }
            _since ??= nowUtc;
            return nowUtc - _since.Value >= Settle ? ConnectionState.RevitBusy : ConnectionState.Connected;
        }
    }

    public sealed class MockConnectionService : IConnectionService
    {
        public ConnectionState State { get; private set; } = ConnectionState.Connected;
        public event EventHandler? Changed;

        public void Set(ConnectionState state)
        {
            State = state;
            Changed?.Invoke(this, EventArgs.Empty);
        }
    }
}
