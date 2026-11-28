using Autodesk.Revit.DB;
using Autodesk.Revit.DB.ExtensibleStorage;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;
using RevitMCPCommandSet.Utils;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_extstore (GAP-19): the FMC_ExtStore schema. One fixed GUID; the server (server/src/fmc/extstore.ts) uses the same
    /// one and a test checks they agree. Fields: FmcId, BatchId, RecipeHash, Source. Vendor Formcraft.
    /// </summary>
    public static class FmcExtStoreSchema
    {
        public static readonly Guid SchemaGuid = new Guid("cf567a49-572e-4e9a-afd1-f827205bd249");
        public static readonly string[] Fields = { "FmcId", "BatchId", "RecipeHash", "Source" };

        public static Schema Find() => Schema.Lookup(SchemaGuid);

        /// <summary>The schema, made the first time a write needs it. Reads never create it.</summary>
        public static Schema GetOrCreate()
        {
            Schema s = Schema.Lookup(SchemaGuid);
            if (s != null) return s;
            var b = new SchemaBuilder(SchemaGuid);
            b.SetSchemaName("FMC_ExtStore");
            b.SetDocumentation("Formcraft: the element's FMC id, batch id, recipe hash and source.");
            b.SetReadAccessLevel(AccessLevel.Public);
            b.SetWriteAccessLevel(AccessLevel.Public);
            b.SetVendorId("Formcraft");
            foreach (string f in Fields) b.AddSimpleField(f, typeof(string));
            return b.Finish();
        }

        public static ElementId ToId(string text)
        {
            if (!long.TryParse((text ?? "").Trim(), out long v)) return ElementId.InvalidElementId;
#if REVIT2024_OR_GREATER
            return new ElementId(v);
#else
            return new ElementId((int)v);
#endif
        }

        public static void Checkout(Document doc, ElementId id, JObject row)
        {
            if (!doc.IsWorkshared) return;
            CheckoutStatus status = WorksharingUtils.GetCheckoutStatus(doc, id, out string owner);
            row["checkout"] = status == CheckoutStatus.OwnedByOtherUser ? "owned_by_other"
                : status == CheckoutStatus.OwnedByCurrentUser ? "owned_by_me" : "not_owned";
            if (!string.IsNullOrEmpty(owner)) row["owner"] = owner;
        }

        public static JObject Row(Document doc, Element e, Schema s)
        {
            var row = new JObject
            {
                ["id"] = e.Id.GetValue().ToString(),
                ["unique_id"] = e.UniqueId ?? "",
                ["category"] = e.Category?.Name ?? "",
                ["fmc_id"] = "", ["batch_id"] = "", ["recipe_hash"] = "", ["source"] = "",
            };
            if (s != null)
            {
                Entity en = e.GetEntity(s);
                if (en != null && en.IsValid())
                {
                    row["fmc_id"] = en.Get<string>("FmcId") ?? "";
                    row["batch_id"] = en.Get<string>("BatchId") ?? "";
                    row["recipe_hash"] = en.Get<string>("RecipeHash") ?? "";
                    row["source"] = en.Get<string>("Source") ?? "";
                }
            }
            Checkout(doc, e.Id, row);
            return row;
        }
    }

    /// <summary>Reads FMC_ExtStore records: given ids, or every stamped element. No transaction; never creates the schema.</summary>
    public class FmcExtStoreReadHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft extensible storage read";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                if ((Parameters?.Value<string>("document") ?? "").Trim().Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_extstore needs document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    Schema s = FmcExtStoreSchema.Find();
                    int limit = Math.Max(1, Parameters.Value<int?>("limit") ?? 5000);
                    var rows = new JArray();
                    var missing = new JArray();
                    bool truncated = false;
                    if (Parameters.Value<bool?>("all") == true)
                    {
                        if (s != null)
                        {
                            foreach (Element e in new FilteredElementCollector(doc).WherePasses(new ExtensibleStorageFilter(FmcExtStoreSchema.SchemaGuid)))
                            {
                                if (rows.Count >= limit) { truncated = true; break; }
                                rows.Add(FmcExtStoreSchema.Row(doc, e, s));
                            }
                        }
                    }
                    else
                    {
                        foreach (JToken t in (Parameters["ids"] as JArray) ?? new JArray())
                        {
                            Element e = doc.GetElement(FmcExtStoreSchema.ToId(t.ToString()));
                            if (e == null) { missing.Add(t.ToString()); continue; }
                            if (rows.Count >= limit) { truncated = true; break; }
                            rows.Add(FmcExtStoreSchema.Row(doc, e, s));
                        }
                    }
                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["title"] = doc.Title ?? "",
                        ["path"] = doc.PathName ?? "",
                        ["schema_present"] = s != null,
                        ["rows"] = rows,
                        ["missing"] = missing,
                        ["truncated"] = truncated,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }
    }

    /// <summary>
    /// Stamps FMC_ExtStore records in one transaction. Skips elements another user owns. Keeps an existing FmcId unless
    /// reassign is true. dry_run true rolls the transaction back (the server sends real writes only with dry_run false).
    /// </summary>
    public class FmcExtStoreWriteHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft extensible storage write";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                if ((Parameters?.Value<string>("document") ?? "").Trim().Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_extstore needs document.");
                if ((Parameters.Value<string>("schema_guid") ?? "") != FmcExtStoreSchema.SchemaGuid.ToString())
                    throw new InvalidOperationException("[FMC-EXTSTORE-GUID] The server and the add-in disagree on the FMC_ExtStore GUID.");
                if ((Parameters.Value<string>("batch_lease") ?? "").Trim().Length == 0)
                    throw new InvalidOperationException("[FMC-BATCH-LOCKED] fmc_extstore writes only under a batch lease.");
                bool dry = Parameters.Value<bool?>("dry_run") == true;
                bool reassign = Parameters.Value<bool?>("reassign") == true;
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    if (doc.IsReadOnly) throw new InvalidOperationException("[FMC-EXTSTORE-READONLY] The document is read-only.");
                    var written = new JArray();
                    var skipped = new JArray();
                    using (var tx = new Transaction(doc, "Formcraft: FMC ids"))
                    {
                        tx.Start();
                        Schema s = FmcExtStoreSchema.GetOrCreate();
                        foreach (JObject r in ((Parameters["records"] as JArray) ?? new JArray()).OfType<JObject>())
                        {
                            string idText = r.Value<string>("id") ?? "";
                            Element e = doc.GetElement(FmcExtStoreSchema.ToId(idText));
                            if (e == null) { skipped.Add(new JObject { ["id"] = idText, ["reason"] = "no such element" }); continue; }
                            if (doc.IsWorkshared && WorksharingUtils.GetCheckoutStatus(doc, e.Id, out string owner) == CheckoutStatus.OwnedByOtherUser)
                            { skipped.Add(new JObject { ["id"] = idText, ["reason"] = "owned by " + owner }); continue; }
                            Entity now = e.GetEntity(s);
                            string fmc = r.Value<string>("fmc_id") ?? "";
                            if (now != null && now.IsValid() && !reassign)
                            {
                                string had = now.Get<string>("FmcId") ?? "";
                                if (had.Length > 0 && had != fmc) { skipped.Add(new JObject { ["id"] = idText, ["reason"] = "already carries " + had }); continue; }
                            }
                            var en = new Entity(s);
                            en.Set("FmcId", fmc);
                            en.Set("BatchId", r.Value<string>("batch_id") ?? "");
                            en.Set("RecipeHash", r.Value<string>("recipe_hash") ?? "");
                            en.Set("Source", r.Value<string>("source") ?? "");
                            e.SetEntity(en);
                            written.Add(idText);
                        }
                        if (dry) tx.RollBack(); else tx.Commit();
                    }
                    Result = new JObject
                    {
                        ["dry_run"] = dry,
                        ["rolled_back"] = dry,
                        ["title"] = doc.Title ?? "",
                        ["path"] = doc.PathName ?? "",
                        ["written"] = written.Count,
                        ["written_ids"] = written,
                        ["skipped"] = skipped,
                        ["schema_guid"] = FmcExtStoreSchema.SchemaGuid.ToString(),
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }
    }
}
