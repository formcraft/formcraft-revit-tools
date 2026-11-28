using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;
using RevitMCPCommandSet.Utils;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>GAP-26 fmc_groups_audit: group types and instances in the named document. No transaction.</summary>
    public class FmcGroupsAuditHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft groups (audit)";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    var types = new JArray();
                    foreach (GroupType type in new FilteredElementCollector(doc).OfClass(typeof(GroupType)).Cast<GroupType>())
                    {
                        types.Add(new JObject
                        {
                            ["id"] = type.Id.GetValue().ToString(),
                            ["name"] = type.Name ?? "",
                            ["kind"] = Kind(type),
                        });
                    }
                    var instances = new JArray();
                    foreach (Group group in new FilteredElementCollector(doc).OfClass(typeof(Group)).Cast<Group>())
                    {
                        ICollection<ElementId> members = group.GetMemberIds() ?? (ICollection<ElementId>)new List<ElementId>();
                        int family = 0, mirrored = 0, notes = 0;
                        var nested = new JArray();
                        foreach (ElementId id in members)
                        {
                            Element element = doc.GetElement(id);
                            if (element is Group) nested.Add(id.GetValue().ToString());
                            if (element is TextNote) notes++;
                            if (element is FamilyInstance fi)
                            {
                                family++;
                                if (fi.Mirrored) mirrored++;
                            }
                        }
                        string checkout = "", owner = "", workset = "";
                        if (doc.IsWorkshared)
                        {
                            try
                            {
                                checkout = WorksharingUtils.GetCheckoutStatus(doc, group.Id).ToString();
                                WorksharingTooltipInfo tip = WorksharingUtils.GetWorksharingTooltipInfo(doc, group.Id);
                                owner = tip?.Owner ?? "";
                                WorksetId wid = group.WorksetId;
                                if (wid != null && wid != WorksetId.InvalidWorksetId)
                                    workset = doc.GetWorksetTable().GetWorkset(wid)?.Name ?? "";
                            }
                            catch (Exception) { /* facts stay empty; the audit still lists the group */ }
                        }
                        ElementId attached = group.GroupType == null ? ElementId.InvalidElementId : AttachedOf(group);
                        instances.Add(new JObject
                        {
                            ["id"] = group.Id.GetValue().ToString(),
                            ["type_id"] = group.GroupType?.Id.GetValue().ToString() ?? "",
                            ["members"] = members.Count,
                            ["member_family_instances"] = family,
                            ["mirrored_members"] = mirrored,
                            ["nested_group_ids"] = nested,
                            ["text_notes"] = notes,
                            ["attached_parent_id"] = attached != null && attached != ElementId.InvalidElementId ? attached.GetValue().ToString() : "",
                            ["checkout"] = checkout,
                            ["owner"] = owner,
                            ["workset"] = workset,
                        });
                    }
                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["title"] = doc.Title ?? "",
                        ["path"] = doc.PathName ?? "",
                        ["types"] = types,
                        ["instances"] = instances,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static string Kind(GroupType type)
        {
            long id = type.Category?.Id.GetValue() ?? 0;
            if (id == (long)BuiltInCategory.OST_IOSDetailGroups || id == (long)BuiltInCategory.OST_IOSAttachedDetailGroups) return "detail";
            return "model";
        }

        private static ElementId AttachedOf(Group group)
        {
            try { return group.AttachedParentId; }
            catch (Exception) { return ElementId.InvalidElementId; }
        }
    }
}
