using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>An input the graph cannot take: the run is refused before Dynamo runs.</summary>
    public class FmcDynamoInputException : Exception
    {
        public FmcDynamoInputException(string message) : base(message) { }
    }

    /// <summary>
    /// Dynamo for Revit, called by reflection. This project does not reference DynamoRevitDS or DynamoCore,
    /// so the add-in still builds where those assemblies are not installed. If they are not loaded at run time
    /// the answer is FMC-DYNAMO-UNAVAILABLE. This is not DynamoSandbox and not a send_code bypass.
    /// </summary>
    public static class FmcDynamoHost
    {
        public static JObject Session()
        {
            try
            {
                var loaded = Loaded().ToList();
                if (loaded.Count == 0)
                {
                    string file = FindDll();
                    if (string.IsNullOrEmpty(file))
                        return Unavailable("Dynamo for Revit is not loaded in this session, and DynamoRevitDS.dll was not found next to Revit.", false);
                    try { loaded.Add(Assembly.LoadFrom(file)); }
                    catch (Exception ex) { return Failure("FMC-DYNAMO-UNAVAILABLE", ex, false, false); }
                }
                string version = loaded.Select(a => a.GetName().Version?.ToString()).FirstOrDefault(v => !string.IsNullOrEmpty(v)) ?? "";
                bool started = ModelStarted();
                return new JObject
                {
                    ["loaded"] = true,
                    ["model_started"] = started,
                    ["version"] = version,
                    ["assemblies"] = new JArray(loaded.Select(a => a.GetName().Name).Distinct()),
                    ["binding"] = "reflection",
                    ["note"] = started
                        ? "Dynamo for Revit is loaded and its model has been started. Calls are late-bound."
                        : "Dynamo for Revit assemblies are loaded. The RevitDynamoModel has not been started in this session.",
                };
            }
            catch (Exception ex)
            {
                return Failure("FMC-DYNAMO-UNAVAILABLE", ex, false, false);
            }
        }

        /// <summary>
        /// Runs one graph. If Dynamo's model has not been started, this calls DynamoRevit.ExecuteCommand
        /// with dynShowUI false and dynAutomation true. That dictionary is Dynamo's own startup switch.
        /// It does not write a Revit journal and it does not launch Revit. Nothing is saved.
        /// </summary>
        public static JObject Run(UIApplication app, Document doc, string file, JObject inputs)
        {
            if (doc == null || !doc.IsValidObject)
                return Failure("FMC-DYNAMO-UNAVAILABLE", new InvalidOperationException("The document for this graph is not open."), true, ModelStarted());
            JObject session = Session();
            if (session.Value<bool?>("loaded") != true) return session;
            bool started = session.Value<bool?>("model_started") == true;
            if (!started)
            {
                Exception startError = TryStartHeadless(app);
                started = ModelStarted();
                if (!started)
                {
                    JObject refused = Failure("FMC-DYNAMO-NOT-STARTED", startError ?? new InvalidOperationException("RevitDynamoModel is still null after a headless start."), true, false);
                    refused["hint"] = "Open Dynamo once in this Revit session.";
                    refused["message"] = "[FMC-DYNAMO-NOT-STARTED] " + (startError == null
                        ? "Dynamo for Revit did not start a model."
                        : Unwrap(startError).Message) + " Open Dynamo once in this Revit session.";
                    return refused;
                }
            }
            try
            {
                object model = CurrentModel();
                if (model == null)
                {
                    JObject refused = Failure("FMC-DYNAMO-NOT-STARTED", new InvalidOperationException("RevitDynamoModel was null."), true, false);
                    refused["hint"] = "Open Dynamo once in this Revit session.";
                    return refused;
                }
                // R-2 / DT-63: Dynamo works on its own current document. Refuse unless that is the target, so a preview's
                // rollback covers everything the graph writes.
                string wrongDoc = WrongDocument(app, doc);
                if (wrongDoc != null)
                {
                    return new JObject
                    {
                        ["ran"] = false, ["loaded"] = true, ["model_started"] = true, ["code"] = "FMC-DYNAMO-WRONG-DOCUMENT",
                        ["message"] = "[FMC-DYNAMO-WRONG-DOCUMENT] " + wrongDoc + " Make the target model the active document, then run again. Nothing ran.",
                    };
                }
                InvokeOpen(model, file);
                JArray set = SetInputs(model, inputs);
                InvokeRun(model);
                return new JObject
                {
                    ["ran"] = true,
                    ["loaded"] = true,
                    ["model_started"] = true,
                    ["version"] = session["version"],
                    ["outputs"] = ReadWatches(model),
                    ["inputs_set"] = set,
                    ["binding"] = "reflection",
                };
            }
            catch (FmcDynamoInputException ex)
            {
                return new JObject
                {
                    ["ran"] = false, ["loaded"] = true, ["model_started"] = true, ["code"] = "FMC-DYNAMO-INPUT",
                    ["message"] = "[FMC-DYNAMO-INPUT] " + ex.Message + " The graph was not run.",
                };
            }
            catch (Exception ex)
            {
                JObject failed = Failure("FMC-DYNAMO-UNAVAILABLE", ex, true, ModelStarted());
                failed["version"] = session["version"];
                return failed;
            }
        }

        /// <summary>
        /// DT-66 / R-5: the graph must sit under &lt;kit&gt;\05_Scripts\library or &lt;kit&gt;\05_Scripts\Dynamo, compared as full
        /// path segments after normalising (no substring test, no "..", no link that leaves the folder), and its SHA-256
        /// must equal the hash the server planned with. Returns null when approved, else the reason.
        /// </summary>
        public static string ApprovedReason(string path, string kitRoot, string sha256)
        {
            if (string.IsNullOrWhiteSpace(path)) return "No graph path.";
            if (string.IsNullOrWhiteSpace(kitRoot)) return "No kit root from the server.";
            if (string.IsNullOrWhiteSpace(sha256)) return "No graph hash from the server.";
            if (path.Contains("..")) return path + " uses '..'.";
            string full, kit;
            try { full = Path.GetFullPath(path); kit = Path.GetFullPath(kitRoot).TrimEnd('\\', '/'); }
            catch (Exception ex) { return "Bad path: " + ex.Message; }
            bool inside = false;
            foreach (string place in new[] { "library", "Dynamo" })
            {
                string root = Path.Combine(kit, "05_Scripts", place) + Path.DirectorySeparatorChar;
                if (full.StartsWith(root, StringComparison.OrdinalIgnoreCase) && full.Length > root.Length) inside = true;
            }
            if (!inside) return full + " is outside " + kit + "\\05_Scripts\\library or \\Dynamo.";
            try
            {
                for (var dir = new DirectoryInfo(Path.GetDirectoryName(full) ?? ""); dir != null && dir.FullName.Length > kit.Length; dir = dir.Parent)
                    if ((dir.Attributes & FileAttributes.ReparsePoint) != 0) return dir.FullName + " is a link or junction.";
                if ((File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0) return full + " is a link.";
            }
            catch (Exception ex) { return "Can't read " + full + ": " + ex.Message; }
            string actual;
            try
            {
                using var stream = File.OpenRead(full);
                using var sha = System.Security.Cryptography.SHA256.Create();
                actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            }
            catch (Exception ex) { return "Can't hash " + full + ": " + ex.Message; }
            if (!string.Equals(actual, sha256.Trim(), StringComparison.OrdinalIgnoreCase))
                return full + " changed after the server planned it (SHA-256 " + actual.Substring(0, 12) + "..., planned " + sha256.Trim().Substring(0, Math.Min(12, sha256.Trim().Length)) + "...).";
            return null;
        }

        /// <summary>Null when Dynamo's current document is the target (or Dynamo cannot say and the target is active).</summary>
        private static string WrongDocument(UIApplication app, Document target)
        {
            Document current = null;
            try
            {
                Type manager = FindType("RevitServices.Persistence.DocumentManager") ?? FindType("DocumentManager");
                object instance = manager?.GetProperty("Instance", BindingFlags.Public | BindingFlags.Static)?.GetValue(null);
                current = instance?.GetType().GetProperty("CurrentDBDocument")?.GetValue(instance) as Document;
            }
            catch { current = null; }
            if (current == null) current = app?.ActiveUIDocument?.Document;
            if (current == null) return "Dynamo has no current document.";
            if (current.Equals(target)) return null;
            return "Dynamo's document is " + current.Title + ", not the target " + target.Title + ".";
        }

        private static JObject Unavailable(string why, bool modelStarted)
        {
            return new JObject
            {
                ["loaded"] = false,
                ["model_started"] = modelStarted,
                ["ran"] = false,
                ["code"] = "FMC-DYNAMO-UNAVAILABLE",
                ["exception_type"] = "",
                ["message"] = "[FMC-DYNAMO-UNAVAILABLE] " + why + " This is not DynamoSandbox and not a send_code bypass.",
                ["stack"] = "",
            };
        }

        private static Exception Unwrap(Exception ex)
        {
            return ex is TargetInvocationException tie && tie.InnerException != null ? Unwrap(tie.InnerException) : ex;
        }

        private static JObject Failure(string code, Exception ex, bool loaded, bool modelStarted)
        {
            Exception inner = Unwrap(ex);
            return new JObject
            {
                ["loaded"] = loaded,
                ["model_started"] = modelStarted,
                ["ran"] = false,
                ["code"] = code,
                ["exception_type"] = inner.GetType().FullName,
                ["message"] = inner.Message,
                ["stack"] = string.IsNullOrEmpty(inner.StackTrace) ? inner.ToString() : inner.GetType().FullName + ": " + inner.Message + Environment.NewLine + inner.StackTrace,
            };
        }

        /// <summary>True when DynamoRevit.RevitDynamoModel exists and its state has started. Loaded assemblies alone are not enough.</summary>
        private static bool ModelStarted()
        {
            object model = CurrentModel();
            if (model == null) return false;
            string state = model.GetType().GetProperty("State")?.GetValue(model)?.ToString() ?? "";
            return state.StartsWith("Started", StringComparison.Ordinal);
        }

        private static object CurrentModel()
        {
            Type host = FindType("DynamoRevit");
            PropertyInfo property = host?.GetProperty("RevitDynamoModel", BindingFlags.Public | BindingFlags.Static);
            return property?.GetValue(null);
        }

        /// <summary>
        /// DynamoRevit.ExecuteCommand with the UI hidden. Returns null when the call itself did not throw.
        /// A null model afterwards is reported by the caller.
        /// </summary>
        private static Exception TryStartHeadless(UIApplication app)
        {
            Type hostType = FindType("DynamoRevit");
            Type dataType = FindType("DynamoRevitCommandData");
            if (hostType == null || dataType == null)
                return new InvalidOperationException("DynamoRevit.ExecuteCommand is not in the loaded assemblies.");
            object data;
            try { data = Activator.CreateInstance(dataType); }
            catch (Exception ex) { return Unwrap(ex); }
            if (data == null) return new InvalidOperationException("DynamoRevitCommandData could not be created.");
            try
            {
                dataType.GetProperty("Application")?.SetValue(data, app);
                var journal = new Dictionary<string, string>
                {
                    ["dynShowUI"] = "False",
                    ["dynAutomation"] = "True",
                };
                dataType.GetProperty("JournalData")?.SetValue(data, journal);
                MethodInfo execute = hostType.GetMethod("ExecuteCommand", new[] { dataType });
                if (execute == null) return new MissingMethodException(hostType.FullName, "ExecuteCommand");
                object host = Activator.CreateInstance(hostType);
                object result = execute.Invoke(host, new[] { data });
                if (result != null && !string.Equals(result.ToString(), "Succeeded", StringComparison.OrdinalIgnoreCase))
                    return new InvalidOperationException("DynamoRevit.ExecuteCommand returned " + result + ".");
            }
            catch (Exception ex)
            {
                return Unwrap(ex);
            }
            return null;
        }

        private static IEnumerable<Assembly> Loaded()
        {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "DynamoRevitDS", "DynamoRevit", "DynamoCore" };
            foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                string name = "";
                try { name = assembly.GetName().Name ?? ""; } catch { continue; }
                if (names.Contains(name)) yield return assembly;
            }
        }

        private static string FindDll()
        {
            var candidates = new List<string>();
            string program = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            foreach (string version in new[] { "2025", "2026", "2024" })
            {
                candidates.Add(Path.Combine(program, "Autodesk", "Revit " + version, "AddIns", "DynamoForRevit", "Revit", "DynamoRevitDS.dll"));
                candidates.Add(Path.Combine(program, "Autodesk", "Revit " + version, "AddIns", "DynamoForRevit", "DynamoRevitDS.dll"));
            }
            return candidates.FirstOrDefault(File.Exists);
        }

        private static Type FindType(string name)
        {
            foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type[] types;
                try { types = assembly.GetTypes(); }
                catch (ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray(); }
                catch { continue; }
                Type hit = types.FirstOrDefault(t => t != null && (t.Name == name || t.FullName == name));
                if (hit != null) return hit;
            }
            return null;
        }

        private static void InvokeOpen(object model, string file)
        {
            MethodInfo open = model.GetType().GetMethods().FirstOrDefault(m => m.Name == "OpenFileFromPath");
            if (open == null) throw new InvalidOperationException("OpenFileFromPath is not on this Dynamo model.");
            System.Reflection.ParameterInfo[] parameters = open.GetParameters();
            if (parameters.Length >= 2 && parameters[1].ParameterType == typeof(bool)) open.Invoke(model, new object[] { file, true });
            else open.Invoke(model, new object[] { file });
        }

        /// <summary>
        /// R-1 / DT-62: inputs arrive keyed by node GUID (the server binds names with inspect). Each one is set with
        /// UpdateModelValueCommand(Guid, "Value", value). A key that is not a GUID, or a set that throws, refuses the run;
        /// nothing is dropped without a word.
        /// </summary>
        private static JArray SetInputs(object model, JObject inputs)
        {
            var set = new JArray();
            if (inputs == null || !inputs.Properties().Any()) return set;
            Type commandType = FindType("UpdateModelValueCommand");
            MethodInfo execute = model.GetType().GetMethods().FirstOrDefault(m => m.Name == "ExecuteCommand" && m.GetParameters().Length == 1);
            if (commandType == null || execute == null) throw new FmcDynamoInputException("This Dynamo has no UpdateModelValueCommand, so inputs can't be set.");
            ConstructorInfo byGuid = commandType.GetConstructors().FirstOrDefault(c =>
            {
                var p = c.GetParameters();
                return p.Length == 3 && p[0].ParameterType == typeof(Guid) && p[1].ParameterType == typeof(string) && p[2].ParameterType == typeof(string);
            });
            foreach (JProperty property in inputs.Properties())
            {
                if (!Guid.TryParse(property.Name, out Guid id))
                    throw new FmcDynamoInputException("Input key " + property.Name + " is not a node id. Inputs are bound by name on the server.");
                string value = property.Value?.Type == JTokenType.String ? property.Value.ToString() : property.Value?.ToString(Newtonsoft.Json.Formatting.None) ?? "";
                try
                {
                    object command = byGuid != null
                        ? byGuid.Invoke(new object[] { id, "Value", value })
                        : Activator.CreateInstance(commandType, id.ToString(), "Value", value);
                    execute.Invoke(model, new[] { command });
                    set.Add(new JObject { ["id"] = id.ToString(), ["value"] = value });
                }
                catch (Exception ex)
                {
                    throw new FmcDynamoInputException("Input " + id + " could not be set: " + Unwrap(ex).Message);
                }
            }
            return set;
        }

        private static void InvokeRun(object model)
        {
            Type runType = FindType("RunCancelCommand");
            MethodInfo execute = model.GetType().GetMethods().FirstOrDefault(m => m.Name == "ExecuteCommand" && m.GetParameters().Length == 1);
            if (runType == null || execute == null) throw new InvalidOperationException("RunCancelCommand is not available on this Dynamo model.");
            ConstructorInfo ctor = runType.GetConstructors().FirstOrDefault(c => c.GetParameters().Length >= 1);
            object command = ctor == null
                ? Activator.CreateInstance(runType)
                : ctor.Invoke(ctor.GetParameters().Select(p => p.ParameterType == typeof(bool) ? (object)false : (p.HasDefaultValue ? p.DefaultValue : null)).ToArray());
            execute.Invoke(model, new[] { command });
        }

        private static JObject ReadWatches(object model)
        {
            var outputs = new JObject();
            PropertyInfo workspace = model.GetType().GetProperty("CurrentWorkspace");
            object current = workspace?.GetValue(model);
            if (current == null) return outputs;
            PropertyInfo nodes = current.GetType().GetProperty("Nodes");
            object list = nodes?.GetValue(current);
            if (list is not System.Collections.IEnumerable enumerable) return outputs;
            foreach (object node in enumerable)
            {
                if (node == null) continue;
                string type = node.GetType().Name;
                if (type.IndexOf("Watch", StringComparison.OrdinalIgnoreCase) < 0 && type.IndexOf("Output", StringComparison.OrdinalIgnoreCase) < 0) continue;
                string name = node.GetType().GetProperty("Name")?.GetValue(node)?.ToString() ?? type;
                object value = node.GetType().GetProperty("CachedValue")?.GetValue(node) ?? node.GetType().GetProperty("Value")?.GetValue(node);
                outputs[name] = value == null ? JValue.CreateNull() : JToken.FromObject(value.ToString());
            }
            return outputs;
        }
    }
}
