using System;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.ExtensibleStorage;

namespace revit_mcp_plugin.Fmc
{
    /// <summary>
    /// The per-project switch for "Keep FMC data filled" (docs/LIVE_DATA.md), kept in the model on Project Information
    /// (extensible storage), so everyone working on the project gets the same setting after they sync. Off unless the
    /// BIM Manager switched it on from the pane. Claude has no tool that sets it.
    /// </summary>
    public static class LiveDataSwitch
    {
        public static readonly Guid SchemaId = new Guid("b49826ed-9229-41a3-85da-570aeca63984");
        private const string FieldEnabled = "Enabled";
        private const string FieldBy = "EnabledBy";
        private const string FieldAt = "EnabledAt";

        public sealed class State
        {
            public bool Enabled { get; set; }
            public string By { get; set; } = "";
            public string At { get; set; } = "";
        }

        private static Schema GetOrCreateSchema()
        {
            Schema s = Schema.Lookup(SchemaId);
            if (s != null) return s;
            var b = new SchemaBuilder(SchemaId);
            b.SetSchemaName("FMC_LiveData");
            b.SetDocumentation("Formcraft: Keep FMC data filled, switched per project by the BIM Manager.");
            b.SetReadAccessLevel(AccessLevel.Public);
            b.SetWriteAccessLevel(AccessLevel.Public);
            b.SetVendorId("Formcraft");
            b.AddSimpleField(FieldEnabled, typeof(bool));
            b.AddSimpleField(FieldBy, typeof(string));
            b.AddSimpleField(FieldAt, typeof(string));
            return b.Finish();
        }

        /// <summary>The switch on this model; off for families, links and models that never had it.</summary>
        public static State Read(Document doc)
        {
            var state = new State();
            if (doc == null || doc.IsFamilyDocument || doc.IsLinked) return state;
            Schema s = Schema.Lookup(SchemaId);
            if (s == null) return state;
            ProjectInfo info = doc.ProjectInformation;
            if (info == null) return state;
            Entity e = info.GetEntity(s);
            if (e == null || !e.IsValid()) return state;
            state.Enabled = e.Get<bool>(FieldEnabled);
            state.By = e.Get<string>(FieldBy) ?? "";
            state.At = e.Get<string>(FieldAt) ?? "";
            return state;
        }

        public static bool IsOn(Document doc)
        {
            try { return Read(doc).Enabled; }
            catch (Exception) { return false; }
        }

        /// <summary>
        /// Sets the switch in its own transaction (one Undo). Returns "" when done, else why not. Never saves or
        /// synchronises (rule 6): in a workshared model the person syncs so the team gets it.
        /// </summary>
        public static string Write(Document doc, bool on, string by)
        {
            if (doc == null) return "Open a project model first.";
            if (doc.IsFamilyDocument) return "Keep FMC data filled is for project models, not families.";
            if (doc.IsLinked) return "This is a linked model; open it to change its setting.";
            if (doc.IsReadOnly) return "This model is read-only.";
            ProjectInfo info = doc.ProjectInformation;
            if (info == null) return "This model has no Project Information.";
            if (doc.IsWorkshared && WorksharingUtils.GetCheckoutStatus(doc, info.Id) == CheckoutStatus.OwnedByOtherUser)
                return "Someone else is editing Project Information. Ask them to sync and relinquish, then try again.";

            using (var t = new Transaction(doc, on ? "Formcraft: keep FMC data filled on" : "Formcraft: keep FMC data filled off"))
            {
                t.Start();
                Schema s = GetOrCreateSchema();
                var e = new Entity(s);
                e.Set(FieldEnabled, on);
                e.Set(FieldBy, by ?? "");
                e.Set(FieldAt, DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss", System.Globalization.CultureInfo.InvariantCulture));
                info.SetEntity(e);
                if (t.Commit() != TransactionStatus.Committed) return "Revit didn't accept the change.";
            }
            return "";
        }
    }
}
