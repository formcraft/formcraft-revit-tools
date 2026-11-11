using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Threading;

namespace revit_mcp_plugin.Core
{
    /// <summary>
    /// One localhost TCP listener for this Revit process. A restart closes that socket and waits for its accept
    /// thread before binding again, and an old accept thread cannot stop the listener that replaced it.
    /// No Revit types: the same class is unit-tested outside Revit.
    /// </summary>
    public sealed class PortLease
    {
        private readonly object _gate = new object();
        private readonly List<TcpClient> _clients = new List<TcpClient>();
        private TcpListener _listener;
        private Thread _thread;
        private Action<TcpClient> _onClient;
        private volatile bool _running;
        private int _generation;
        private int _bound;
        private int _lastBound;

        public int BindCount { get; private set; }
        public string LastError { get; private set; } = "";

        /// <summary>Fires when the accept loop for this generation dies on its own. A newer generation ignores it.</summary>
        public event Action<int, int, string> Stopped;

        public bool IsRunning
        {
            get { lock (_gate) return _running && ListenerAlive(); }
        }

        /// <summary>The port the current socket is bound to, or 0 when nothing is listening.</summary>
        public int BoundPort
        {
            get { lock (_gate) return _running && ListenerAlive() ? _bound : 0; }
        }

        public int Generation
        {
            get { lock (_gate) return _generation; }
        }

        /// <summary>Configured port first, then the port this process last held, then the rest of the range. Duplicates are dropped.</summary>
        public static int[] PortOrder(int configured, int lastBound, int range)
        {
            var order = new List<int>();
            Add(order, configured);
            Add(order, lastBound);
            if (range < 1) range = 1;
            for (int i = 0; i < range; i++) Add(order, configured + i);
            return order.ToArray();
        }

        private static void Add(List<int> order, int port)
        {
            if (port <= 0 || port > 65535) return;
            if (!order.Contains(port)) order.Add(port);
        }

        /// <summary>
        /// Start listening, or keep the socket already accepting. Never returns while a previous socket of this lease is still open.
        /// </summary>
        public bool Start(int configuredPort, int range, Action<TcpClient> onClient)
        {
            if (onClient == null) throw new ArgumentNullException(nameof(onClient));
            lock (_gate)
            {
                if (_running && ListenerAlive()) return true;
            }
            Stop();
            lock (_gate)
            {
                if (_running && ListenerAlive()) return true;
                _generation++;
                int generation = _generation;
                _onClient = onClient;
                LastError = "";
                foreach (int port in PortOrder(configuredPort, _lastBound, range))
                {
                    TcpListener listener;
                    if (!TryListen(port, out listener)) continue;
                    _listener = listener;
                    _bound = ((IPEndPoint)listener.LocalEndpoint).Port;
                    _lastBound = _bound;
                    _running = true;
                    BindCount++;
                    _thread = new Thread(() => AcceptLoop(generation, listener))
                    {
                        IsBackground = true,
                        Name = "Formcraft socket " + _bound
                    };
                    _thread.Start();
                    return true;
                }
                int last = configuredPort + Math.Max(range, 1) - 1;
                LastError = "Ports " + configuredPort + "-" + last + " are all in use.";
                _bound = 0;
                _running = false;
                return false;
            }
        }

        /// <summary>Close the listener and every accepted client, then wait until the accept thread has left Accept.</summary>
        public void Stop()
        {
            Thread thread;
            List<TcpClient> clients;
            lock (_gate)
            {
                _generation++;
                _running = false;
                _bound = 0;
                thread = _thread;
                _thread = null;
                try { if (_listener != null) _listener.Stop(); } catch (Exception) { /* already closed */ }
                _listener = null;
                clients = new List<TcpClient>(_clients);
                _clients.Clear();
            }
            foreach (TcpClient client in clients)
            {
                try { client.Close(); } catch (Exception) { /* already closed */ }
            }
            if (thread != null && thread.IsAlive && Thread.CurrentThread != thread) thread.Join(2000);
        }

        /// <summary>The handler finished with this client. Stop will not close it again.</summary>
        public void Forget(TcpClient client)
        {
            if (client == null) return;
            lock (_gate) _clients.Remove(client);
        }

