using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Engineer › Systems and Structural (U25) on the Revit main thread, read-only. electrical: every board (electrical
    /// equipment) with its connected and demand load, circuits and the circuit that feeds it, plus devices on no circuit and
    /// circuits on no board. structural: columns, beams and foundations against their analytical members (missing, out of
    /// place, free ends), columns with nothing below, kit fields left empty, load cases, and analysis results already in
    /// the model. Nothing is changed: sizes and design stay with the engineer.
    /// </summary>
    public class FmcSystemsEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double FeetToMm = 304.8;
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public string Action { get; set; } = "";
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public string GetName() => "FMC systems";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                Document doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("Open a model first.");
                if (doc.IsFamilyDocument) throw new InvalidOperationException("Systems checks run on a project model.");
                switch (Action)
                {
                    case "electrical": Result = Electrical(doc); break;
                    case "structural": Result = Structural(doc, Parameters); break;
                    default: Error = $"Unknown FMC systems action '{Action}'"; break;
                }
                Result["model"] = doc.Title;
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

        private static string Text(Element e, BuiltInParameter p) => e.get_Parameter(p)?.AsValueString() ?? e.get_Parameter(p)?.AsString() ?? "";

        private static double Va(Element e, BuiltInParameter p)
        {
            Parameter par = e.get_Parameter(p);
            return par == null || par.StorageType != StorageType.Double ? 0 : Math.Round(UnitUtils.ConvertFromInternalUnits(par.AsDouble(), UnitTypeId.VoltAmperes));
        }

        // ---------- Electrical ----------

        private static JObject Electrical(Document doc)
        {
            var boards = new JArray();
            foreach (FamilyInstance fi in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_ElectricalEquipment)
                         .WhereElementIsNotElementType().OfType<FamilyInstance>())
            {
                MEPModel mep = fi.MEPModel;
                var all = mep?.GetElectricalSystems()?.ToList() ?? new List<ElectricalSystem>();
                var assigned = mep?.GetAssignedElectricalSystems()?.ToList() ?? new List<ElectricalSystem>();
                var fedBy = all.FirstOrDefault(s => s.BaseEquipment == null || s.BaseEquipment.Id != fi.Id);
                string name = Text(fi, BuiltInParameter.RBS_ELEC_PANEL_NAME);
                boards.Add(new JObject
                {
                    ["id"] = fi.Id.Value,
                    ["name"] = name.Length > 0 ? name : fi.Name,
                    ["family"] = fi.Symbol?.FamilyName ?? "",
                    ["connected_va"] = Va(fi, BuiltInParameter.RBS_ELEC_PANEL_TOTALLOAD_PARAM),
                    ["demand_va"] = Va(fi, BuiltInParameter.RBS_ELEC_PANEL_TOTALESTLOAD_PARAM),
                    ["distribution"] = Text(fi, BuiltInParameter.RBS_FAMILY_CONTENT_DISTRIBUTION_SYSTEM),
                    ["circuits"] = assigned.Count,
                    ["fed_by"] = fedBy == null ? "" : (fedBy.PanelName + " / " + fedBy.CircuitNumber).Trim(' ', '/'),
                    ["feeder_wire"] = fedBy?.WireSizeString ?? "",
                });
            }

            var loose = new JObject();
            foreach (var cat in new[] { BuiltInCategory.OST_ElectricalFixtures, BuiltInCategory.OST_LightingFixtures, BuiltInCategory.OST_LightingDevices,
                                         BuiltInCategory.OST_DataDevices, BuiltInCategory.OST_FireAlarmDevices, BuiltInCategory.OST_MechanicalEquipment })
            {
                int withConnector = 0, none = 0;
                foreach (FamilyInstance fi in new FilteredElementCollector(doc).OfCategory(cat).WhereElementIsNotElementType().OfType<FamilyInstance>())
                {
                    var cm = fi.MEPModel?.ConnectorManager;
                    if (cm == null) continue;
                    bool electric = cm.Connectors.Cast<Connector>().Any(c => c.Domain == Domain.DomainElectrical);
                    if (!electric) continue;
                    withConnector++;
                    if ((fi.MEPModel.GetElectricalSystems()?.Count ?? 0) == 0) none++;
                }
                if (withConnector > 0) loose[cat.ToString().Replace("OST_", "")] = new JObject { ["with_power_connector"] = withConnector, ["on_no_circuit"] = none };
            }

            int noBoard = new FilteredElementCollector(doc).OfClass(typeof(ElectricalSystem)).Cast<ElectricalSystem>()
                .Count(s => s.SystemType == ElectricalSystemType.PowerCircuit && s.BaseEquipment == null);
            return new JObject { ["boards"] = boards, ["devices"] = loose, ["circuits_without_board"] = noBoard };
        }

        // ---------- Structural ----------

        private static JObject Structural(Document doc, JObject p)
        {
            var cats = new[] { BuiltInCategory.OST_StructuralColumns, BuiltInCategory.OST_StructuralFraming, BuiltInCategory.OST_StructuralFoundation };
            var members = new FilteredElementCollector(doc).WherePasses(new ElementMulticategoryFilter(cats.ToList()))
                .WhereElementIsNotElementType().OfType<FamilyInstance>().ToList();
            var assoc = AnalyticalToPhysicalAssociationManager.GetAnalyticalToPhysicalAssociationManager(doc);
            double tol50 = 50 / FeetToMm, tolJoin = 25 / FeetToMm;

            var noAnalytical = new List<long>();
            var offset = new List<long>();
            var curves = new Dictionary<long, Curve>();
            foreach (FamilyInstance m in members.Where(x => x.Category.Id.Value != (long)BuiltInCategory.OST_StructuralFoundation))
            {
                ElementId aId = assoc?.GetAssociatedElementId(m.Id) ?? ElementId.InvalidElementId;
                if (!(doc.GetElement(aId) is AnalyticalMember am)) { noAnalytical.Add(m.Id.Value); continue; }
                Curve ac = am.GetCurve();
                if (ac == null) continue;
                curves[m.Id.Value] = ac;
                if (m.Location is LocationCurve lc && lc.Curve != null)
                {
                    XYZ pm = lc.Curve.Evaluate(0.5, true), amid = ac.Evaluate(0.5, true);
                    if (pm.DistanceTo(amid) > tol50) offset.Add(m.Id.Value);
                }
                else if (m.Location is LocationPoint lp)
                {
                    XYZ a = ac.GetEndPoint(0);
                    if (new XYZ(a.X - lp.Point.X, a.Y - lp.Point.Y, 0).GetLength() > tol50) offset.Add(m.Id.Value);
                }
            }

            // A free end: no other analytical member within 25 mm. Column bottoms rest on supports, so they don't count.
            var freeEnds = new List<long>();
            var list = curves.ToList();
            if (list.Count <= 4000)
                foreach (var (id, c) in list.Select(kv => (kv.Key, kv.Value)))
                {
                    bool column = members.First(m => m.Id.Value == id).Category.Id.Value == (long)BuiltInCategory.OST_StructuralColumns;
                    for (int end = 0; end < 2; end++)
                    {
                        XYZ pt = c.GetEndPoint(end);
                        if (column && pt.Z <= c.GetEndPoint(1 - end).Z) continue;
                        bool joined = list.Any(o => o.Key != id && o.Value.Distance(pt) <= tolJoin);
                        if (!joined) { freeEnds.Add(id); break; }
                    }
                }

            // A column stands on a footing, a beam, a slab, a wall or the column of the floor below (a stacked frame).
            var supportCats = new ElementMulticategoryFilter(new List<BuiltInCategory>
                { BuiltInCategory.OST_StructuralFoundation, BuiltInCategory.OST_StructuralFraming, BuiltInCategory.OST_Floors, BuiltInCategory.OST_Walls,
                  BuiltInCategory.OST_StructuralColumns });
            var nothingBelow = new List<long>();
            foreach (FamilyInstance col in members.Where(x => x.Category.Id.Value == (long)BuiltInCategory.OST_StructuralColumns))
            {
                BoundingBoxXYZ bb = col.get_BoundingBox(null);
                if (bb == null) continue;
                XYZ c = (bb.Min + bb.Max) / 2;
                var probe = new Outline(new XYZ(c.X - tol50, c.Y - tol50, bb.Min.Z - 2 * tol50), new XYZ(c.X + tol50, c.Y + tol50, bb.Min.Z + tol50));
                bool below = new FilteredElementCollector(doc).WherePasses(supportCats).WhereElementIsNotElementType()
                    .WherePasses(new BoundingBoxIntersectsFilter(probe)).Any(e => e.Id != col.Id);
                if (!below) nothingBelow.Add(col.Id.Value);
            }

            // Kit fields left empty: the server names them from the kit's master data (rule 7).
            var missing = new JArray();
            foreach (var f in (p["fields"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string name = f.Value<string>("name") ?? "";
                var only = (f["categories"] as JArray ?? new JArray()).Select(x => x.ToString()).ToList();
                string material = f.Value<string>("material") ?? "";
                var ids = new List<long>();
                int applies = 0;
                foreach (FamilyInstance m in members)
                {
                    if (only.Count > 0 && !only.Contains("OST_" + ((BuiltInCategory)m.Category.Id.Value).ToString().Replace("OST_", ""))) continue;
                    if (material.Length > 0 && !MaterialIs(m, material)) continue;
                    applies++;
                    Parameter par = m.LookupParameter(name) ?? m.Symbol?.LookupParameter(name);
                    bool empty = par == null || !par.HasValue || (par.StorageType == StorageType.String && string.IsNullOrWhiteSpace(par.AsString()));
                    if (empty) ids.Add(m.Id.Value);
                }
                missing.Add(new JObject { ["name"] = name, ["applies"] = applies, ["missing"] = ids.Count, ["ids"] = new JArray(ids.Take(200)),
                    ["in_model"] = members.Any(m => (m.LookupParameter(name) ?? m.Symbol?.LookupParameter(name)) != null) });
            }

            // Analysis results already written into the model (the kit's FMC_FEA_ fields), highest utilisation first.
            var results = new JArray();
            foreach (FamilyInstance m in members)
            {
                Parameter u = m.LookupParameter("FMC_FEA_Utilisation");
                if (u == null || !u.HasValue) continue;
                double util = u.StorageType == StorageType.Double ? u.AsDouble() : double.TryParse(u.AsString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out double d) ? d : double.NaN;
                if (double.IsNaN(util)) continue;
                string mark = m.LookupParameter("FMC_Member_Mark")?.AsString() ?? Text(m, BuiltInParameter.ALL_MODEL_MARK);
                results.Add(new JObject { ["id"] = m.Id.Value, ["mark"] = mark, ["type"] = m.Symbol?.Name ?? "", ["utilisation"] = Math.Round(util, 2),
                    ["run"] = m.LookupParameter("FMC_FEA_Run_Ref")?.AsString() ?? "" });
            }

            return new JObject
            {
                ["members"] = new JObject
                {
                    ["columns"] = members.Count(m => m.Category.Id.Value == (long)BuiltInCategory.OST_StructuralColumns),
                    ["framing"] = members.Count(m => m.Category.Id.Value == (long)BuiltInCategory.OST_StructuralFraming),
                    ["foundations"] = members.Count(m => m.Category.Id.Value == (long)BuiltInCategory.OST_StructuralFoundation),
                },
                ["no_analytical"] = new JArray(noAnalytical.Take(200)), ["no_analytical_count"] = noAnalytical.Count,
                ["offset_over_50mm"] = new JArray(offset.Take(200)), ["offset_count"] = offset.Count,
                ["free_ends"] = new JArray(freeEnds.Take(200)), ["free_end_count"] = freeEnds.Count, ["free_ends_checked"] = list.Count <= 4000,
                ["nothing_below"] = new JArray(nothingBelow.Take(200)), ["nothing_below_count"] = nothingBelow.Count,
                ["fields"] = missing,
                ["load_cases"] = new FilteredElementCollector(doc).OfClass(typeof(LoadCase)).GetElementCount(),
                ["load_combinations"] = new FilteredElementCollector(doc).OfClass(typeof(LoadCombination)).GetElementCount(),
                ["results"] = new JArray(results.OrderByDescending(r => r.Value<double>("utilisation")).Take(50)),
                ["results_count"] = results.Count,
            };
        }

        private static bool MaterialIs(FamilyInstance m, string material)
        {
            try
            {
                var t = m.StructuralMaterialType;
                return material switch
                {
                    "Concrete" => t == StructuralMaterialType.Concrete || t == StructuralMaterialType.PrecastConcrete,
                    "Steel" => t == StructuralMaterialType.Steel,
                    "Timber" => t == StructuralMaterialType.Wood,
                    _ => true,
                };
            }
            catch (Exception) { return true; }
        }
    }
}
