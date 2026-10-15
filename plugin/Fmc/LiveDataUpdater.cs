using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;

namespace revit_mcp_plugin.Fmc
{
    /// <summary>
    /// "Keep FMC data filled" (owner's decision of 15 Oct 2026, docs/LIVE_DATA.md): a Revit dynamic model updater that
    /// fills derived FMC fields as people model, so the kit's schedules stay complete without running a script. It runs
    /// only in project models whose BIM Manager switched it on (LiveDataSwitch), fills only fields that are copies or
    /// look-ups of other values (LiveDataRules.Fields), never a size, rating, load, demand factor or anything a
    /// professional decides (CLAUDE.md rule 5), skips what someone else is editing in a workshared model, and never saves
    /// or synchronises (rule 6). Its writes are part of the person's own change (one Undo) and every one is logged.
    /// </summary>
    public sealed class LiveDataUpdater : IUpdater
    {
        public static readonly Guid Guid = new Guid("2b96207d-f27a-4205-bcd9-8f2edffb5286");

        private readonly UpdaterId _id;
        private readonly Func<string> _kitFolder;

        public LiveDataUpdater(AddInId addIn, Func<string> kitFolder)
        {
            _id = new UpdaterId(addIn, Guid);
            _kitFolder = kitFolder ?? (() => @"Z:\00_Standards");
        }

        /// <summary>Model categories whose elements and types can carry FMC fields.</summary>
        private static readonly BuiltInCategory[] ModelCategories =
        {
            BuiltInCategory.OST_Walls, BuiltInCategory.OST_Floors, BuiltInCategory.OST_Roofs, BuiltInCategory.OST_Ceilings,
            BuiltInCategory.OST_Doors, BuiltInCategory.OST_Windows, BuiltInCategory.OST_Furniture, BuiltInCategory.OST_FurnitureSystems,
            BuiltInCategory.OST_Casework, BuiltInCategory.OST_GenericModel, BuiltInCategory.OST_Columns,
            BuiltInCategory.OST_StructuralColumns, BuiltInCategory.OST_StructuralFraming, BuiltInCategory.OST_StructuralFoundation,
            BuiltInCategory.OST_Stairs, BuiltInCategory.OST_StairsRailing, BuiltInCategory.OST_CurtainWallPanels,
            BuiltInCategory.OST_CurtainWallMullions, BuiltInCategory.OST_PlumbingFixtures, BuiltInCategory.OST_SpecialityEquipment,
            BuiltInCategory.OST_MechanicalEquipment, BuiltInCategory.OST_ElectricalEquipment, BuiltInCategory.OST_ElectricalFixtures,
            BuiltInCategory.OST_LightingFixtures, BuiltInCategory.OST_LightingDevices, BuiltInCategory.OST_FireAlarmDevices,
            BuiltInCategory.OST_DataDevices, BuiltInCategory.OST_CommunicationDevices, BuiltInCategory.OST_SecurityDevices,
            BuiltInCategory.OST_NurseCallDevices, BuiltInCategory.OST_TelephoneDevices, BuiltInCategory.OST_Sprinklers,
            BuiltInCategory.OST_PipeCurves, BuiltInCategory.OST_PipeFitting, BuiltInCategory.OST_PipeAccessory,
            BuiltInCategory.OST_DuctCurves, BuiltInCategory.OST_DuctFitting, BuiltInCategory.OST_DuctAccessory,
            BuiltInCategory.OST_DuctTerminal, BuiltInCategory.OST_CableTray, BuiltInCategory.OST_Conduit,
            BuiltInCategory.OST_Site, BuiltInCategory.OST_Planting, BuiltInCategory.OST_Parking,
        };

        /// <summary>Devices and fixtures that sit on a power circuit (FMC_Circuit_Ref).</summary>
        private static readonly BuiltInCategory[] CircuitCategories =
        {
            BuiltInCategory.OST_ElectricalFixtures, BuiltInCategory.OST_LightingFixtures, BuiltInCategory.OST_LightingDevices,
            BuiltInCategory.OST_MechanicalEquipment, BuiltInCategory.OST_FireAlarmDevices, BuiltInCategory.OST_DataDevices,
            BuiltInCategory.OST_CommunicationDevices, BuiltInCategory.OST_SecurityDevices, BuiltInCategory.OST_NurseCallDevices,
            BuiltInCategory.OST_TelephoneDevices, BuiltInCategory.OST_SpecialityEquipment,
        };