        private void AcceptLoop(int generation, TcpListener listener)
        {
            string reason = "the listener stopped";
            try
            {
                while (true)
                {
                    lock (_gate)
                    {
                        if (!_running || generation != _generation || !ReferenceEquals(_listener, listener)) return;
                    }
                    TcpClient client;
                    try
                    {
                        client = listener.AcceptTcpClient();
                    }
                    catch (Exception ex)
                    {
                        // A client that connects and sends nothing, or aborts before Accept returns, can throw
                        // ConnectionReset. That is the accepted connection, not this listening socket. Stay on it.
                        lock (_gate)
                        {
                            if (!_running || generation != _generation || !ReferenceEquals(_listener, listener)) return;
                        }
                        if (ClientAborted(ex)) continue;
                        reason = ex.Message;
                        Thread.Sleep(200);
                        continue;
                    }
                    lock (_gate)
                    {
                        if (!_running || generation != _generation || !ReferenceEquals(_listener, listener))
                        {
                            try { client.Close(); } catch (Exception) { /* replaced */ }
                            return;
                        }
                        _clients.Add(client);
                    }
                    Action<TcpClient> handler = _onClient;
                    try { if (handler != null) handler(client); }
                    catch (Exception) { try { client.Close(); } catch (Exception) { /* handler failed */ } }
                }
            }
            catch (Exception ex)
            {
                reason = ex.Message;
            }
            finally
            {
                NoteLoopEnded(generation, listener, reason);
            }
        }

        /// <summary>Test hook: the accept thread for the current generation exits, as a dead socket would.</summary>
        public void SimulateAcceptLoopExit(string reason)
        {
            TcpListener listener;
            int generation;
            lock (_gate)
            {
                listener = _listener;
                generation = _generation;
            }
            NoteLoopEnded(generation, listener, reason);
        }

        /// <summary>The accept thread for <paramref name="generation"/> left. A newer Start is left alone.</summary>
        public void NoteLoopEnded(int generation, TcpListener listener, string reason)
        {
            int port;
            bool mine;
            lock (_gate)
            {
                mine = generation == _generation && ReferenceEquals(_listener, listener);
                port = _bound;
                if (!mine) return;
                _running = false;
                _bound = 0;
                try { _listener.Stop(); } catch (Exception) { /* already closed */ }
                _listener = null;
            }
            Action<int, int, string> stopped = Stopped;
            if (stopped != null) stopped(generation, port, string.IsNullOrEmpty(reason) ? "the listener stopped" : reason);
        }

        /// <summary>True when the exception is the other end aborting one connection. The listening socket is unchanged.</summary>
        private static bool ClientAborted(Exception ex)
        {
            SocketException socket = ex as SocketException;
            if (socket == null) socket = ex.InnerException as SocketException;
            if (socket == null) return false;
            return socket.SocketErrorCode == SocketError.ConnectionReset
                || socket.SocketErrorCode == SocketError.ConnectionAborted
                || socket.SocketErrorCode == SocketError.Interrupted
                || socket.ErrorCode == 10054
                || socket.ErrorCode == 10053;
        }

        private bool ListenerAlive()
        {
            try { return _listener != null && _listener.Server != null && _listener.Server.IsBound; }
            catch (Exception) { return false; }
        }

        private static bool TryListen(int port, out TcpListener listener)
        {
            listener = new TcpListener(IPAddress.Loopback, port);
            try
            {
                // Exclusive address use is the default on Windows and refuses the port while a previous socket from
                // this process is still in FIN_WAIT. Turn it off and allow reuse so a restart can take the same port.
                try { listener.Server.ExclusiveAddressUse = false; } catch (Exception) { /* not on this runtime */ }
                try { listener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true); } catch (Exception) { /* already bound options */ }
                listener.Start();
                return true;
            }
            catch (Exception)
            {
                try { listener.Stop(); } catch (Exception) { /* never started */ }
                listener = null;
                return false;
            }
        }
    }

    /// <summary>
    /// Publishes one generation's port. A write or delete from an older generation does nothing, so a restart cannot
    /// put the previous port back into the instance file after a newer socket has bound.
    /// </summary>
    public sealed class AnnounceGate
    {
        private readonly object _gate = new object();
        private int _generation;

        public int Port { get; private set; }

        public bool Publish(int generation, int port, Action write)
        {
            if (write == null) throw new ArgumentNullException(nameof(write));
            lock (_gate)
            {
                if (generation <= 0 || port <= 0) return false;
                if (generation < _generation) return false;
                _generation = generation;
                Port = port;
                write();
                return true;
            }
        }

        /// <summary>Removes the publication for this generation. An older generation cannot remove a newer one.</summary>
        public bool Retire(int generation, Action remove)
        {
            if (remove == null) throw new ArgumentNullException(nameof(remove));
            lock (_gate)
            {
                if (_generation != 0 && generation != _generation) return false;
                _generation = 0;
                Port = 0;
                remove();
                return true;
            }
        }

        /// <summary>Drops whatever is published. Used when this process is not listening.</summary>
        public void Clear(Action remove)
        {
            if (remove == null) throw new ArgumentNullException(nameof(remove));
            lock (_gate)
            {
                _generation = 0;
                Port = 0;
                remove();
            }
        }
    }
}
