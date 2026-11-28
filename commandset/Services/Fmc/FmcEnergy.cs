using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Analysis;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Envelope facts for an energy check: exterior walls and curtain walls, roofs, floors, windows, skylights and exterior
    /// doors, each with its type's U-value (heat transfer coefficient) or thermal resistance, SHGC and visible light
    /// transmittance as Revit holds them, the net area, the outward direction and the level. Also the project's angle to
    /// true north and the energy settings. Read-only: nothing is started, nothing is rolled back, no energy model is made and
    /// no parameter is written. The averages, UA, window-to-wall ratio and the checks are in the server
    /// (server/src/fmc/energy.ts), which has no Revit dependency and is unit tested. Thermal values are never guessed.
    /// </summary>
    public class FmcEnergyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double FeetToMm = 304.8;
        private const double SqFtToM2 = 0.09290304;
        private const int ElementCap = 20000;
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft energy";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_energy needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    var notes = new JArray();
                    var rows = new JArray();
                    var typeCache = new Dictionary<long, JObject>();
                    var wallKinds = new Dictionary<long, string>();
                    bool cut = false;
                    int interiorWalls = 0, interiorInserts = 0, unhosted = 0;

                    foreach (Wall wall in new FilteredElementCollector(doc).OfClass(typeof(Wall)).Cast<Wall>())
                    {
                        if (rows.Count >= ElementCap) { cut = true; break; }
                        WallType wt = wall.WallType;
                        if (wt == null || wt.Kind == WallKind.Stacked) continue; // stacked members are read on their own
                        if (wt.Function != WallFunction.Exterior) { interiorWalls++; continue; }
                        string kind = wt.Kind == WallKind.Curtain ? "curtain_wall" : "wall";
                        wallKinds[wall.Id.Value] = kind;
                        JObject row = Base(doc, wall, kind, typeCache);
                        row["area_m2"] = OrNull(Area(wall));
                        row["normal"] = Vec(SafeOrientation(wall));
                        rows.Add(row);
                    }

                    foreach (RoofBase roof in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Roofs).WhereElementIsNotElementType().OfType<RoofBase>())
                    {
                        if (rows.Count >= ElementCap) { cut = true; break; }
                        JObject row = Base(doc, roof, "roof", typeCache);
                        row["area_m2"] = OrNull(Area(roof));
                        row["normal"] = new JArray(0, 0, 1);
                        rows.Add(row);
                    }

                    foreach (Floor floor in new FilteredElementCollector(doc).OfClass(typeof(Floor)).WhereElementIsNotElementType().Cast<Floor>())
                    {
                        if (rows.Count >= ElementCap) { cut = true; break; }
                        JObject row = Base(doc, floor, "floor", typeCache);
                        row["area_m2"] = OrNull(Area(floor));
                        row["normal"] = new JArray(0, 0, -1);
                        Level level = doc.GetElement(floor.LevelId) as Level;
                        row["level"] = level?.Name ?? "";
                        row["level_elevation_mm"] = level == null ? JValue.CreateNull() : (JToken)Round(level.Elevation * FeetToMm);
                        rows.Add(row);
                    }

                    foreach (BuiltInCategory bic in new[] { BuiltInCategory.OST_Windows, BuiltInCategory.OST_Doors })
                    {
                        foreach (FamilyInstance fi in new FilteredElementCollector(doc).OfCategory(bic).WhereElementIsNotElementType().OfType<FamilyInstance>())
                        {
                            if (rows.Count >= ElementCap) { cut = true; break; }
                            Element host = fi.Host;
                            string hostKind;
                            XYZ normal;
                            if (host is Wall hw)
                            {
                                if (!wallKinds.TryGetValue(hw.Id.Value, out hostKind)) { interiorInserts++; continue; }
                                normal = SafeOrientation(hw);
                            }
                            else if (host is RoofBase) { hostKind = "roof"; normal = XYZ.BasisZ; }
                            else { unhosted++; hostKind = ""; normal = SafeFacing(fi); }
                            bool isDoor = bic == BuiltInCategory.OST_Doors;
                            string kind = isDoor ? "door" : hostKind == "roof" ? "skylight" : "window";
                            JObject row = Base(doc, fi, kind, typeCache);
                            row["area_m2"] = OrNull(InsertArea(fi, isDoor));
                            row["normal"] = Vec(normal);
                            row["host_id"] = host == null ? "" : host.Id.Value.ToString();
                            row["host_kind"] = hostKind;
                            rows.Add(row);
                        }
                    }

                    if (cut) notes.Add("The envelope list stopped at " + ElementCap + " elements.");
                    if (interiorWalls > 0) notes.Add(interiorWalls + " walls whose type Function is not Exterior were left out.");
                    if (interiorInserts > 0) notes.Add(interiorInserts + " windows or doors in non-exterior walls were left out.");
                    if (unhosted > 0) notes.Add(unhosted + " windows or doors have no wall or roof host; their facing direction is used.");
                    if (rows.Count == 0) notes.Add("No exterior walls, roofs, floors, windows or doors were found.");

                    Result = new JObject
                    {
                        ["read_only"] = true,
                        ["transaction"] = false,
                        ["applied"] = false,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                        ["is_central"] = FmcPhaseIds.IsCentral(doc),
                        ["true_north_angle_rad"] = TrueNorthAngle(doc),
                        ["energy_settings"] = Settings(doc),
                        ["notes"] = notes,
                        ["elements"] = rows,
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private static JObject Base(Document doc, Element element, string kind, Dictionary<long, JObject> typeCache)
        {
            var row = new JObject
            {
                ["id"] = element.Id.Value.ToString(),
                ["kind"] = kind,
                ["category"] = element.Category?.Name ?? "",
            };
            ElementId typeId = element.GetTypeId();
            if (typeId == null || typeId == ElementId.InvalidElementId) return row;
            if (!typeCache.TryGetValue(typeId.Value, out JObject facts))
            {
                facts = TypeFacts(doc, doc.GetElement(typeId));
                typeCache[typeId.Value] = facts;
            }
            foreach (var pair in facts) row[pair.Key] = pair.Value?.DeepClone();
            return row;
        }

        /// <summary>U from the type's heat transfer coefficient parameter, else ThermalProperties, else 1/R. 0 is sent as null.</summary>
        private static JObject TypeFacts(Document doc, Element type)
        {
            var facts = new JObject();
            if (type == null) return facts;
            facts["type_id"] = type.Id.Value.ToString();
            facts["type_name"] = type.Name ?? "";
            double? u = Si(type.get_Parameter(BuiltInParameter.ANALYTICAL_HEAT_TRANSFER_COEFFICIENT), UnitTypeId.WattsPerSquareMeterKelvin);
            double? r = Si(type.get_Parameter(BuiltInParameter.ANALYTICAL_THERMAL_RESISTANCE), UnitTypeId.SquareMeterKelvinsPerWatt);
            string source = u.HasValue ? "type_parameter" : "";
            if (!u.HasValue)
            {
                ThermalProperties tp = null;
                try
                {
                    if (type is WallType wt) tp = wt.ThermalProperties;
                    else if (type is FloorType ft) tp = ft.ThermalProperties;
                    else if (type is RoofType rt) tp = rt.ThermalProperties;
                }
                catch (Exception) { tp = null; }
                if (tp != null)
                {
                    double hu = UnitUtils.ConvertFromInternalUnits(tp.HeatTransferCoefficient, UnitTypeId.WattsPerSquareMeterKelvin);
                    double hr = UnitUtils.ConvertFromInternalUnits(tp.ThermalResistance, UnitTypeId.SquareMeterKelvinsPerWatt);
                    if (hu > 0) { u = hu; source = "thermal_properties"; }
                    if (!r.HasValue && hr > 0) r = hr;
                }
            }
            if (!u.HasValue && r.HasValue && r.Value > 0) source = "thermal_resistance";
            facts["u_value"] = OrNull3(u);
            facts["r_value"] = OrNull3(r);
            facts["u_source"] = source;
            facts["shgc"] = OrNull3(Plain(type.get_Parameter(BuiltInParameter.ANALYTICAL_SOLAR_HEAT_GAIN_COEFFICIENT)));
            facts["vlt"] = OrNull3(Plain(type.get_Parameter(BuiltInParameter.ANALYTICAL_VISUAL_LIGHT_TRANSMITTANCE)));
            if (type is HostObjAttributes hostType) facts["layers_without_thermal"] = LayersWithoutThermal(doc, hostType);
            return facts;
        }

        private static int LayersWithoutThermal(Document doc, HostObjAttributes type)
        {
            try
            {
                CompoundStructure cs = type.GetCompoundStructure();
                if (cs == null) return 0;
                int missing = 0;
                foreach (CompoundStructureLayer layer in cs.GetLayers())
                {
                    if (layer.Width <= 0) continue; // membranes
                    Material m = doc.GetElement(layer.MaterialId) as Material;
                    if (m == null || m.ThermalAssetId == ElementId.InvalidElementId) missing++;
                }
                return missing;
            }
            catch (Exception) { return 0; }
        }

        private static double? Area(Element e)
        {
            Parameter p = e.get_Parameter(BuiltInParameter.HOST_AREA_COMPUTED);
            if (p == null || !p.HasValue || p.StorageType != StorageType.Double) return null;
            double v = p.AsDouble() * SqFtToM2;
            return v > 0 ? v : (double?)null;
        }

        /// <summary>Nominal width x height from the instance, else the type. Rough sizes are not used.</summary>
        private static double? InsertArea(FamilyInstance fi, bool door)
        {
            BuiltInParameter wp = door ? BuiltInParameter.DOOR_WIDTH : BuiltInParameter.WINDOW_WIDTH;
            BuiltInParameter hp = door ? BuiltInParameter.DOOR_HEIGHT : BuiltInParameter.WINDOW_HEIGHT;
            double? w = Len(fi.get_Parameter(wp)) ?? Len(fi.Symbol?.get_Parameter(wp)) ?? Len(fi.get_Parameter(BuiltInParameter.FAMILY_WIDTH_PARAM)) ?? Len(fi.Symbol?.get_Parameter(BuiltInParameter.FAMILY_WIDTH_PARAM));
            double? h = Len(fi.get_Parameter(hp)) ?? Len(fi.Symbol?.get_Parameter(hp)) ?? Len(fi.get_Parameter(BuiltInParameter.FAMILY_HEIGHT_PARAM)) ?? Len(fi.Symbol?.get_Parameter(BuiltInParameter.FAMILY_HEIGHT_PARAM));
            if (!w.HasValue || !h.HasValue) return null;
            return w.Value * h.Value * SqFtToM2;
        }

        private static double TrueNorthAngle(Document doc)
        {
            try
            {
                ProjectLocation loc = doc.ActiveProjectLocation;
                ProjectPosition pos = loc?.GetProjectPosition(XYZ.Zero);
                return pos == null ? 0 : Math.Round(pos.Angle, 6);
            }
            catch (Exception) { return 0; }
        }

        private static JObject Settings(Document doc)
        {
            var s = new JObject();
            try
            {
                EnergyDataSettings e = EnergyDataSettings.GetFromDocument(doc);
                if (e == null) return s;
                try { s["building_type"] = e.BuildingType.ToString(); } catch (Exception) { }
                try { s["analysis_type"] = e.AnalysisType.ToString(); } catch (Exception) { }
            }
            catch (Exception) { }
            try
            {
                EnergyAnalysisDetailModel model = EnergyAnalysisDetailModel.GetMainEnergyAnalysisDetailModel(doc);
                s["energy_model_present"] = model != null;
            }
            catch (Exception) { }
            return s;
        }

        private static XYZ SafeOrientation(Wall wall)
        {
            try { return wall.Orientation; } catch (Exception) { return null; }
        }

        private static XYZ SafeFacing(FamilyInstance fi)
        {
            try { return fi.FacingOrientation; } catch (Exception) { return null; }
        }

        private static double? Si(Parameter p, ForgeTypeId unit)
        {
            if (p == null || !p.HasValue || p.StorageType != StorageType.Double) return null;
            double v = UnitUtils.ConvertFromInternalUnits(p.AsDouble(), unit);
            return v > 0 ? v : (double?)null;
        }

        private static double? Plain(Parameter p)
        {
            if (p == null || !p.HasValue || p.StorageType != StorageType.Double) return null;
            double v = p.AsDouble();
            return v > 0 ? v : (double?)null;
        }

        private static double? Len(Parameter p)
        {
            if (p == null || !p.HasValue || p.StorageType != StorageType.Double) return null;
            double v = p.AsDouble();
            return v > 0 ? v : (double?)null;
        }

        private static JToken OrNull(double? value) => value.HasValue ? (JToken)Math.Round(value.Value, 3) : JValue.CreateNull();
        private static JToken OrNull3(double? value) => value.HasValue ? (JToken)Math.Round(value.Value, 4) : JValue.CreateNull();
        private static double Round(double value) => Math.Round(value, 1);
        private static JToken Vec(XYZ v) => v == null ? JValue.CreateNull() : (JToken)new JArray(Math.Round(v.X, 4), Math.Round(v.Y, 4), Math.Round(v.Z, 4));
    }
}