        /// <summary>
        /// Called from OnStartup: registers the updater as optional (a model opened where the add-in isn't installed
        /// opens without a warning) with its triggers. Whether it does anything is decided per model, inside Execute.
        /// </summary>
        public static void Register(UIControlledApplication application, Func<string> kitFolder)
        {
            var updater = new LiveDataUpdater(application.ActiveAddInId, kitFolder);
            UpdaterId id = updater.GetUpdaterId();
            if (UpdaterRegistry.IsUpdaterRegistered(id)) return;
            UpdaterRegistry.RegisterUpdater(updater, true);

            var model = new ElementMulticategoryFilter(ModelCategories.ToList());
            UpdaterRegistry.AddTrigger(id, model, Element.GetChangeTypeElementAddition());
            UpdaterRegistry.AddTrigger(id, model, Element.GetChangeTypeParameter(new ElementId(BuiltInParameter.KEYNOTE_PARAM)));
            UpdaterRegistry.AddTrigger(id, model, Element.GetChangeTypeParameter(new ElementId(BuiltInParameter.ELEM_TYPE_PARAM)));
            UpdaterRegistry.AddTrigger(id, model, Element.GetChangeTypeParameter(new ElementId(BuiltInParameter.ELEM_FAMILY_AND_TYPE_PARAM)));

            var equipment = new ElementCategoryFilter(BuiltInCategory.OST_ElectricalEquipment);
            UpdaterRegistry.AddTrigger(id, equipment, Element.GetChangeTypeParameter(new ElementId(BuiltInParameter.RBS_ELEC_PANEL_NAME)));

            // A device joining a circuit, or a circuit renumbered or moved to another board, changes the circuit element.
            var circuits = new ElementCategoryFilter(BuiltInCategory.OST_ElectricalCircuit);
            UpdaterRegistry.AddTrigger(id, circuits, Element.GetChangeTypeElementAddition());
            UpdaterRegistry.AddTrigger(id, circuits, Element.GetChangeTypeAny());
        }

        public UpdaterId GetUpdaterId() => _id;
        public ChangePriority GetChangePriority() => ChangePriority.Annotations;
        public string GetUpdaterName() => "Formcraft: keep FMC data filled";

        public string GetAdditionalInformation() =>
            "Fills derived FMC fields (keynote code, code description and group, role code, panel ID, circuit reference, " +
            "sync stamp) when the BIM Manager has switched it on for the project. Without the Formcraft add-in the model " +
            "opens and works as usual; the fields just aren't filled.";

        public void Execute(UpdaterData data)
        {
            // An updater must never throw: Revit would switch it off for the session and show the person a dialog.
            Run run = null;
            try
            {
                Document doc = data.GetDocument();
                if (doc == null || doc.IsFamilyDocument || doc.IsLinked || doc.IsReadOnly) return;
                if (!LiveDataSwitch.IsOn(doc)) return;
                run = new Run(doc, LiveDataKit.Get(_kitFolder()));
                foreach (ElementId id in data.GetAddedElementIds()) run.Visit(id);
                foreach (ElementId id in data.GetModifiedElementIds()) run.Visit(id);
            }
            catch (Exception)
            {
                // Whatever was written before the problem is logged below; the rest waits for the next change.
            }
            finally
            {
                if (run != null) LiveDataLog.Append(run.Lines);
            }
        }

        /// <summary>One Execute: the elements seen, the values written and the log rows.</summary>
        private sealed class Run
        {
            private readonly Document _doc;
            private readonly LiveDataKit _kit;
            private readonly string _model;
            private readonly string _role;
            private readonly string _stamp;
            private readonly HashSet<ElementId> _seen = new HashSet<ElementId>();
            private readonly ElementId _equipment = new ElementId(BuiltInCategory.OST_ElectricalEquipment);
            private readonly ElementId _circuit = new ElementId(BuiltInCategory.OST_ElectricalCircuit);
            private readonly HashSet<ElementId> _onCircuits;
            public readonly List<string> Lines = new List<string>();

