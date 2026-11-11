using System.Net;
using System.Net.Sockets;
using Xunit;
using revit_mcp_plugin.Core;
using RevitMCPCommandSet.Services.Fmc;

namespace PortLeaseTests;

public class PortLeaseTests
{
    private static int FreePort()
    {
        var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        int port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        return port;
    }

    [Fact]
    public void PortOrderPrefersTheConfiguredPortThenTheLastOne()
    {
        Assert.Equal(new[] { 8080, 8081, 8082 }, PortLease.PortOrder(8080, 8081, 3));
        Assert.Equal(new[] { 8080, 8081 }, PortLease.PortOrder(8080, 8080, 2));
        Assert.Equal(new[] { 8080 }, PortLease.PortOrder(8080, 0, 1));
    }

    [Fact]
    public void RestartReusesTheSamePortAndDoesNotKeepTheOldListener()
    {
        int port = FreePort();
        var lease = new PortLease();
        Assert.True(lease.Start(port, 4, _ => { }));
        int bound = lease.BoundPort;
        Assert.Equal(port, bound);
        Assert.Equal(1, lease.BindCount);

        Assert.True(lease.Start(port, 4, _ => { }));
        Assert.Equal(1, lease.BindCount);
        Assert.Equal(bound, lease.BoundPort);

        lease.Stop();
        Assert.False(lease.IsRunning);
        Assert.Equal(0, lease.BoundPort);

        Assert.True(lease.Start(port, 4, _ => { }));
        Assert.Equal(bound, lease.BoundPort);
        Assert.Equal(2, lease.BindCount);
        lease.Stop();
    }

    [Fact]
    public void APortHeldBySomeoneElseIsSkippedAndTheBoundPortIsTheOneThatAnswered()
    {
        int configured = FreePort();
        var blocker = new TcpListener(IPAddress.Loopback, configured);
        blocker.Start();
        try
        {
            var lease = new PortLease();
            Assert.True(lease.Start(configured, 6, _ => { }));
            Assert.NotEqual(configured, lease.BoundPort);
            Assert.InRange(lease.BoundPort, configured + 1, configured + 5);
            lease.Stop();
        }
        finally
        {
            blocker.Stop();
        }

        var again = new PortLease();
        Assert.True(again.Start(configured, 6, _ => { }));
        Assert.Equal(configured, again.BoundPort);
        again.Stop();
    }

    [Fact]
    public void AnOldAcceptLoopCannotStopTheReplacementListener()
    {
        int port = FreePort();
        var lease = new PortLease();
        int retired = 0;
        lease.Stopped += (_, _, _) => Interlocked.Increment(ref retired);
        Assert.True(lease.Start(port, 2, _ => { }));
        int first = lease.Generation;

        lease.Stop();
        Assert.True(lease.Start(port, 2, _ => { }));
        Assert.NotEqual(first, lease.Generation);
        lease.NoteLoopEnded(first, null, "the listener stopped");
        Assert.True(lease.IsRunning);
        Assert.Equal(port, lease.BoundPort);
        Assert.Equal(0, retired);

        using var client = new TcpClient();
        client.Connect(IPAddress.Loopback, port);
        Assert.True(client.Connected);
        lease.Stop();
    }

    [Fact]
    public void TheAcceptLoopDyingRetiresOnlyItsOwnGeneration()
    {
        int port = FreePort();
        var lease = new PortLease();
        int retiredPort = -1;
        lease.Stopped += (_, stoppedPort, _) => retiredPort = stoppedPort;
        Assert.True(lease.Start(port, 2, _ => { }));
        lease.SimulateAcceptLoopExit("the listener stopped");
        Assert.False(lease.IsRunning);
        Assert.Equal(0, lease.BoundPort);
        Assert.Equal(port, retiredPort);
        Assert.True(lease.Start(port, 2, _ => { }));
        Assert.Equal(port, lease.BoundPort);
        lease.Stop();
    }

