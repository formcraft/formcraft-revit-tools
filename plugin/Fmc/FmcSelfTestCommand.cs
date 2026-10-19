using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Formcraft.Shell.Services;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;
using revit_mcp_plugin.Core;
using revit_mcp_plugin.Shell;
using revit_mcp_plugin.Utils;

namespace revit_mcp_plugin.Fmc
{
    /// <summary>
    /// fmc_selftest_facts: what the add-in knows about itself, for the server's fmc_selftest. Registered by the add-in,
    /// not the command set, because only the add-in sees its build stamp, its command registry, the ribbon counters and
    /// the pane's kit folder. Runs on the socket thread and reads no model, so it answers even while Revit is busy.
    /// </summary>
    public sealed class FmcSelfTestCommand : IRevitCommand
    {
        private readonly Func<IEnumerable<string>> _registered;

        public FmcSelfTestCommand(Func<IEnumerable<string>> registered) { _registered = registered; }

        public string CommandName => "fmc_selftest_facts";

        public object Execute(JObject parameters, string requestId)
        {
            var registered = new HashSet<string>(_registered(), StringComparer.OrdinalIgnoreCase);
            var listed = new List<string>();
            try
            {
                foreach (string set in Directory.GetDirectories(PathManager.GetCommandsDirectoryPath()))
                {
                    string manifest = Path.Combine(set, "command.json");
                    if (!File.Exists(manifest)) continue;
                    foreach (JObject c in (JObject.Parse(File.ReadAllText(manifest))["commands"] as JArray ?? new JArray()).OfType<JObject>())
                        if (c.Value<string>("commandName") is string n) listed.Add(n);
                }
            }
            catch (Exception) { /* the missing list below stays empty and the count tells */ }

            var connect = ConnectSettings.Load();
            JObject installed = null;
            try
            {
                string file = Path.Combine(Path.GetDirectoryName(ConnectSettings.FilePath), "installed.json");
                if (File.Exists(file)) installed = JObject.Parse(File.ReadAllText(file));
            }
            catch (Exception) { /* no updater record */ }

            return new JObject
            {
                ["addin"] = new JObject
                {
                    ["commit"] = FmcBuildInfo.Commit, ["built"] = FmcBuildInfo.Time,
                    ["path"] = Path.GetDirectoryName(typeof(FmcSelfTestCommand).Assembly.Location),
                },
                ["installed"] = installed,
                ["revit"] = FormcraftBrowser.RevitBuild,
                ["connection"] = new JObject { ["port"] = SocketService.Instance.Port, ["start_with_revit"] = connect.StartWithRevit, ["listening"] = SocketService.Instance.IsRunning },
                // F-072: busy while a command that outlived its wait still runs on Revit's API thread
                ["bridge"] = BridgeBusy.Status(),
                ["commands"] = new JObject
                {
                    ["registered"] = registered.Count, ["listed"] = listed.Count,
                    ["missing"] = new JArray(listed.Where(n => !registered.Contains(n)).OrderBy(n => n)),
                },
                ["ribbon"] = new JObject { ["updates"] = RibbonBuilder.Updates, ["changes"] = RibbonBuilder.RibbonChanges },
                ["kit_folder"] = ShellHost.Settings?.Get(SettingKeys.KitFolder) ?? "",
                ["documents"] = new JArray(FormcraftBrowser.OpenDocuments.Select(d => new JObject
                {
                    ["title"] = d.Title, ["saved"] = !string.IsNullOrEmpty(d.Path), ["modified"] = d.IsModified, ["workshared"] = d.IsWorkshared,
                })),
            };
        }
    }
}
