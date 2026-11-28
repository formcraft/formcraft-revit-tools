using System.IO;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_params read. action bindings: the project's parameter bindings (name, GUID when shared, data type, instance or type, categories).
    /// action values: named parameters on elements given by id or taken from one category. No transaction.
    /// </summary>
    public class FmcParamsHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft params";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_params needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    if (doc.IsFamilyDocument) throw new InvalidOperationException("[FMC-FAMILY-PROJECT] fmc_params works on a project. This document is a family file.");
                    string action = (Parameters.Value<string>("action") ?? "").Trim();
                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["transaction"] = false,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                        ["is_central"] = FmcPhaseIds.IsCentral(doc),
                    };
                    if (action == "bindings") Result["bindings"] = Bindings(doc);
                    else if (action == "values") Result["rows"] = Values(doc);
                    else throw new InvalidOperationException("[FMC-PARAM-ACTION] fmc_params reads bindings or values.");
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static JArray Bindings(Document doc)
        {
            var guidById = new Dictionary<long, string>();
            foreach (SharedParameterElement shared in new FilteredElementCollector(doc).OfClass(typeof(SharedParameterElement)).Cast<SharedParameterElement>())
                guidById[shared.Id.Value] = shared.GuidValue.ToString();
            var list = new JArray();
            DefinitionBindingMapIterator it = doc.ParameterBindings.ForwardIterator();
            while (it.MoveNext())
            {
                Definition definition = it.Key;
                var binding = it.Current as ElementBinding;
                string guid = "";
                if (definition is InternalDefinition internalDef && guidById.TryGetValue(internalDef.Id.Value, out string g)) guid = g;
                else if (definition is ExternalDefinition external) guid = external.GUID.ToString();
                var categories = new JArray();
                if (binding != null)
                    foreach (Category category in binding.Categories)
                    {
                        long v = category.Id.Value;
                        categories.Add(v < 0 && v >= int.MinValue && Enum.IsDefined(typeof(BuiltInCategory), (int)v) ? ((BuiltInCategory)(int)v).ToString() : category.Name);
                    }
                list.Add(new JObject
                {
                    ["name"] = definition.Name,
                    ["guid"] = guid,
                    ["shared"] = guid.Length > 0,
                    ["datatype"] = TypeName(definition),
                    ["binding"] = binding is TypeBinding ? "type" : "instance",
                    ["categories"] = categories,
                });
            }
            return list;
        }

        /// <summary>The kit file's vocabulary (TEXT, LENGTH, ...) so the server can compare data types.</summary>
        internal static string TypeName(Definition definition)
        {
            ForgeTypeId t;
            try { t = definition.GetDataType(); } catch (Exception) { return ""; }
            if (t == null) return "";
            if (t.Equals(SpecTypeId.String.Text)) return "TEXT";
            if (t.Equals(SpecTypeId.String.MultilineText)) return "MULTILINETEXT";
            if (t.Equals(SpecTypeId.Number)) return "NUMBER";
            if (t.Equals(SpecTypeId.Int.Integer)) return "INTEGER";
            if (t.Equals(SpecTypeId.Boolean.YesNo)) return "YESNO";
            if (t.Equals(SpecTypeId.Reference.Material)) return "MATERIAL";
            if (t.Equals(SpecTypeId.Angle)) return "ANGLE";
            if (t.Equals(SpecTypeId.Area)) return "AREA";
            if (t.Equals(SpecTypeId.Volume)) return "VOLUME";
            if (t.Equals(SpecTypeId.Length)) return "LENGTH";
            return t.TypeId ?? "";
        }

        private JArray Values(Document doc)
        {
            int cap = Math.Max(1, Math.Min(Parameters.Value<int?>("cap") ?? 5001, 5001));
            var names = new HashSet<string>((Parameters["names"] as JArray ?? new JArray()).Select(t => t.ToString().Trim().ToLowerInvariant()).Where(s => s.Length > 0));
            var elements = new List<Element>();
            JArray ids = Parameters["ids"] as JArray ?? new JArray();
            if (ids.Count > 0)
            {
                foreach (JToken t in ids)
                {
                    Element e = FmcParamCommon.Get(doc, t.ToString());
                    if (e != null && elements.Count < cap) elements.Add(e);
                }
            }
            else
            {
                string category = (Parameters.Value<string>("category") ?? "").Trim();
                if (category.Length == 0) throw new InvalidOperationException("[FMC-PARAM-SCOPE] values needs ids or a category.");
                if (!Enum.TryParse(category, true, out BuiltInCategory bic))
                    throw new InvalidOperationException("[FMC-PARAM-CATEGORY] " + category + " is not a built-in category (for example OST_Walls).");
                foreach (Element e in new FilteredElementCollector(doc).OfCategory(bic).WhereElementIsNotElementType())
                {
                    if (elements.Count >= cap) break;
                    elements.Add(e);
                }
            }
            var rows = new JArray();
            foreach (Element e in elements)
            {
                string owner;
                bool editable = FmcParamCommon.Editable(doc, e, out owner);
                var cells = new JArray();
                foreach (Parameter p in e.Parameters)
                {
                    if (p.StorageType == StorageType.None) continue;
                    if (names.Count > 0 && !names.Contains((p.Definition.Name ?? "").ToLowerInvariant())) continue;
                    cells.Add(FmcParamCommon.Cell(p));
                }
                rows.Add(new JObject { ["id"] = e.Id.Value.ToString(), ["category"] = FmcParamCommon.CategoryOf(e), ["editable"] = editable, ["owner"] = owner, ["params"] = cells });
            }
            return rows;
        }
    }

    /// <summary>
    /// fmc_params apply. bind steps point Revit at the kit file for the duration of the call, find each definition by name and GUID,
    /// and insert or re-insert the binding (categories only grow). set steps write parameter values. One transaction; any failure rolls back.
    /// The kit file is never written.
    /// </summary>
    public class FmcParamsApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft params apply";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_params_apply needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    FmcParamCommon.Refuse(doc, "fmc_params");
                    JArray steps = Parameters["steps"] as JArray ?? new JArray();
                    bool anyBind = steps.Any(s => (s.Value<string>("kind") ?? "") == "bind");
                    string kitFile = (Parameters.Value<string>("shared_parameter_file") ?? "").Trim();
                    if (anyBind && (kitFile.Length == 0 || !File.Exists(kitFile)))
                        throw new InvalidOperationException("[FMC-PARAM-FILE] The kit shared parameter file is not readable. No definition was created.");
                    int bound = 0, set = 0;
                    var changed = new HashSet<string>();
                    using (anyBind ? FmcSharedParams.Use(app.Application, kitFile) : new NoScope())
                    {
                        DefinitionFile definitions = null;
                        if (anyBind)
                        {
                            definitions = app.Application.OpenSharedParameterFile();
                            if (definitions == null) throw new InvalidOperationException("[FMC-PARAM-FILE] Revit could not open the kit shared parameter file. No definition was created.");
                        }
                        using (Transaction transaction = FmcParamCommon.Begin(doc, "Formcraft parameters"))
                        {
                            try
                            {
                                foreach (JToken token in steps)
                                {
                                    string kind = token.Value<string>("kind") ?? "";
                                    if (kind == "bind") { Bind(app, doc, definitions, token); bound++; }
                                    else if (kind == "set")
                                    {
                                        string id = token.Value<string>("target") ?? "";
                                        Element e = FmcParamCommon.Get(doc, id);
                                        if (e == null) throw new InvalidOperationException("[FMC-PARAM-ELEMENT] Element " + id + " is not in the document.");
                                        string owner;
                                        if (!FmcParamCommon.Editable(doc, e, out owner)) throw new InvalidOperationException("[FMC-PARAM-OWNED] Element " + id + " is owned by " + owner + ".");
                                        Parameter p = FmcParamCommon.Find(e, token.Value<string>("key") ?? "");
                                        FmcParamCommon.SetValue(p, token.Value<string>("storage") ?? "", token["to"], token.Value<string>("mode") ?? "value");
                                        set++;
                                        changed.Add(id);
                                    }
                                    else throw new InvalidOperationException("[FMC-PARAM-STEP] Unknown step kind " + kind + ".");
                                }
                                transaction.Commit();
                            }
                            catch
                            {
                                if (transaction.HasStarted() && !transaction.HasEnded()) transaction.RollBack();
                                throw;
                            }
                        }
                    }
                    Result = new JObject
                    {
                        ["ok"] = true,
                        ["bindings_written"] = bound,
                        ["values_set"] = set,
                        ["elements_changed"] = changed.Count,
                        ["kit_saved"] = false,
                        ["saved"] = false,
                        ["synced"] = false,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private sealed class NoScope : IDisposable { public void Dispose() { } }

        private static void Bind(UIApplication app, Document doc, DefinitionFile definitions, JToken step)
        {
            string name = (step.Value<string>("name") ?? "").Trim();
            string guid = (step.Value<string>("guid") ?? "").Trim();
            ExternalDefinition definition = null;
            foreach (DefinitionGroup group in definitions.Groups)
            {
                if (group.Definitions.get_Item(name) is ExternalDefinition found && string.Equals(found.GUID.ToString(), guid, StringComparison.OrdinalIgnoreCase)) { definition = found; break; }
            }
            if (definition == null)
                throw new InvalidOperationException("[FMC-PARAM-NOT-IN-KIT] \"" + name + "\" is not in the kit shared parameter file with GUID " + guid + ". The GUID must match the kit. No definition was created.");
            CategorySet set = app.Application.Create.NewCategorySet();
            foreach (JToken c in step["categories"] as JArray ?? new JArray())
            {
                string cname = c.ToString().Trim();
                Category category = null;
                if (Enum.TryParse(cname, true, out BuiltInCategory bic)) category = Category.GetCategory(doc, bic);
                if (category == null || !category.AllowsBoundParameters)
                    throw new InvalidOperationException("[FMC-PARAM-CATEGORY] " + cname + " cannot take a project parameter.");
                set.Insert(category);
            }
            if (set.Size == 0) throw new InvalidOperationException("[FMC-PARAM-CATEGORY] No category was given for " + name + ".");
            bool instance = !string.Equals(step.Value<string>("binding"), "type", StringComparison.OrdinalIgnoreCase);
            Binding binding = instance ? (Binding)app.Application.Create.NewInstanceBinding(set) : app.Application.Create.NewTypeBinding(set);
            ForgeTypeId group2 = FmcFamilyParamsApplyHandler.Group(step.Value<string>("group"));
            BindingMap map = doc.ParameterBindings;
            bool ok = map.Contains(definition) ? map.ReInsert(definition, binding, group2) : map.Insert(definition, binding, group2);
            if (!ok) throw new InvalidOperationException("[FMC-PARAM-BIND] Revit did not bind " + name + ". A project parameter with that name may already exist.");
        }
    }
}
