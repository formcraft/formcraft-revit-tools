using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_match read: the source and target elements with their category, type, instance parameters and the graphic overrides
    /// they have in one view. No transaction. The server plans the diff and the plan hash from this.
    /// </summary>
    public class FmcMatchHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft match";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_match needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    if (doc.IsFamilyDocument) throw new InvalidOperationException("[FMC-FAMILY-PROJECT] fmc_match works on a project. This document is a family file.");
                    var what = new HashSet<string>((Parameters["what"] as JArray ?? new JArray()).Select(t => t.ToString()), StringComparer.OrdinalIgnoreCase);
                    bool wantParams = what.Contains("parameters");
                    bool wantOverrides = what.Contains("overrides");
                    var only = new HashSet<string>((Parameters["parameters"] as JArray ?? new JArray()).Select(t => t.ToString().Trim().ToLowerInvariant()));
                    var skip = new HashSet<string>((Parameters["exclude_parameters"] as JArray ?? new JArray()).Select(t => t.ToString().Trim().ToLowerInvariant()));
                    View view = null;
                    string viewNote = "";
                    if (wantOverrides)
                    {
                        view = FmcParamCommon.Get(doc, Parameters.Value<string>("view") ?? "") as View;
                        if (view == null) throw new InvalidOperationException("[FMC-MATCH-VIEW] The view id is not a view in this document.");
                        if (view.ViewTemplateId != ElementId.InvalidElementId)
                            viewNote = "The view uses a view template. If the template controls graphic overrides, Revit refuses the change and the whole call is rolled back.";
                    }
                    Element source = FmcParamCommon.Get(doc, Parameters.Value<string>("source") ?? "");
                    var sourceRow = Snap(doc, source, source, wantParams, only, skip, view, true);
                    var targets = new JArray();
                    foreach (JToken t in Parameters["targets"] as JArray ?? new JArray())
                        targets.Add(Snap(doc, FmcParamCommon.Get(doc, t.ToString()), source, wantParams, only, skip, view, false, t.ToString()));
                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["transaction"] = false,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                        ["is_central"] = FmcPhaseIds.IsCentral(doc),
                        ["view_note"] = viewNote,
                        ["source"] = sourceRow,
                        ["targets"] = targets,
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static JObject Snap(Document doc, Element e, Element source, bool wantParams, HashSet<string> only, HashSet<string> skip, View view, bool isSource, string askedId = "")
        {
            if (e == null) return new JObject { ["id"] = askedId, ["exists"] = false };
            ElementId typeId = e.GetTypeId();
            Element typeElement = typeId != null && typeId != ElementId.InvalidElementId ? doc.GetElement(typeId) : null;
            string owner;
            bool editable = FmcParamCommon.Editable(doc, e, out owner);
            var row = new JObject
            {
                ["id"] = e.Id.Value.ToString(),
                ["exists"] = true,
                ["category"] = FmcParamCommon.CategoryOf(e),
                ["type_id"] = typeId != null && typeId != ElementId.InvalidElementId ? typeId.Value.ToString() : "",
                ["type_name"] = typeElement?.Name ?? "",
                ["editable"] = editable,
                ["owner"] = owner,
            };
            if (!isSource && source != null)
            {
                ElementId st = source.GetTypeId();
                bool ok = false;
                try { ok = st != null && st != ElementId.InvalidElementId && (e.GetTypeId() == st || e.IsValidType(st)); } catch (Exception) { ok = false; }
                row["accepts_source_type"] = ok;
            }
            if (wantParams)
            {
                var list = new JArray();
                foreach (Parameter p in e.Parameters)
                {
                    if (p.IsReadOnly || p.StorageType == StorageType.None || FmcParamCommon.NeverCopy(p)) continue;
                    string name = p.Definition.Name ?? "";
                    if (only.Count > 0 && !only.Contains(name.ToLowerInvariant())) continue;
                    if (skip.Contains(name.ToLowerInvariant())) continue;
                    if (p.StorageType == StorageType.ElementId && !FmcParamCommon.ElementIdCopyable(doc, p)) continue;
                    list.Add(FmcParamCommon.Cell(p));
                }
                row["params"] = list;
            }
            if (view != null) row["override"] = FmcParamCommon.OverrideSummary(view.GetElementOverrides(e.Id));
            return row;
        }

    }

    /// <summary>
    /// fmc_match apply: one transaction. Each target is checked again (same category, not owned by another user), then its
    /// type, parameters and view overrides are set from the plan. Any failure rolls back everything.
    /// </summary>
    public class FmcMatchApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft match apply";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_match_apply needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    FmcParamCommon.Refuse(doc, "fmc_match");
                    Element source = FmcParamCommon.Get(doc, Parameters.Value<string>("source") ?? "");
                    if (source == null) throw new InvalidOperationException("[FMC-MATCH-SOURCE] The source element is not in the document.");
                    string sourceCategory = FmcParamCommon.CategoryOf(source);
                    JArray steps = Parameters["steps"] as JArray ?? new JArray();
                    int types = 0, parameters = 0, overrides = 0;
                    var changed = new HashSet<string>();
                    var remap = new Dictionary<string, string>();
                    using (Transaction transaction = FmcParamCommon.Begin(doc, "Formcraft match"))
                    {
                        try
                        {
                            foreach (JToken token in steps)
                            {
                                string kind = token.Value<string>("kind") ?? "";
                                if (kind == "source") continue;
                                string id = token.Value<string>("target") ?? "";
                                Element e = FmcParamCommon.Get(doc, remap.ContainsKey(id) ? remap[id] : id);
                                if (e == null) throw new InvalidOperationException("[FMC-MATCH-TARGET] Element " + id + " is not in the document.");
                                if (FmcParamCommon.CategoryOf(e) != sourceCategory)
                                    throw new InvalidOperationException("[FMC-MATCH-CATEGORY] Element " + id + " is not in the source's category. Same category only.");
                                string owner;
                                if (!FmcParamCommon.Editable(doc, e, out owner))
                                    throw new InvalidOperationException("[FMC-MATCH-OWNED] Element " + id + " is owned by " + owner + ".");
                                if (kind == "type")
                                {
                                    ElementId to = new ElementId(long.Parse(token.Value<string>("to_type")));
                                    if (!e.IsValidType(to)) throw new InvalidOperationException("[FMC-MATCH-TYPE] The type is not valid for element " + id + ".");
                                    ElementId after = e.ChangeTypeId(to);
                                    if (after != null && after != e.Id) remap[id] = after.Value.ToString();
                                    doc.Regenerate();
                                    types++;
                                }
                                else if (kind == "param")
                                {
                                    Parameter p = FmcParamCommon.Find(e, token.Value<string>("key") ?? "");
                                    FmcParamCommon.SetValue(p, token.Value<string>("storage") ?? "", token["to"], "value");
                                    parameters++;
                                }
                                else if (kind == "override")
                                {
                                    View view = FmcParamCommon.Get(doc, token.Value<string>("view") ?? "") as View;
                                    if (view == null) throw new InvalidOperationException("[FMC-MATCH-VIEW] The view is not in the document.");
                                    view.SetElementOverrides(e.Id, view.GetElementOverrides(source.Id));
                                    overrides++;
                                }
                                else throw new InvalidOperationException("[FMC-MATCH-STEP] Unknown step kind " + kind + ".");
                                changed.Add(id);
                            }
                            transaction.Commit();
                        }
                        catch
                        {
                            if (transaction.HasStarted() && !transaction.HasEnded()) transaction.RollBack();
                            throw;
                        }
                    }
                    Result = new JObject
                    {
                        ["ok"] = true,
                        ["types_changed"] = types,
                        ["parameters_set"] = parameters,
                        ["overrides_copied"] = overrides,
                        ["targets_changed"] = changed.Count,
                        ["saved"] = false,
                        ["synced"] = false,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }
    }
}
