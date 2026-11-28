using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Bridge;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Diagram snapshots. Electrical panels and circuits follow fmc_trace CollectElectrical.
    /// Piping uses PipingSystem membership, not Connector.AllRefs. Neither read starts a transaction.
    /// </summary>
    internal static class FmcSchematicRead
    {
        private const double FeetToMm = 304.8;
        private const int ElementCap = 8000;

        internal static JObject Levels(Document doc)
        {
            var levels = new JArray();
            foreach (Level level in new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>())
                levels.Add(new JObject { ["name"] = level.Name ?? "", ["elevation_mm"] = Math.Round(level.Elevation * FeetToMm, 1) });
            return new JObject { ["levels"] = levels };
        }

        internal static JArray Symbols(Document doc)
        {
            var symbols = new JArray();
            foreach (FamilySymbol symbol in new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>())
            {
                long category = symbol.Family?.FamilyCategory?.Id.Value ?? 0;
                if (category != (long)BuiltInCategory.OST_GenericAnnotation && category != (long)BuiltInCategory.OST_DetailComponents) continue;
                string family = symbol.FamilyName ?? "";
                if (!family.StartsWith("FMC_", StringComparison.OrdinalIgnoreCase)) continue;
                symbols.Add(family + ":" + (symbol.Name ?? ""));
                if (symbols.Count >= 200) break;
            }
            return symbols;
        }

        internal static JArray TinySchematics(Document doc)
        {
            var views = new JArray();
            foreach (View3D view in new FilteredElementCollector(doc).OfClass(typeof(View3D)).Cast<View3D>())
            {
                if (view.IsTemplate) continue;
                string name = view.Name ?? "";
                if (!Regex.IsMatch(name, "schematic|riser", RegexOptions.IgnoreCase)) continue;
                bool tiny = false;
                try
                {
                    BoundingBoxXYZ box = view.CropBox;
                    if (box != null)
                    {
                        double dx = Math.Abs(box.Max.X - box.Min.X) * FeetToMm;
                        double dy = Math.Abs(box.Max.Y - box.Min.Y) * FeetToMm;
                        double dz = Math.Abs(box.Max.Z - box.Min.Z) * FeetToMm;
                        tiny = dx < 8000 && dy < 8000 && dz < 8000;
                    }
                }
                catch (Exception) { tiny = true; }
                views.Add(new JObject { ["id"] = view.Id.Value, ["name"] = name, ["tiny"] = tiny });
            }
            return views;
        }

        internal static JObject Electrical(Document doc)
        {
            var panels = new JArray();
            var panelIds = new HashSet<long>();
            foreach (Element element in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_ElectricalEquipment).WhereElementIsNotElementType())
            {
                if (element is not FamilyInstance board) continue;
                string part = FmcCircuitsHandler.PartName(board);
                bool schedule = FmcCircuitsHandler.ScheduleCapable(board);
                if (!FmcCircuitsHandler.IsPanelPart(part) && !schedule) continue;
                string name = board.get_Parameter(BuiltInParameter.RBS_ELEC_PANEL_NAME)?.AsString();
                if (string.IsNullOrWhiteSpace(name)) name = board.Name ?? "";
                var (levelName, elevation) = LevelOf(doc, board);
                long supplyFrom = 0;
                try
                {
                    ISet<ElectricalSystem> memberOf = board.MEPModel?.GetElectricalSystems();
                    if (memberOf != null)
                    {
                        foreach (ElectricalSystem system in memberOf)
                        {
                            if (system.BaseEquipment == null || system.BaseEquipment.Id == board.Id) continue;
                            supplyFrom = system.BaseEquipment.Id.Value;
                            break;
                        }
                    }
                }
                catch (Exception) { /* no supply circuit */ }
                var row = new JObject
                {
                    ["id"] = board.Id.Value,
                    ["name"] = name,
                    ["level"] = levelName,
                    ["elevation_mm"] = elevation,
                    ["building"] = Building(board),
                    ["distribution"] = FmcCircuitsHandler.DistributionName(board),
                    ["main_a"] = MainAmps(board),
                    ["supply_from_id"] = supplyFrom,
                };
                FmcCircuitsHandler.AddDistribution(board, row);
                panels.Add(row);
                panelIds.Add(board.Id.Value);
            }

            var circuits = new JArray();
            foreach (ElectricalSystem system in new FilteredElementCollector(doc).OfClass(typeof(ElectricalSystem)).Cast<ElectricalSystem>())
            {
                if (system.SystemType != ElectricalSystemType.PowerCircuit && system.SystemType != ElectricalSystemType.PowerUnBalanced && system.SystemType != ElectricalSystemType.PowerBalanced)
                    continue;
                long panelId = 0;
                try { if (system.BaseEquipment != null) panelId = system.BaseEquipment.Id.Value; } catch (Exception) { /* unset */ }
                var members = new JArray();
                try
                {
                    foreach (Element member in system.Elements)
                        if (member != null && member.Id.Value != panelId) members.Add(member.Id.Value);
                }
                catch (Exception) { /* one circuit that cannot list its loads is still drawn */ }
                double voltage = 0, apparent = 0, rating = 0;
                int poles = 0;
                try { voltage = Math.Round(UnitUtils.ConvertFromInternalUnits(system.Voltage, UnitTypeId.Volts), 1); } catch (Exception) { /* unset */ }
                try { poles = system.PolesNumber; } catch (Exception) { /* unset */ }
                try { apparent = Math.Round(system.ApparentLoad, 1); } catch (Exception) { /* unset */ }
                try
                {
                    Parameter parameter = system.get_Parameter(BuiltInParameter.RBS_ELEC_CIRCUIT_RATING_PARAM);
                    if (parameter != null && parameter.StorageType == StorageType.Double)
                        rating = Math.Round(UnitUtils.ConvertFromInternalUnits(parameter.AsDouble(), UnitTypeId.Amperes), 1);
                }
                catch (Exception) { /* unset */ }
                string number = "";
                string load = "";
                try { number = system.CircuitNumber ?? ""; } catch (Exception) { /* unset */ }
                try { load = system.LoadName ?? ""; } catch (Exception) { /* unset */ }
                circuits.Add(new JObject
                {
                    ["id"] = system.Id.Value,
                    ["name"] = load.Length > 0 ? load : (system.Name ?? ""),
                    ["number"] = number,
                    ["panel_id"] = panelId,
                    ["voltage"] = voltage,
                    ["poles"] = poles,
                    ["rating_a"] = rating,
                    ["apparent_va"] = apparent,
                    ["wire_size"] = system.get_Parameter(BuiltInParameter.RBS_ELEC_CIRCUIT_WIRE_SIZE_PARAM)?.AsString() ?? "",
                    ["element_ids"] = members,
                });
            }
            var levels = Levels(doc);
            return new JObject
            {
                ["panels"] = panels,
                ["circuits"] = circuits,
                ["levels"] = levels["levels"],
                ["symbols"] = Symbols(doc),
                ["panel_ids"] = panelIds.Count,
            };
        }

        internal static JObject Piping(Document doc)
        {
            var members = new Dictionary<long, HashSet<long>>();
            var systems = new JArray();
            foreach (PipingSystem system in new FilteredElementCollector(doc).OfClass(typeof(PipingSystem)).Cast<PipingSystem>())
            {
                string classification = "";
                try { classification = system.SystemType.ToString(); } catch (Exception) { /* unset */ }
                var ids = new HashSet<long>();
                try
                {
                    ElementSet owned = system.Elements;
                    if (owned != null)
                    {
                        foreach (Element element in owned)
                        {
                            if (element == null) continue;
                            ids.Add(element.Id.Value);
                            if (!members.TryGetValue(element.Id.Value, out HashSet<long> set)) members[element.Id.Value] = set = new HashSet<long>();
                            set.Add(system.Id.Value);
                        }
                    }
                }
                catch (Exception) { /* a system that cannot list its elements is still named */ }
                systems.Add(new JObject
                {
                    ["id"] = system.Id.Value,
                    ["name"] = system.Name ?? "",
                    ["domain"] = "piping",
                    ["classification"] = classification,
                    ["element_ids"] = new JArray(ids.ToArray()),
                });
            }

            var elements = new JArray();
            bool truncated = false;
            void Take(Element element, string kind)
            {
                if (element == null || truncated) return;
                if (elements.Count >= ElementCap) { truncated = true; return; }
                var systemIds = new JArray();
                if (members.TryGetValue(element.Id.Value, out HashSet<long> on))
                    foreach (long id in on) systemIds.Add(id);
                if (systemIds.Count == 0)
                {
                    long fallback = PipingSystemId(element);
                    if (fallback != 0) systemIds.Add(fallback);
                }
                if (systemIds.Count == 0 && kind == "pipe") return;
                var (levelName, elevation) = LevelOf(doc, element);
                double x = 0, y = 0, z0 = 0, z1 = 0, size = 0;
                bool vertical = false;
                if (element.Location is LocationCurve located && located.Curve != null && located.Curve.IsBound)
                {
                    XYZ a = located.Curve.GetEndPoint(0);
                    XYZ b = located.Curve.GetEndPoint(1);
                    double dx = Math.Abs(a.X - b.X) * FeetToMm;
                    double dy = Math.Abs(a.Y - b.Y) * FeetToMm;
                    double dz = Math.Abs(a.Z - b.Z) * FeetToMm;
                    vertical = dz > dx && dz > dy && dz > 1500;
                    x = Math.Round((a.X + b.X) / 2 * FeetToMm, 1);
                    y = Math.Round((a.Y + b.Y) / 2 * FeetToMm, 1);
                    z0 = Math.Round(Math.Min(a.Z, b.Z) * FeetToMm, 1);
                    z1 = Math.Round(Math.Max(a.Z, b.Z) * FeetToMm, 1);
                }
                else if (element.Location is LocationPoint point && point.Point != null)
                {
                    x = Math.Round(point.Point.X * FeetToMm, 1);
                    y = Math.Round(point.Point.Y * FeetToMm, 1);
                    z0 = Math.Round(point.Point.Z * FeetToMm, 1);
                    z1 = z0;
                }
                try
                {
                    Parameter diameter = element.get_Parameter(BuiltInParameter.RBS_PIPE_DIAMETER_PARAM);
                    if (diameter != null && diameter.StorageType == StorageType.Double)
                        size = Math.Round(UnitUtils.ConvertFromInternalUnits(diameter.AsDouble(), UnitTypeId.Millimeters), 1);
                }
                catch (Exception) { /* a fitting with no diameter */ }
                double? slopePct = null;
                double? fixtureUnits = null;
                try
                {
                    Parameter slope = element.get_Parameter(BuiltInParameter.RBS_PIPE_SLOPE);
                    if (slope != null && slope.HasValue && slope.StorageType == StorageType.Double)
                        slopePct = Math.Round(slope.AsDouble() * 100.0, 3);
                    Parameter units = element.get_Parameter(BuiltInParameter.RBS_PIPE_FIXTURE_UNITS_PARAM);
                    if (units != null && units.HasValue && units.StorageType == StorageType.Double)
                        fixtureUnits = Math.Round(units.AsDouble(), 2);
                }
                catch (Exception) { /* not a pipe */ }
                elements.Add(new JObject
                {
                    ["id"] = element.Id.Value,
                    ["name"] = element.Name ?? "",
                    ["kind"] = kind,
                    ["system_ids"] = systemIds,
                    ["level"] = levelName,
                    ["elevation_mm"] = elevation,
                    ["size_mm"] = size,
                    ["x"] = x,
                    ["y"] = y,
                    ["z0"] = z0,
                    ["z1"] = z1,
                    ["vertical"] = vertical,
                    ["slope_pct"] = slopePct.HasValue ? (JToken)slopePct.Value : JValue.CreateNull(),
                    ["fixture_units"] = fixtureUnits.HasValue ? (JToken)fixtureUnits.Value : JValue.CreateNull(),
                });
            }

            foreach (Element element in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_PipeCurves).WhereElementIsNotElementType())
                Take(element, "pipe");
            foreach (Element element in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_FlexPipeCurves).WhereElementIsNotElementType())
                Take(element, "flex_pipe");
            foreach (Element element in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_PlumbingFixtures).WhereElementIsNotElementType())
                Take(element, "fixture");
            foreach (Element element in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_PlumbingEquipment).WhereElementIsNotElementType())
                Take(element, "equipment");

            var levels = Levels(doc);
            return new JObject
            {
                ["systems"] = systems,
                ["elements"] = elements,
                ["levels"] = levels["levels"],
                ["symbols"] = Symbols(doc),
                ["views_3d"] = TinySchematics(doc),
                ["truncated"] = truncated,
            };
        }

        private static long PipingSystemId(Element element)
        {
            ConnectorManager manager = null;
            if (element is MEPCurve curve) manager = curve.ConnectorManager;
            else if (element is FamilyInstance instance) manager = instance.MEPModel?.ConnectorManager;
            if (manager == null) return 0;
            foreach (Connector connector in manager.Connectors)
            {
                try
                {
                    if (connector.Domain != Domain.DomainPiping) continue;
                    if (connector.MEPSystem != null) return connector.MEPSystem.Id.Value;
                }
                catch (Exception) { /* one connector */ }
            }
            return 0;
        }

        private static (string name, double elevation) LevelOf(Document doc, Element element)
        {
            try
            {
                if (element is MEPCurve curve && curve.ReferenceLevel != null)
                    return (curve.ReferenceLevel.Name ?? "", Math.Round(curve.ReferenceLevel.Elevation * FeetToMm, 1));
            }
            catch (Exception) { /* no reference level */ }
            Level level = null;
            try { level = doc.GetElement(element.LevelId) as Level; } catch (Exception) { /* unset */ }
            if (level == null)
            {
                Parameter parameter = element.get_Parameter(BuiltInParameter.RBS_START_LEVEL_PARAM);
                if (parameter != null && parameter.StorageType == StorageType.ElementId)
                    level = doc.GetElement(parameter.AsElementId()) as Level;
            }
            if (level == null) return ("", 0);
            return (level.Name ?? "", Math.Round(level.Elevation * FeetToMm, 1));
        }

        private static string Building(Element element)
        {
            foreach (string name in new[] { "FMC_Building", "Building" })
            {
                Parameter parameter = element.LookupParameter(name);
                if (parameter == null || !parameter.HasValue) continue;
                string text = parameter.StorageType == StorageType.String ? parameter.AsString() : parameter.AsValueString();
                if (!string.IsNullOrWhiteSpace(text)) return text.Trim();
            }
            return "";
        }

        private static double MainAmps(Element element)
        {
            foreach (string name in new[] { "Mains", "Main Rating", "FMC_Main_Rating" })
            {
                Parameter parameter = element.LookupParameter(name);
                if (parameter == null || !parameter.HasValue) continue;
                if (parameter.StorageType == StorageType.Double) return Math.Round(parameter.AsDouble(), 1);
                if (parameter.StorageType == StorageType.Integer) return parameter.AsInteger();
            }
            return 0;
        }

        internal static bool IsCentral(Document doc)
        {
            if (doc == null || !doc.IsWorkshared || string.IsNullOrEmpty(doc.PathName)) return false;
            try
            {
                string central = ModelPathUtils.ConvertModelPathToUserVisiblePath(doc.GetWorksharingCentralModelPath());
                return !string.IsNullOrEmpty(central) && string.Equals(System.IO.Path.GetFullPath(central), System.IO.Path.GetFullPath(doc.PathName), StringComparison.OrdinalIgnoreCase);
            }
            catch (Exception) { return false; }
        }

        internal static void Refuse(Document doc, string tool)
        {
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (Regex.IsMatch(blob, "hebert hostels", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("HEBERT HOSTELS is not written by " + tool + ".");
            if (IsCentral(doc)) throw new InvalidOperationException("A central model is not written by " + tool + ".");
        }
    }

    public class FmcElecDiagramsHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft electrical diagrams snapshot";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    if (doc.IsFamilyDocument) throw new InvalidOperationException("fmc_elec_diagrams runs on a project model.");
                    JObject graph = FmcSchematicRead.Electrical(doc);
                    graph["model"] = doc.Title;
                    graph["resolved_document"] = FmcTarget.Resolved(doc);
                    graph["is_central"] = FmcSchematicRead.IsCentral(doc);
                    graph["read_only"] = true;
                    graph["saved"] = false;
                    Result = graph;
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }
    }

    public class FmcPlumbDiagramsHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft plumbing diagrams snapshot";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    if (doc.IsFamilyDocument) throw new InvalidOperationException("fmc_plumb_diagrams runs on a project model.");
                    JObject graph = FmcSchematicRead.Piping(doc);
                    graph["model"] = doc.Title;
                    graph["resolved_document"] = FmcTarget.Resolved(doc);
                    graph["is_central"] = FmcSchematicRead.IsCentral(doc);
                    graph["read_only"] = true;
                    graph["saved"] = false;
                    Result = graph;
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }
    }

    /// <summary>One transaction. One subtransaction per drafting view. The model is not saved.</summary>
    public class FmcSchematicApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public string Tool { get; set; } = "fmc_elec_diagrams";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft schematic diagrams";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    FmcSchematicRead.Refuse(doc, Tool);
                    JObject spec = new JObject { ["views"] = Parameters["views"] as JArray ?? new JArray() };
                    JObject drawn = FmcDiagramDraw.DrawOnce(doc, spec);
                    drawn["model"] = doc.Title;
                    drawn["resolved_document"] = FmcTarget.Resolved(doc);
                    drawn["saved"] = false;
                    drawn["synced"] = false;
                    Result = drawn;
                }
            }
            catch (Exception ex) { Error = ex.Message; Result["applied"] = false; Result["saved"] = false; }
            finally { _done.Set(); }
        }
    }
}
