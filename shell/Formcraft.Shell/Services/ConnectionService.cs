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
