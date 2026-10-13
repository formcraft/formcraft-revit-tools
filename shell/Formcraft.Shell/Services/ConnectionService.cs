using System;

namespace Formcraft.Shell.Services
{
    /// <summary>The Revit/Claude service behind the header's Connected chip.</summary>
    public enum ConnectionState { Connected, NotConnected }

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
