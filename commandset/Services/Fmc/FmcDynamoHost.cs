using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
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
                        return Unavailable("Dynamo for Revit is not loaded in this session, and DynamoRevitDS.dll was not found next to Revit.");
                    try { loaded.Add(Assembly.LoadFrom(file)); }
                    catch (Exception ex) { return Unavailable("Dynamo for Revit could not be loaded: " + ex.Message); }
                }
                string version = loaded.Select(a => a.GetName().Version?.ToString()).FirstOrDefault(v => !string.IsNullOrEmpty(v)) ?? "";
                return new JObject
                {
                    ["loaded"] = true,
                    ["version"] = version,
                    ["assemblies"] = new JArray(loaded.Select(a => a.GetName().Name).Distinct()),
                    ["binding"] = "reflection",
                    ["note"] = "Dynamo calls are late-bound. This build does not reference the Dynamo for Revit assemblies.",
                };
            }
            catch (Exception ex)
            {
                return Unavailable(ex.GetType().Name + ": " + ex.Message);
            }
        }

        public static JObject Run(Document doc, string file, JObject inputs)
        {
            JObject session = Session();
            if (session.Value<bool?>("loaded") != true) return session;
            Type modelType = FindType("RevitDynamoModel") ?? FindType("DynamoRevit");
            if (modelType == null)
                return Unavailable("Dynamo for Revit is loaded but RevitDynamoModel was not found. Open Dynamo in this session. Nothing was run.");
            try
            {
                object model = ExistingModel(modelType) ?? StartModel(modelType, doc);
                if (model == null)
                    return Unavailable("Dynamo for Revit did not return a model. The graph was not run, and DynamoSandbox was not started.");
                InvokeOpen(model, file);
                SetInputs(model, inputs);
                InvokeRun(model);
                return new JObject
                {
                    ["ran"] = true,
                    ["loaded"] = true,
                    ["version"] = session["version"],
                    ["outputs"] = ReadWatches(model),
                    ["binding"] = "reflection",
                };
            }
            catch (Exception ex)
            {
                Exception inner = ex is TargetInvocationException tie && tie.InnerException != null ? tie.InnerException : ex;
                return Unavailable(inner.GetType().Name + ": " + inner.Message);
            }
        }

        public static bool Approved(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return false;
            string normal = path.Replace('/', '\\').ToLowerInvariant();
            return normal.Contains("\\05_scripts\\library\\") || normal.Contains("\\05_scripts\\dynamo\\");
        }

        private static JObject Unavailable(string why)
        {
            return new JObject
            {
                ["loaded"] = false,
                ["code"] = "FMC-DYNAMO-UNAVAILABLE",
                ["message"] = "[FMC-DYNAMO-UNAVAILABLE] " + why + " This is not DynamoSandbox and not a send_code bypass.",
            };
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

        private static object ExistingModel(Type modelType)
        {
            foreach (PropertyInfo property in modelType.GetProperties(BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance))
            {
                if (property.PropertyType == modelType || property.Name.IndexOf("Model", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    try
                    {
                        object value = property.GetGetMethod()?.IsStatic == true ? property.GetValue(null) : null;
                        if (value != null && modelType.IsInstanceOfType(value)) return value;
                    }
                    catch { /* the next property */ }
                }
            }
            Type host = FindType("DynamoRevit");
            if (host == null) return null;
            foreach (PropertyInfo property in host.GetProperties(BindingFlags.Public | BindingFlags.Static))
            {
                try
                {
                    object hostValue = property.GetValue(null);
                    if (hostValue == null) continue;
                    PropertyInfo model = hostValue.GetType().GetProperties().FirstOrDefault(p => p.PropertyType.Name.IndexOf("DynamoModel", StringComparison.OrdinalIgnoreCase) >= 0 || p.Name == "RevitDynamoModel");
                    object value = model?.GetValue(hostValue);
                    if (value != null) return value;
                }
                catch { /* keep looking */ }
            }
            return null;
        }

        private static object StartModel(Type modelType, Document doc)
        {
            MethodInfo start = modelType.GetMethods(BindingFlags.Public | BindingFlags.Static).FirstOrDefault(m => m.Name == "Start");
            if (start == null) return null;
            System.Reflection.ParameterInfo[] parameters = start.GetParameters();
            if (parameters.Length == 0) return start.Invoke(null, null);
            object config = Activator.CreateInstance(parameters[0].ParameterType);
            if (config == null) return null;
            TrySet(config, "DynamoCorePath", null);
            TrySet(config, "Context", "Revit");
            return start.Invoke(null, new[] { config });
        }

        private static void TrySet(object target, string name, object value)
        {
            PropertyInfo property = target.GetType().GetProperty(name);
            if (property == null || !property.CanWrite || value == null) return;
            try { property.SetValue(target, value); } catch { /* optional configuration */ }
        }

        private static void InvokeOpen(object model, string file)
        {
            MethodInfo open = model.GetType().GetMethods().FirstOrDefault(m => m.Name == "OpenFileFromPath");
            if (open == null) throw new InvalidOperationException("OpenFileFromPath is not on this Dynamo model.");
            System.Reflection.ParameterInfo[] parameters = open.GetParameters();
            if (parameters.Length >= 2 && parameters[1].ParameterType == typeof(bool)) open.Invoke(model, new object[] { file, true });
            else open.Invoke(model, new object[] { file });
        }

        private static void SetInputs(object model, JObject inputs)
        {
            if (inputs == null || !inputs.Properties().Any()) return;
            Type commandType = FindType("UpdateModelValueCommand");
            MethodInfo execute = model.GetType().GetMethods().FirstOrDefault(m => m.Name == "ExecuteCommand" && m.GetParameters().Length == 1);
            if (commandType == null || execute == null) return;
            foreach (JProperty property in inputs.Properties())
            {
                try
                {
                    object command = Activator.CreateInstance(commandType, property.Name, "Value", property.Value?.ToString() ?? "");
                    if (command != null) execute.Invoke(model, new[] { command });
                }
                catch { /* a graph with no matching input keeps its saved value */ }
            }
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