            public Run(Document doc, LiveDataKit kit)
            {
                _doc = doc;
                _kit = kit;
                _model = doc.Title ?? "";
                _role = LiveDataRules.RoleFromModelName(ModelFileName(doc));
                _stamp = LiveDataRules.Stamp(kit.Version, DateTime.Now);
                _onCircuits = new HashSet<ElementId>(CircuitCategories.Select(c => new ElementId(c)));
            }

            /// <summary>The file name that carries the role: the central model's for a workshared local copy.</summary>
            private static string ModelFileName(Document doc)
            {
                try
                {
                    if (doc.IsWorkshared)
                    {
                        ModelPath central = doc.GetWorksharingCentralModelPath();
                        if (central != null)
                        {
                            string p = ModelPathUtils.ConvertModelPathToUserVisiblePath(central);
                            if (!string.IsNullOrEmpty(p)) return p;
                        }
                    }
                }
                catch (Exception) { }
                return string.IsNullOrEmpty(doc.PathName) ? doc.Title : doc.PathName;
            }

            public void Visit(ElementId id)
            {
                Element e = _doc.GetElement(id);
                if (e == null) return;
                if (e is ElectricalSystem system)
                {
                    if (!Same(e.Category, _circuit)) return;
                    foreach (Element member in system.Elements) VisitInstance(member);
                    return;
                }
                if (e is ElementType type)
                {
                    VisitType(type);
                    return;
                }
                VisitInstance(e);
                ElementId typeId = e.GetTypeId();
                if (typeId != null && typeId != ElementId.InvalidElementId && _doc.GetElement(typeId) is ElementType t) VisitType(t);

#if REVIT2024_OR_GREATER
                // A board renamed: every device on its circuits gets the new panel in its circuit reference.
                if (Same(e.Category, _equipment) && e is FamilyInstance board && board.MEPModel != null)
                {
                    ISet<ElectricalSystem> assigned = board.MEPModel.GetAssignedElectricalSystems();
                    if (assigned != null)
                        foreach (ElectricalSystem c in assigned)
                            foreach (Element member in c.Elements) VisitInstance(member);
                }
#endif
            }

            private void VisitType(ElementType t)
            {
                if (!_seen.Add(t.Id) || !Editable(t)) return;
                bool wrote = false;

                // FMC_Keynote_Code is a copy of the type's Keynote (what FMC_SyncMasterData.py did by hand).
                string keynote = t.get_Parameter(BuiltInParameter.KEYNOTE_PARAM)?.AsString() ?? "";
                wrote |= Write(t, LiveDataRules.KeynoteCode, keynote, true);
                string code = keynote.Trim().Length > 0 ? keynote.Trim() : (t.LookupParameter(LiveDataRules.KeynoteCode)?.AsString() ?? "").Trim();

                // Description and group are look-ups of the code in the kit; a code the kit doesn't have gets nothing.
                LiveDataRules.KitCode k;
                if (code.Length > 0 && _kit.Codes.TryGetValue(code, out k))
                {
                    wrote |= Write(t, LiveDataRules.CodeDescription, k.Description, true);
                    wrote |= Write(t, LiveDataRules.CodeGroup, k.Group, true);
                }

                wrote |= Write(t, LiveDataRules.RoleCode, _role, false);
                if (wrote) Write(t, LiveDataRules.SyncStamp, _stamp, true);
            }

