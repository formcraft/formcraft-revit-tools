using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Start from brief (U23) on the Revit main thread: on a NEW, unsaved model only, creates the CIS levels (with a floor
    /// plan each), sets Project Information values, creates the room programme as unplaced rooms with their data, and
    /// loads the approved kit families. All in one TransactionGroup (one Undo); a dry run rolls it back and reports the
    /// counts. Never geometry, never a save. The server has already checked every parameter name against the kit.
    /// </summary>
    public class FmcBriefEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double MmToFeet = 1 / 304.8;
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public string GetName() => "FMC start from brief";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using var target = FmcTarget.Resolve(app, Parameters, mayOpen: false);
                Document doc = target.Doc;
                if (doc.IsFamilyDocument) throw new InvalidOperationException("Start from brief sets up a project model, not a family.");
                if (!string.IsNullOrEmpty(doc.PathName)) throw new InvalidOperationException($"{doc.Title} is saved: Start from brief runs only on a new, unsaved model.");
                if (doc.IsWorkshared) throw new InvalidOperationException($"{doc.Title} is workshared: Start from brief runs only on a new, unsaved model.");
                Result = Apply(doc, Parameters);
            }
            catch (Exception ex)
            {
                Error = ex.Message;
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        private static JObject Apply(Document doc, JObject p)
        {
            bool dry = p.Value<bool?>("dry_run") ?? true;
            var notes = new JArray();
            int levelsCreated = 0, viewsCreated = 0, infoSet = 0, roomsCreated = 0, roomValues = 0, familiesLoaded = 0;
            using (var group = new TransactionGroup(doc, "Formcraft: start from brief"))
            {
                group.Start();

                using (var t = new Transaction(doc, "Brief: levels"))
                {
                    t.Start();
                    var levels = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().ToList();
                    ViewFamilyType planType = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>()
                        .FirstOrDefault(v => v.ViewFamily == ViewFamily.FloorPlan);
                    foreach (JObject l in (p["levels"] as JArray ?? new JArray()).OfType<JObject>())
                    {
                        string name = l.Value<string>("name") ?? "";
                        double elev = (l.Value<double?>("elevation_mm") ?? 0) * MmToFeet;
                        Level same = levels.FirstOrDefault(x => string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase));
                        if (same != null)
                        {
                            if (Math.Abs(same.Elevation - elev) > 1e-4)
                                notes.Add($"Level {name} is already in the model at {Math.Round(same.Elevation / MmToFeet)} mm: left as it is");
                            continue;
                        }
                        Level atHeight = levels.FirstOrDefault(x => Math.Abs(x.Elevation - elev) < 1e-4);
                        if (atHeight != null)
                        {
                            notes.Add($"{atHeight.Name} at {Math.Round(elev / MmToFeet)} mm renamed {name}");
                            atHeight.Name = name;
                            continue;
                        }
                        Level created = Level.Create(doc, elev);
                        created.Name = name;
                        levels.Add(created);
                        levelsCreated++;
                        if (planType != null)
                        {
                            ViewPlan plan = ViewPlan.Create(doc, planType.Id, created.Id);
                            try { plan.Name = name; } catch (Autodesk.Revit.Exceptions.ArgumentException) { /* a view already has the name */ }
                            viewsCreated++;
                        }
                    }
                    t.Commit();
                }

                using (var t = new Transaction(doc, "Brief: project information"))
                {
                    t.Start();
                    foreach (var kv in (p["project_info"] as JObject ?? new JObject()).Properties())
                    {
                        Parameter par = doc.ProjectInformation.LookupParameter(kv.Name);
                        string why = SetValue(par, kv.Value.ToString());
                        if (why == "") infoSet++;
                        else notes.Add($"Project Information {kv.Name}: {why}");
                    }
                    t.Commit();
                }

                using (var t = new Transaction(doc, "Brief: rooms"))
                {
                    t.Start();
                    Phase phase = doc.Phases.Size > 0 ? doc.Phases.get_Item(doc.Phases.Size - 1) : null;
                    var existing = new HashSet<string>(new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms).WhereElementIsNotElementType()
                        .Cast<Room>().Select(r => r.Number), StringComparer.OrdinalIgnoreCase);
                    var missing = new HashSet<string>();
                    foreach (JObject r in (p["rooms"] as JArray ?? new JArray()).OfType<JObject>())
                    {
                        string number = r.Value<string>("number") ?? "";
                        if (existing.Contains(number)) { notes.Add($"Room {number} is already in the model: left as it is"); continue; }
                        if (phase == null) { notes.Add("The model has no phase, so no rooms were created"); break; }
                        Room room = doc.Create.NewRoom(phase);
                        room.Number = number;
                        room.Name = r.Value<string>("name") ?? "";
                        roomsCreated++;
                        foreach (var kv in (r["params"] as JObject ?? new JObject()).Properties())
                        {
                            string why = SetValue(room.LookupParameter(kv.Name), kv.Value.ToString());
                            if (why == "") roomValues++;
                            else if (missing.Add(kv.Name + why)) notes.Add($"Rooms {kv.Name}: {why}");
                        }
                    }
                    t.Commit();
                }

                using (var t = new Transaction(doc, "Brief: families"))
                {
                    t.Start();
                    foreach (string path in (p["families"] as JArray ?? new JArray()).Select(x => x.ToString()))
                    {
                        if (!File.Exists(path)) { notes.Add($"{Path.GetFileName(path)}: not found"); continue; }
                        if (doc.LoadFamily(path, out Family _)) familiesLoaded++;
                        else notes.Add($"{Path.GetFileNameWithoutExtension(path)}: already in the model");
                    }
                    t.Commit();
                }

                if (dry) group.RollBack(); else group.Assimilate();
            }
            return new JObject
            {
                ["dry_run"] = dry, ["model"] = doc.Title,
                ["levels_created"] = levelsCreated, ["plans_created"] = viewsCreated, ["project_info_set"] = infoSet,
                ["rooms_created"] = roomsCreated, ["room_values_set"] = roomValues, ["families_loaded"] = familiesLoaded,
                ["notes"] = notes,
            };
        }

        /// <summary>Sets a value in the model's own units; "" when it was set, otherwise why not.</summary>
        private static string SetValue(Parameter par, string value)
        {
            if (par == null) return "not in this model (load the kit's shared parameters with the template first)";
            if (par.IsReadOnly) return "read-only";
            switch (par.StorageType)
            {
                case StorageType.String: return par.Set(value) ? "" : "Revit refused the value";
                case StorageType.Integer:
                    return int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out int i) && par.Set(i) ? "" : $"'{value}' isn't a whole number";
                case StorageType.Double:
                    try { if (par.SetValueString(value)) return ""; } catch (Exception) { /* fall back to a plain number */ }
                    return double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out double d) && par.Set(d) ? "" : $"'{value}' isn't a number";
                default: return "can't be set from text";
            }
        }
    }
}
