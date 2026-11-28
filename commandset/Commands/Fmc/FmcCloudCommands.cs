using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevitMCPCommandSet.Services.Fmc;

namespace RevitMCPCommandSet.Commands.Fmc
{
    /// <summary>Shared plumbing for the fmc_cloud commands. None of them syncs or publishes (rule 6).</summary>
    public abstract class FmcCloudCommandBase : ExternalEventCommandBase
    {
        private static readonly object _lock = new object();
        private FmcCloudHandler HandlerCast => (FmcCloudHandler)Handler;
        protected abstract string Action { get; }
        protected virtual int TimeoutMs => 60000;

        protected FmcCloudCommandBase(UIApplication uiApp) : base(new FmcCloudHandler(), uiApp) { }

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_lock)
            {
                HandlerCast.Action = Action;
                HandlerCast.Parameters = parameters ?? new JObject();
                if (!RaiseAndWaitForCompletion(TimeoutMs))
                    throw new TimeoutException($"{CommandName} timed out");
                if (!string.IsNullOrEmpty(HandlerCast.Error))
                    throw new Exception($"{CommandName}: {HandlerCast.Error}");
                return HandlerCast.Result;
            }
        }
    }

    /// <summary>Cloud model facts for one open document (read-only, nothing opened).</summary>
    public class FmcCloudFactsCommand : FmcCloudCommandBase
    {
        public FmcCloudFactsCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_cloud_facts";
        protected override string Action => "facts";
    }

    /// <summary>Region and GUIDs to a cloud ModelPath (read-only, nothing opened).</summary>
    public class FmcCloudPathCommand : FmcCloudCommandBase
    {
        public FmcCloudPathCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_cloud_path";
        protected override string Action => "path";
    }

    /// <summary>Document.SaveAsCloudModel after the server's gate (dry run, approved_by, live-model lock).</summary>
    public class FmcCloudSaveAsCommand : FmcCloudCommandBase
    {
        public FmcCloudSaveAsCommand(UIApplication uiApp) : base(uiApp) { }
        public override string CommandName => "fmc_cloud_save_as";
        protected override string Action => "save_as";
        protected override int TimeoutMs => 600000;
    }
}