            private void VisitInstance(Element e)
            {
                if (e == null || e is ElementType || !_seen.Add(e.Id) || !Editable(e)) return;
                // An element in a group changes every copy of the group: leave grouped elements to the person.
                if (e.GroupId != null && e.GroupId != ElementId.InvalidElementId) return;
                bool wrote = false;

                wrote |= Write(e, LiveDataRules.RoleCode, _role, false);

                if (Same(e.Category, _equipment))
                {
                    string panel = e.get_Parameter(BuiltInParameter.RBS_ELEC_PANEL_NAME)?.AsString() ?? "";
                    wrote |= Write(e, LiveDataRules.PanelId, panel, false);
                }

                if (e.Category != null && _onCircuits.Contains(e.Category.Id))
                    wrote |= Write(e, LiveDataRules.CircuitRef, CircuitRef(e), true);

                if (wrote) Write(e, LiveDataRules.SyncStamp, _stamp, true);
            }

            /// <summary>The element's power circuit as "&lt;panel&gt;/&lt;circuit number&gt;", or "" on no circuit.</summary>
            private static string CircuitRef(Element e)
            {
#if REVIT2024_OR_GREATER
                if (e is FamilyInstance fi && fi.MEPModel != null)
                {
                    ISet<ElectricalSystem> systems = fi.MEPModel.GetElectricalSystems();
                    ElectricalSystem power = systems?.FirstOrDefault(s => s.SystemType == ElectricalSystemType.PowerCircuit);
                    if (power != null) return LiveDataRules.CircuitRefFor(power.PanelName, power.CircuitNumber);
                }
#endif
                return LiveDataRules.CircuitRefFor(
                    e.get_Parameter(BuiltInParameter.RBS_ELEC_CIRCUIT_PANEL_PARAM)?.AsString(),
                    e.get_Parameter(BuiltInParameter.RBS_ELEC_CIRCUIT_NUMBER)?.AsString());
            }

            /// <summary>Workshared: skip what someone else is editing, and what changed in central since the last reload.</summary>
            private bool Editable(Element e)
            {
                if (!_doc.IsWorkshared) return true;
                try
                {
                    if (WorksharingUtils.GetCheckoutStatus(_doc, e.Id) == CheckoutStatus.OwnedByOtherUser) return false;
                    ModelUpdatesStatus s = WorksharingUtils.GetModelUpdatesStatus(_doc, e.Id);
                    return s != ModelUpdatesStatus.UpdatedInCentral && s != ModelUpdatesStatus.DeletedInCentral;
                }
                catch (Exception) { return false; }
            }

            /// <summary>Writes one text field when the element has it and LiveDataRules says so; logs the change.</summary>
            private bool Write(Element e, string field, string value, bool pureCopy)
            {
                Parameter p = e.LookupParameter(field);
                if (p == null || p.IsReadOnly || p.StorageType != StorageType.String) return false;
                string old = p.AsString() ?? "";
                if (!LiveDataRules.ShouldWrite(old, value, pureCopy)) return false;
                try
                {
                    if (!p.Set(value)) return false;
                }
                catch (Exception) { return false; }
                Lines.Add(LiveDataRules.LogLine(DateTime.Now, _model, e.Id.ToString(), field, old, value));
                return true;
            }

            private static bool Same(Category c, ElementId id) => c != null && c.Id.Equals(id);
        }
    }

    /// <summary>
    /// The kit values the updater looks up (rule 7: from the kit, never from code): the kit version (FMC_Kit.json) and
    /// each code's description and group (03_Master_Data\FMC_Master_Data.json "codes"; for a code only in the keynote
    /// file, 02_Keynotes\FMC_Keynotes.txt gives the description). Read once and again when a file changes, checked at
    /// most every 30 seconds, so Execute stays cheap.
    /// </summary>
    public sealed class LiveDataKit
    {
        private static readonly object Gate = new object();
        private static LiveDataKit _cached;
        private static DateTime _checked;

        public string Folder { get; private set; } = "";
        public string Version { get; private set; } = "";
        public Dictionary<string, LiveDataRules.KitCode> Codes { get; private set; } = new Dictionary<string, LiveDataRules.KitCode>(StringComparer.Ordinal);
        public string Problem { get; private set; } = "";
        private string _signature = "";

        public static LiveDataKit Get(string folder)
        {
            folder = (folder ?? "").Trim();
            lock (Gate)
            {
                if (_cached != null && _cached.Folder == folder && (DateTime.UtcNow - _checked).TotalSeconds < 30) return _cached;
                _checked = DateTime.UtcNow;
                string sig = Signature(folder);
                if (_cached != null && _cached.Folder == folder && _cached._signature == sig) return _cached;
                _cached = Load(folder, sig);
                return _cached;
            }
        }

