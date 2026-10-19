using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// E1 MEP calculations (fmc_mep_facts), read-only: the facts the server's calcs need (server/src/fmc/calc). Rooms and
    /// spaces with area, occupancy and FMC_Design_Population; plumbing fixtures with FMC_Discharge_Units; piping systems;
    /// tanks (FMC_Tank_Capacity_L); extinguishers and hose reels (FMC_Extinguisher_Rating, FMC_Hose_Length_m); lightning
    /// protection parts (FMC_LP_Part, FMC_Earth_Resistance_Ohm); power circuits with voltage, current, loads, length and wire
    /// size. Opens no transaction and changes nothing: the engineer sizes and signs.
    /// </summary>
    public partial class FmcSystemsEventHandler
    {
        private const int MepCap = 5000;

        private static JObject Mep(Document doc)
        {
            // Rooms and spaces
            var rooms = new JArray();
            foreach (SpatialElement se in new FilteredElementCollector(doc).OfClass(typeof(SpatialElement)).Cast<SpatialElement>())
            {
                if (!(se is Room) && !(se is Space)) continue;
                if (se.Area <= 0 || rooms.Count >= MepCap) continue;
                XYZ pt = (se.Location as LocationPoint)?.Point;
                string occupancy = se.get_Parameter(BuiltInParameter.ROOM_OCCUPANCY)?.AsString() ?? se.LookupParameter("Occupancy")?.AsString() ?? "";
                rooms.Add(new JObject
                {
                    ["id"] = se.Id.Value,
                    ["kind"] = se is Room ? "room" : "space",
                    ["name"] = se.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString() ?? se.Name,
                    ["number"] = se.Number ?? "",
                    ["level"] = se.Level?.Name ?? "",
                    ["area_m2"] = Math.Round(UnitUtils.ConvertFromInternalUnits(se.Area, UnitTypeId.SquareMeters), 2),
                    ["population"] = NumberOf(se, "FMC_Design_Population"),
                    ["occupancy"] = occupancy,
                    ["x_mm"] = pt == null ? null : (JToken)Math.Round(pt.X * FeetToMm),
                    ["y_mm"] = pt == null ? null : (JToken)Math.Round(pt.Y * FeetToMm),
                });
            }

            // Plumbing fixtures
            var fixtures = new JArray();
            foreach (FamilyInstance fi in Instances(doc, BuiltInCategory.OST_PlumbingFixtures))
            {
                if (fixtures.Count >= MepCap) break;
                fixtures.Add(new JObject
                {
                    ["id"] = fi.Id.Value, ["family"] = fi.Symbol?.FamilyName ?? "", ["type"] = fi.Symbol?.Name ?? "",
                    ["level"] = LevelName(doc, fi), ["room"] = RoomNumber(fi),
                    ["du"] = NumberOf(fi, "FMC_Discharge_Units"),
                    ["pipe_system"] = TextOf(fi, "FMC_Pipe_System"),
                });
            }

            var pipeSystems = new JArray();
            foreach (PipingSystem ps in new FilteredElementCollector(doc).OfClass(typeof(PipingSystem)).Cast<PipingSystem>().Take(MepCap))
                pipeSystems.Add(new JObject
                {
                    ["id"] = ps.Id.Value, ["name"] = ps.Name,
                    ["classification"] = ps.get_Parameter(BuiltInParameter.RBS_SYSTEM_CLASSIFICATION_PARAM)?.AsString() ?? "",
                });

            // Tanks, extinguishers, hose reels and lightning protection parts: by the kit's parameters
            var tanks = new JArray();
            var fire = new JArray();
            var lp = new JArray();
            var cats = new List<BuiltInCategory> { BuiltInCategory.OST_SpecialityEquipment, BuiltInCategory.OST_MechanicalEquipment, BuiltInCategory.OST_GenericModel,
                BuiltInCategory.OST_ElectricalEquipment, BuiltInCategory.OST_PlumbingFixtures, BuiltInCategory.OST_Sprinklers };
            foreach (FamilyInstance fi in new FilteredElementCollector(doc).WherePasses(new ElementMulticategoryFilter(cats))
                         .WhereElementIsNotElementType().OfType<FamilyInstance>())
            {
                string family = fi.Symbol?.FamilyName ?? "", type = fi.Symbol?.Name ?? "", words = (family + " " + type).ToLowerInvariant();
                JToken capacity = NumberOf(fi, "FMC_Tank_Capacity_L");
                if (capacity.Type != JTokenType.Null && tanks.Count < MepCap)
                    tanks.Add(new JObject { ["id"] = fi.Id.Value, ["family"] = family, ["type"] = type, ["capacity_l"] = capacity });

                string rating = TextOf(fi, "FMC_Extinguisher_Rating");
                JToken hose = NumberOf(fi, "FMC_Hose_Length_m");
                string kind = rating.Length > 0 || words.Contains("extinguisher") ? "extinguisher"
                    : hose.Type != JTokenType.Null || words.Contains("hose reel") || words.Contains("hosereel") || words.Contains("hose_reel") ? "hose_reel" : "";
                if (kind.Length > 0 && fire.Count < MepCap)
                {
                    XYZ pt = (fi.Location as LocationPoint)?.Point;
                    fire.Add(new JObject
                    {
                        ["id"] = fi.Id.Value, ["kind"] = kind, ["family"] = family, ["type"] = type, ["level"] = LevelName(doc, fi),
                        ["rating"] = rating, ["hose_length_m"] = hose,
                        ["x_mm"] = pt == null ? null : (JToken)Math.Round(pt.X * FeetToMm), ["y_mm"] = pt == null ? null : (JToken)Math.Round(pt.Y * FeetToMm),
                    });
                }

                string part = TextOf(fi, "FMC_LP_Part");
                JToken ohm = NumberOf(fi, "FMC_Earth_Resistance_Ohm");
                if ((part.Length > 0 || ohm.Type != JTokenType.Null) && lp.Count < MepCap)
                    lp.Add(new JObject
                    {
                        ["id"] = fi.Id.Value, ["family"] = family, ["type"] = type, ["part"] = part,
                        ["mark"] = fi.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString() ?? "", ["level"] = LevelName(doc, fi),
                        ["earth_resistance_ohm"] = ohm,
                    });
            }

            // Power circuits: loads, voltage, current, length and wire size as Revit has them
            var circuits = new JArray();
            foreach (ElectricalSystem s in new FilteredElementCollector(doc).OfClass(typeof(ElectricalSystem)).Cast<ElectricalSystem>())
            {
                if (s.SystemType != ElectricalSystemType.PowerCircuit || circuits.Count >= MepCap) continue;
                bool feedsBoard = false;
                try
                {
                    foreach (Element e in s.Elements)
                        if (e.Category != null && e.Category.Id.Value == (long)BuiltInCategory.OST_ElectricalEquipment) { feedsBoard = true; break; }
                }
                catch (Exception) { /* no elements: a spare */ }
                circuits.Add(new JObject
                {
                    ["id"] = s.Id.Value,
                    ["board"] = s.BaseEquipment == null ? "" : (s.PanelName ?? ""),
                    ["number"] = s.CircuitNumber ?? "",
                    ["load_name"] = s.LoadName ?? "",
                    ["classes"] = LoadClasses(s),
                    ["voltage_v"] = Measure(s, BuiltInParameter.RBS_ELEC_VOLTAGE, UnitTypeId.Volts, 1),
                    ["current_a"] = Measure(s, BuiltInParameter.RBS_ELEC_APPARENT_CURRENT_PARAM, UnitTypeId.Amperes, 2),
                    ["true_load_w"] = Measure(s, BuiltInParameter.RBS_ELEC_TRUE_LOAD, UnitTypeId.Watts, 1),
                    ["apparent_load_va"] = Measure(s, BuiltInParameter.RBS_ELEC_APPARENT_LOAD, UnitTypeId.VoltAmperes, 1),
                    ["length_m"] = Measure(s, BuiltInParameter.RBS_ELEC_CIRCUIT_LENGTH_PARAM, UnitTypeId.Meters, 2),
                    ["wire_size"] = s.get_Parameter(BuiltInParameter.RBS_ELEC_CIRCUIT_WIRE_SIZE_PARAM)?.AsString() ?? "",
                    ["rating_a"] = Measure(s, BuiltInParameter.RBS_ELEC_CIRCUIT_RATING_PARAM, UnitTypeId.Amperes, 1),
                    ["poles"] = s.PolesNumber,
                    ["feeds_board"] = feedsBoard,
                    ["cable_spec"] = TextOf(s, "FMC_Cable_Spec"),
                });
            }

            return new JObject
            {
                ["rooms"] = rooms, ["plumbing_fixtures"] = fixtures, ["pipe_systems"] = pipeSystems, ["tanks"] = tanks,
                ["fire_devices"] = fire, ["lp_parts"] = lp, ["circuits"] = circuits,
                ["counts"] = new JObject
                {
                    ["rooms"] = rooms.Count, ["plumbing_fixtures"] = fixtures.Count, ["pipe_systems"] = pipeSystems.Count, ["tanks"] = tanks.Count,
                    ["fire_devices"] = fire.Count, ["lp_parts"] = lp.Count, ["circuits"] = circuits.Count,
                    ["mep"] = fixtures.Count + pipeSystems.Count + tanks.Count + fire.Count + lp.Count + circuits.Count,
                },
            };
        }

        private static IEnumerable<FamilyInstance> Instances(Document doc, BuiltInCategory cat) =>
            new FilteredElementCollector(doc).OfCategory(cat).WhereElementIsNotElementType().OfType<FamilyInstance>();

        /// <summary>The circuit's load classifications as Revit lists them ("Lighting", "Lighting; Power").</summary>
        private static string LoadClasses(ElectricalSystem s)
        {
            try { return s.LoadClassifications ?? ""; }
            catch (Exception) { return s.LookupParameter("Load Classification")?.AsString() ?? ""; }
        }

        private static JToken Measure(Element e, BuiltInParameter bip, ForgeTypeId unit, int digits)
        {
            Parameter p = e.get_Parameter(bip);
            if (p == null || !p.HasValue || p.StorageType != StorageType.Double) return JValue.CreateNull();
            return new JValue(Math.Round(UnitUtils.ConvertFromInternalUnits(p.AsDouble(), unit), digits));
        }

        /// <summary>A kit number on the instance or its type, as stored (kit NUMBER and INTEGER fields carry no unit); null when empty.</summary>
        private static JToken NumberOf(Element e, string name)
        {
            Parameter p = e.LookupParameter(name);
            if ((p == null || !p.HasValue) && e is FamilyInstance fi) p = fi.Symbol?.LookupParameter(name);
            if (p == null || !p.HasValue) return JValue.CreateNull();
            switch (p.StorageType)
            {
                case StorageType.Double: return new JValue(Math.Round(p.AsDouble(), 4));
                case StorageType.Integer: return new JValue(p.AsInteger());
                case StorageType.String:
                    return double.TryParse(p.AsString(), NumberStyles.Float, CultureInfo.InvariantCulture, out double d) ? new JValue(d) : JValue.CreateNull();
                default: return JValue.CreateNull();
            }
        }

        private static string TextOf(Element e, string name)
        {
            Parameter p = e.LookupParameter(name);
            if ((p == null || !p.HasValue) && e is FamilyInstance fi) p = fi.Symbol?.LookupParameter(name);
            if (p == null || !p.HasValue) return "";
            return (p.StorageType == StorageType.String ? p.AsString() : p.AsValueString()) ?? "";
        }

        private static string LevelName(Document doc, FamilyInstance fi)
        {
            if (doc.GetElement(fi.LevelId) is Level l) return l.Name;
            if (fi.Host is Level h) return h.Name;
            ElementId sched = fi.get_Parameter(BuiltInParameter.INSTANCE_SCHEDULE_ONLY_LEVEL_PARAM)?.AsElementId() ?? ElementId.InvalidElementId;
            return (doc.GetElement(sched) as Level)?.Name ?? "";
        }

        private static string RoomNumber(FamilyInstance fi)
        {
            try { return fi.Room?.Number ?? fi.Space?.Number ?? ""; }
            catch (Exception) { return ""; }
        }
    }
}
