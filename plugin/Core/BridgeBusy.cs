using System;
using System.Collections.Generic;
using System.Reflection;
using System.Threading;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace revit_mcp_plugin.Core
{
    /// <summary>
    /// F-072 (issue #248): a command whose wait ran out while its work still runs on Revit's API thread. The command's
    /// wait gives up (300 s for fmc_doc_flex), but Revit can't stop an external event once it started, so the work goes on;
    /// before this, every later call queued behind it and "timed out" too (close, host test, inspect, open: 18 minutes of
    /// false timeouts in run TR-20261019-1635).
    /// <para>Now the bridge is marked busy (the command, when it started, its job id) and every new call is answered at once
    /// with <see cref="Tag"/> instead of queuing silently; the server and the test runner wait while the busy job's
    /// heartbeats are fresh. Calls that don't need Revit's API thread (the self-test's facts, a cached fmc_document_info)
    /// are still served.</para>
    /// <para>When busy is set, a small external event (the probe) is raised. Revit runs external events one at a time on
    /// its API thread, so the probe runs once that thread is free again. If the timed-out handler hadn't even started yet
    /// (its completion signal isn't set), the probe raises itself again. Then the busy job's own record is closed: its
    /// "finished" line and its real result (read from the handler) go to FMC_Jobs_Revit.jsonl and FMC_LateResults.jsonl,
    /// and the bridge is free.</para>
    /// </summary>
    public static class BridgeBusy
    {
        public const string Tag = "[FMC-BRIDGE-BUSY]";

        private sealed class State
        {
            public string Command = "";
            public string Job = "";
            public DateTime Started;
            public DateTime GaveUp;
            public RevitJobLog Log;
            public object CommandObject;
            public IDisposable Wake;
            /// <summary>When the probe first found the timed-out work not started yet (it then looks again, for a while).</summary>
            public DateTime? NotStartedSince;
        }

        private static readonly object Gate = new object();
        private static State _state;
        private static ExternalEvent _probe;

        /// <summary>Call on Revit's API thread (the socket service's Initialize): the probe's external event.</summary>
        public static void Initialize()
        {
            if (_probe != null) return;
            try { _probe = ExternalEvent.Create(new ProbeHandler()); }
            catch (Exception) { _probe = null; /* without the probe a timeout stays a timeout, as before */ }
        }

        public static bool IsBusy { get { lock (Gate) return _state != null; } }

        /// <summary>The refusal for a new call while busy; false when the bridge is free.</summary>
        public static bool Refusal(out string message)
        {
            lock (Gate)
            {
                message = _state == null ? "" : Words(_state);
                return _state != null;
            }
        }

        private static string Words(State s) =>
            $"{Tag} Revit is still running {s.Command} since {s.Started.ToLocalTime():yyyy-MM-dd HH:mm:ss} (job {s.Job}): " +
            $"its wait ended after {Math.Round((s.GaveUp - s.Started).TotalSeconds)} s, but the work goes on on Revit's API thread. " +
            $"Send this again once it has finished (fmc_job status {s.Job} follows it).";

        /// <summary>What the self-test's facts say about the bridge.</summary>
        public static JObject Status()
        {
            lock (Gate)
            {
                if (_state == null) return new JObject { ["busy"] = false, ["probe"] = _probe != null };
                return new JObject
                {
                    ["busy"] = true, ["command"] = _state.Command, ["job"] = _state.Job, ["started"] = _state.Started.ToString("o"),
                    ["gave_up"] = _state.GaveUp.ToString("o"), ["message"] = Words(_state),
                };
            }
        }

        /// <summary>A wait that ended while the work may still run (the command sets' "... timed out" TimeoutException).</summary>
        public static bool IsWaitTimeout(Exception ex)
        {
            for (Exception e = ex; e != null; e = e.InnerException)
                if (e is TimeoutException || (e.Message ?? "").IndexOf("timed out", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return false;
        }

        /// <summary>
        /// The command's wait ran out: marks the bridge busy with it and raises the probe. True when marked: the job's record
        /// stays open (heartbeats go on) until the probe closes it. False (no probe, already busy, Revit refused the
        /// probe): the caller closes the job as before.
        /// </summary>
        public static bool Mark(string command, string job, DateTime startedUtc, RevitJobLog log, object commandObject)
        {
            if (_probe == null || log == null) return false;
            State s;
            lock (Gate)
            {
                if (_state != null) return false;
                s = new State { Command = command ?? "", Job = job ?? "", Started = startedUtc, GaveUp = DateTime.UtcNow, Log = log, CommandObject = commandObject };
                _state = s;
            }
            ExternalEventRequest r;
            try { r = _probe.Raise(); } catch (Exception) { r = ExternalEventRequest.Denied; }
            if (r != ExternalEventRequest.Accepted && r != ExternalEventRequest.Pending)
            {
                lock (Gate) { if (_state == s) _state = null; }
                return false;
            }
            // keep Revit's loop awake so the probe runs as soon as the API thread is free (it also makes a cached
            // fmc_document_info answer meanwhile)
            s.Wake = RevitWake.Busy();
            log.Event("bridge_busy", new JObject { ["gave_up_after_ms"] = (long)(s.GaveUp - s.Started).TotalMilliseconds });
            return true;
        }

        /// <summary>The handler a command raises (ExternalEventCommandBase keeps it), found by reflection; null if none.</summary>
        private static object HandlerOf(object command)
        {
            for (Type t = command?.GetType(); t != null; t = t.BaseType)
            {
                foreach (PropertyInfo p in t.GetProperties(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
                {
                    if (p.GetIndexParameters().Length != 0) continue;
                    if (p.Name != "Handler" && !typeof(IWaitableExternalEventHandler).IsAssignableFrom(p.PropertyType)) continue;
                    try { object h = p.GetValue(command); if (h != null) return h; } catch (Exception) { }
                }
                foreach (FieldInfo f in t.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
                    if (typeof(IWaitableExternalEventHandler).IsAssignableFrom(f.FieldType))
                    {
                        try { object h = f.GetValue(command); if (h != null) return h; } catch (Exception) { }
                    }
            }
            return null;
        }

        /// <summary>False when the handler's completion signal exists and isn't set: its work hasn't run yet.</summary>
        private static bool HandlerFinished(object handler)
        {
            if (handler == null) return true;
            try
            {
                for (Type t = handler.GetType(); t != null; t = t.BaseType)
                    foreach (FieldInfo f in t.GetFields(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.DeclaredOnly))
                        if (typeof(WaitHandle).IsAssignableFrom(f.FieldType) && f.GetValue(handler) is WaitHandle w)
                            return w.WaitOne(0);
            }
            catch (Exception) { /* unknown handler: the probe ran after it, so it's done */ }
            return true;
        }

        private static (bool Ok, string Error, object Result) ResultOf(object handler)
        {
            if (handler == null) return (true, null, new JObject { ["finished_after_wait"] = true });
            try
            {
                Type t = handler.GetType();
                string error = t.GetProperty("Error")?.GetValue(handler) as string;
                if (!string.IsNullOrEmpty(error)) return (false, error, null);
                object result = t.GetProperty("Result")?.GetValue(handler);
                return (true, null, result ?? new JObject { ["finished_after_wait"] = true });
            }
            catch (Exception e) { return (true, null, new JObject { ["finished_after_wait"] = true, ["result_unread"] = e.Message }); }
        }

        private sealed class ProbeHandler : IExternalEventHandler
        {
            public void Execute(UIApplication app)
            {
                State s;
                lock (Gate) s = _state;
                if (s == null) return;
                object handler = HandlerOf(s.CommandObject);
                // the timed-out work hasn't started yet (Revit ran this first): look again after it. The API thread is
                // free now, so a pending event runs within moments; one that never comes (its raise was refused) frees the
                // bridge after 30 s.
                if (!HandlerFinished(handler))
                {
                    if (s.NotStartedSince == null) s.NotStartedSince = DateTime.UtcNow;
                    if (DateTime.UtcNow - s.NotStartedSince.Value < TimeSpan.FromSeconds(30))
                        try { if (_probe.Raise() == ExternalEventRequest.Accepted) return; } catch (Exception) { }
                }
                var (ok, error, result) = ResultOf(handler);
                lock (Gate) { if (_state == s) _state = null; }
                try
                {
                    s.Log.Event("bridge_free", new JObject { ["busy_ms"] = (long)(DateTime.UtcNow - s.GaveUp).TotalMilliseconds });
                    s.Log.Done(ok, error, result);
                }
                finally { s.Wake?.Dispose(); }
            }

            public string GetName() => "Formcraft bridge: free again";
        }
    }
}