        private static string KitJson(string f) => Path.Combine(f, "FMC_Kit.json");
        private static string MasterJson(string f) => Path.Combine(f, "03_Master_Data", "FMC_Master_Data.json");
        private static string KeynoteFile(string f) => Path.Combine(f, "02_Keynotes", "FMC_Keynotes.txt");

        private static string Signature(string f)
        {
            if (f.Length == 0) return "";
            var b = new StringBuilder();
            foreach (string p in new[] { KitJson(f), MasterJson(f), KeynoteFile(f) })
            {
                try { b.Append(File.Exists(p) ? File.GetLastWriteTimeUtc(p).Ticks.ToString() : "-").Append('|'); }
                catch (Exception) { b.Append("?|"); }
            }
            return b.ToString();
        }

        private static LiveDataKit Load(string folder, string signature)
        {
            var kit = new LiveDataKit { Folder = folder, _signature = signature };
            if (folder.Length == 0 || !Directory.Exists(folder))
            {
                kit.Problem = "Kit folder not found";
                return kit;
            }
            try
            {
                if (File.Exists(KitJson(folder)))
                    kit.Version = JObject.Parse(File.ReadAllText(KitJson(folder)).TrimStart('\uFEFF')).Value<string>("kit") ?? "";
            }
            catch (Exception) { kit.Problem = "FMC_Kit.json can't be read"; }
            try
            {
                if (File.Exists(MasterJson(folder)) &&
                    JObject.Parse(File.ReadAllText(MasterJson(folder)).TrimStart('\uFEFF'))["codes"] is JObject codes)
                    foreach (JProperty c in codes.Properties())
                        if (c.Value is JObject v)
                            kit.Codes[c.Name.Trim()] = new LiveDataRules.KitCode(v.Value<string>("description"), v.Value<string>("group"));
            }
            catch (Exception) { kit.Problem = "FMC_Master_Data.json can't be read"; }
            try
            {
                if (File.Exists(KeynoteFile(folder)))
                    foreach (KeyValuePair<string, LiveDataRules.KitCode> k in LiveDataRules.ParseKeynotes(File.ReadAllText(KeynoteFile(folder))))
                        if (!kit.Codes.ContainsKey(k.Key)) kit.Codes[k.Key] = new LiveDataRules.KitCode(k.Value.Description, "");
            }
            catch (Exception) { }
            return kit;
        }
    }

    /// <summary>
    /// %APPDATA%\Formcraft\FMC_LiveData_Log.csv: timestamp, model, element id, field, old, new. Tools and results only,
    /// never who (Manual 14.5, CLAUDE.md rule 9).
    /// </summary>
    public static class LiveDataLog
    {
        private static readonly object Gate = new object();
        private static int _session;

        /// <summary>Values filled in this Revit session, for the pane's status line.</summary>
        public static int FilledThisSession => _session;

        public static string Path => LiveDataRules.DefaultLogPath();

        /// <summary>Appends rows; <paramref name="filled"/> false for rows that aren't filled values (the switch itself).</summary>
        public static void Append(IReadOnlyCollection<string> lines, bool filled = true)
        {
            if (lines == null || lines.Count == 0) return;
            lock (Gate)
            {
                if (filled) _session += lines.Count;
                for (int attempt = 0; attempt < 2; attempt++)
                {
                    try
                    {
                        string file = Path;
                        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(file));
                        bool fresh = !File.Exists(file);
                        var text = new StringBuilder();
                        if (fresh) text.Append(LiveDataRules.LogHeader).Append("\r\n");
                        foreach (string l in lines) text.Append(l).Append("\r\n");
                        File.AppendAllText(file, text.ToString(), new UTF8Encoding(false));
                        return;
                    }
                    catch (IOException) { System.Threading.Thread.Sleep(50); }
                    catch (Exception) { return; }
                }
            }
        }
    }
}
