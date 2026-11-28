using System;
using System.Collections.Generic;

namespace revit_mcp_plugin.Core
{
    /// <summary>What ExternalEvent.Raise returns. Pending means Revit already has a raise and will not run a second one.</summary>
    public enum RaiseResult { Accepted, Pending, Denied }

    /**
     * One Revit API thread. A raise that comes back Pending stays at the head of the queue.
     * It is not dropped and it is not replaced by the next request (the classic lost ExternalEvent).
     */
    public sealed class RevitCallGate
    {
        private readonly object _gate = new object();
        private readonly Queue<Item> _wait = new Queue<Item>();
        private bool _busy;
        public int Accepted { get; private set; }
        public int KeptPending { get; private set; }
        public int Dropped => 0;

        public void Submit(string id, Func<RaiseResult> raise)
        {
            if (raise == null) throw new ArgumentNullException(nameof(raise));
            lock (_gate)
            {
                _wait.Enqueue(new Item { Id = id, Raise = raise });
                Pump();
            }
        }

        /// <summary>The in-flight external event finished. Raise the request that was waiting, if any.</summary>
        public void Completed()
        {
            lock (_gate)
            {
                _busy = false;
                Pump();
            }
        }

        /// <summary>Try again after Raise returned Pending. The same request is still at the head.</summary>
        public void Kick()
        {
            lock (_gate) Pump();
        }

        public int Waiting { get { lock (_gate) return _wait.Count; } }

        private void Pump()
        {
            if (_busy || _wait.Count == 0) return;
            Item item = _wait.Peek();
            RaiseResult result = item.Raise();
            if (result == RaiseResult.Pending) { KeptPending++; return; }
            if (result == RaiseResult.Denied) return;
            _wait.Dequeue();
            _busy = true;
            Accepted++;
        }

        private sealed class Item
        {
            public string Id;
            public Func<RaiseResult> Raise;
        }
    }
}
