using Newtonsoft.Json;
using RevitMCPSDK.API.Interfaces;
using revit_mcp_plugin.Utils;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace revit_mcp_plugin.Configuration
{
    public class ConfigurationManager
    {
        private readonly ILogger _logger;
        private readonly string _configPath;

        public FrameworkConfig Config { get; private set; }

        public ConfigurationManager(ILogger logger)
        {
            _logger = logger;

            // 配置文件路径
            // Configuration file path.
            _configPath = PathManager.GetCommandRegistryFilePath();
        }

        /// <summary>
        /// <para>加载配置</para>
        /// <para>Load configuration from a JSON file.</para>
        /// </summary>
        public void LoadConfiguration()
        {
            try
            {
                if (File.Exists(_configPath))
                {
                    string json = File.ReadAllText(_configPath);
                    Config = JsonConvert.DeserializeObject<FrameworkConfig>(json);
                    _logger.Info("已加载配置文件: {0}\nConfiguration file loaded: {0}", _configPath);
                }
                else
                {
                    _logger.Error("未找到配置文件\nNo configuration file found.");
                }
            }
            catch (Exception ex)
            {
                _logger.Error("加载配置文件失败: {0}\nFailed to load configuration file: {0}", ex.Message);
            }

            // 记录加载时间
            // Register load time.
            SyncFromCommandSets();
            _lastConfigLoadTime = DateTime.Now;
        }

        /// <summary>
        /// Formcraft is one plugin, with no command picker: every command a command set lists in its command.json is on.
        /// Commands missing from commandRegistry.json (a new release, or a registry made empty on first run) are added
        /// and the registry is saved, so a new Revit command never stays unknown to Revit.
        /// </summary>
        private void SyncFromCommandSets()
        {
            try
            {
                if (Config == null) Config = new FrameworkConfig();
                var known = new HashSet<string>(Config.Commands.Select(x => x.CommandName), StringComparer.OrdinalIgnoreCase);
                var added = new List<string>();
                string commandsDir = Path.GetDirectoryName(_configPath);
                foreach (string setDir in Directory.GetDirectories(commandsDir))
                {
                    string manifest = Path.Combine(setDir, "command.json");
                    if (!File.Exists(manifest)) continue;
                    JObject set = JObject.Parse(File.ReadAllText(manifest));
                    foreach (JObject cmd in (set["commands"] as JArray ?? new JArray()).OfType<JObject>())
                    {
                        string name = cmd.Value<string>("commandName");
                        if (string.IsNullOrEmpty(name) || known.Contains(name)) continue;
                        Config.Commands.Add(new CommandConfig
                        {
                            CommandName = name,
                            AssemblyPath = Path.Combine(Path.GetFileName(setDir), "{VERSION}", cmd.Value<string>("assemblyPath") ?? "RevitMCPCommandSet.dll"),
                            Enabled = true,
                            Description = cmd.Value<string>("description") ?? "",
                        });
                        known.Add(name);
                        added.Add(name);
                    }
                }
                if (added.Count == 0) return;
                File.WriteAllText(_configPath, JsonConvert.SerializeObject(Config, Formatting.Indented));
                _logger.Info("Formcraft: added {0} commands to the registry: {1}", added.Count, string.Join(", ", added));
            }
            catch (Exception ex)
            {
                _logger.Error("Formcraft: the command registry couldn't be synced: {0}", ex.Message);
            }
        }

        ///// <summary>
        ///// <para>重新加载配置</para>
        ///  <para>Reload configuration.</para>
        ///// </summary>
        //public void RefreshConfiguration()
        //{
        //    LoadConfiguration();
        //    _logger.Info("配置已重新加载\nConfiguration has been reloaded.");
        //}

        //public bool HasConfigChanged()
        //{
        //    if (!File.Exists(_configPath))
        //        return false;

        //    DateTime lastWrite = File.GetLastWriteTime(_configPath);
        //    return lastWrite > _lastConfigLoadTime;
        //}

        private DateTime _lastConfigLoadTime;
    }
}