    [Fact]
    public void StopClosesAcceptedClients()
    {
        int port = FreePort();
        var lease = new PortLease();
        var seen = new ManualResetEventSlim(false);
        Assert.True(lease.Start(port, 2, _ => seen.Set()));
        using var client = new TcpClient();
        client.Connect(IPAddress.Loopback, lease.BoundPort);
        Assert.True(seen.Wait(2000));
        lease.Stop();
        var buffer = new byte[1];
        using var stream = client.GetStream();
        stream.ReadTimeout = 500;
        try
        {
            int n = stream.Read(buffer, 0, 1);
            Assert.Equal(0, n);
        }
        catch (IOException)
        {
            Assert.True(true);
        }
    }

    [Fact]
    public void AStalePublishCannotOverwriteOrDeleteANewerPort()
    {
        var gate = new AnnounceGate();
        var log = new List<int>();
        Assert.True(gate.Publish(1, 8080, () => log.Add(8080)));
        Assert.True(gate.Publish(2, 8081, () => log.Add(8081)));
        Assert.False(gate.Publish(1, 8080, () => log.Add(8080)));
        Assert.Equal(8081, gate.Port);
        Assert.False(gate.Retire(1, () => log.Add(-1)));
        Assert.Equal(8081, gate.Port);
        Assert.Equal(new[] { 8080, 8081 }, log);
        Assert.True(gate.Retire(2, () => log.Add(0)));
        Assert.Equal(0, gate.Port);
        Assert.Equal(new[] { 8080, 8081, 0 }, log);
    }

    [Fact]
    public void EmptyConnectionsLeaveTheSameListenerUp()
    {
        int port = FreePort();
        var lease = new PortLease();
        int accepted = 0;
        Assert.True(lease.Start(port, 4, client =>
        {
            Interlocked.Increment(ref accepted);
            try { client.Close(); } catch (Exception) { /* the probe already went */ }
        }));

        for (int i = 0; i < 6; i++)
        {
            using var probe = new TcpClient();
            probe.Connect(IPAddress.Loopback, port);
            probe.Close();
        }
        var until = DateTime.UtcNow.AddSeconds(3);
        while (Volatile.Read(ref accepted) < 6 && DateTime.UtcNow < until) Thread.Sleep(20);

        Assert.Equal(6, Volatile.Read(ref accepted));
        Assert.Equal(1, lease.BindCount);
        Assert.True(lease.IsRunning);
        Assert.Equal(port, lease.BoundPort);

        using (var again = new TcpClient())
        {
            again.Connect(IPAddress.Loopback, port);
            Assert.True(again.Connected);
        }
        Assert.Equal(1, lease.BindCount);
        Assert.Equal(port, lease.BoundPort);
        lease.Stop();
        Assert.False(lease.IsRunning);
        Assert.Equal(0, lease.BoundPort);
    }

    [Fact]
    public void APendingExternalEventDoesNotDropTheNextRequest()
    {
        var gate = new RevitCallGate();
        var raised = new List<string>();
        var pendingOnce = true;
        void Submit(string id) => gate.Submit(id, () =>
        {
            if (id == "b" && pendingOnce) { pendingOnce = false; return RaiseResult.Pending; }
            raised.Add(id);
            return RaiseResult.Accepted;
        });
        Submit("a");
        Submit("b");
        Submit("c");
        Assert.Equal(new[] { "a" }, raised);
        Assert.Equal(0, gate.Dropped);
        gate.Completed();
        Assert.Equal(1, gate.KeptPending);
        Assert.Equal(new[] { "a" }, raised);
        gate.Kick();
        Assert.Equal(new[] { "a", "b" }, raised);
        gate.Completed();
        Assert.Equal(new[] { "a", "b", "c" }, raised);
        Assert.Equal(3, gate.Accepted);
        Assert.Equal(0, gate.Dropped);
    }

    [Fact]
    public void FiveOpenDocumentsRequireAName()
    {
        var docs = new[] { "Architecture", "Structure", "Electrical", "Plumbing", "Site" };
        var error = Assert.Throws<InvalidOperationException>(() => DocumentChoice.RequireNamed("", docs));
        Assert.Contains("Refusing to use the active document", error.Message);
        DocumentChoice.RequireNamed("Structure", docs);
        DocumentChoice.RequireNamed("", new[] { "Only one" });
    }
}
