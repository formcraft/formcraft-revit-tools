using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Applies one correction plan in one transaction. The failure count is taken before the edits and again
    /// after regenerate. A higher count rolls the transaction back, so the document is unchanged.
    /// No checkout is requested. The active document and view are not switched.
    /// </summary>
    public class FmcTraceApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double FeetToMm = 304.8;
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft trace corrections";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            string titleBefore = app.ActiveUIDocument?.Document?.Title ?? "";
            string viewBefore = app.ActiveUIDocument?.ActiveView?.UniqueId ?? "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    if (doc.IsFamilyDocument) throw new InvalidOperationException("fmc_trace_apply runs on a project model.");
                    Refuse(doc);
                    bool modifiedBefore = doc.IsModified;
                    double near = Parameters.Value<double?>("near_miss_mm") ?? 50;
                    double sizeTol = Parameters.Value<double?>("size_mismatch_mm") ?? 2;
                    int cap = Parameters.Value<int?>("max_edits") ?? 25;
                    if (cap < 1) cap = 1;
                    if (cap > 100) cap = 100;
                    var edits = (Parameters["edits"] as JArray ?? new JArray()).OfType<JObject>().Take(cap).ToList();
                    var done = new JArray();
                    var skipped = new FmcNonFamily();
                    int before = Score(doc, near, sizeTol, skipped);
                    using (var transaction = new Transaction(doc, "Formcraft trace corrections"))
                    {
                        transaction.Start();
                        FamilySymbol pipeCap = CapSymbol(doc, BuiltInCategory.OST_PipeFitting);
                        FamilySymbol ductCap = CapSymbol(doc, BuiltInCategory.OST_DuctFitting);
                        foreach (JObject edit in edits)
                        {
                            JObject row = ApplyOne(doc, edit, pipeCap, ductCap);
                            done.Add(row);
                        }
                        try { doc.Regenerate(); } catch (Exception) { /* the score still reads what was created */ }
                        int after = Score(doc, near, sizeTol, null);
                        bool worse = after > before;
                        if (worse) transaction.RollBack();
                        else transaction.Commit();
                        Result["before_score"] = before;
                        Result["after_score"] = worse ? before : after;
                        Result["rolled_back"] = worse;
                        Result["edits"] = done;
                    }
                    Result["read_only"] = false;
                    Result["saved"] = false;
                    Result["model"] = doc.Title;
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                    Result["is_central"] = false;
                    Result["modified_during_call"] = !modifiedBefore && doc.IsModified;
                    Result["skipped_non_family"] = skipped.Report();
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally
            {
                string titleAfter = app.ActiveUIDocument?.Document?.Title ?? "";
                string viewAfter = app.ActiveUIDocument?.ActiveView?.UniqueId ?? "";
                if (Result != null && string.IsNullOrEmpty(Error))
                    Result["active_unchanged"] = titleBefore == titleAfter && viewBefore == viewAfter;
                _done.Set();
            }
        }

        private void Refuse(Document doc)
        {
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (Regex.IsMatch(blob, "hebert hostels", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("HEBERT HOSTELS is not written by fmc_trace.");
            if (doc.IsWorkshared && !string.IsNullOrEmpty(doc.PathName))
            {
                try
                {
                    string central = ModelPathUtils.ConvertModelPathToUserVisiblePath(doc.GetWorksharingCentralModelPath());
                    if (!string.IsNullOrEmpty(central) && string.Equals(System.IO.Path.GetFullPath(central), System.IO.Path.GetFullPath(doc.PathName), StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("A central model is not written by fmc_trace.");
                }
                catch (InvalidOperationException) { throw; }
                catch (Exception) { /* a local whose central path cannot be read is still checked by the server */ }
            }
            if (FmcTarget.IsProtected(doc.PathName ?? "", FmcTarget.Roots(Parameters)))
                throw new InvalidOperationException("The document is under a protected path.");
        }

        private static JObject ApplyOne(Document doc, JObject edit, FamilySymbol pipeCap, FamilySymbol ductCap)
        {
            string op = (edit.Value<string>("op") ?? "").Trim();
            var ids = Ids(edit);
            var skipped = new JArray();
            var kept = new List<ElementId>();
            FmcCheckout.Partition(doc, ids, kept, skipped);
            if (skipped.Count > 0) return new JObject { ["op"] = op, ["ok"] = false, ["skipped"] = skipped };
            try
            {
                switch (op)
                {
                    case "connect":
                        Connectors(doc, edit, out Connector a, out Connector b, out _);
                        a.ConnectTo(b);
                        break;
                    case "elbow":
                        Connectors(doc, edit, out Connector e1, out Connector e2, out _);
                        doc.Create.NewElbowFitting(e1, e2);
                        break;
                    case "transition":
                        Connectors(doc, edit, out Connector t1, out Connector t2, out _);
                        doc.Create.NewTransitionFitting(t1, t2);
                        break;
                    case "tee":
                        Connectors(doc, edit, out Connector c1, out Connector c2, out Connector c3);
                        doc.Create.NewTeeFitting(c1, c2, c3);
                        break;
                    case "resize":
                        Resize(doc, edit);
                        break;
                    case "cap":
                        Cap(doc, edit, pipeCap, ductCap);
                        break;
                    case "assign_system":
                        Assign(doc, edit);
                        break;
                    case "circuit":
                        Circuit(doc, edit);
                        break;
                    default:
                        throw new InvalidOperationException("Unknown correction " + op);
                }
                return new JObject { ["op"] = op, ["ok"] = true };
            }
            catch (Exception ex)
            {
                return new JObject { ["op"] = op, ["ok"] = false, ["error"] = ex.Message };
            }
        }

        private static List<ElementId> Ids(JObject edit)
        {
            var list = new List<ElementId>();
            void Add(long id) { if (id > 0) list.Add(new ElementId(id)); }
            if (edit["ids"] is JArray array) foreach (JToken token in array) Add(token.Value<long>());
            Add(edit.Value<long?>("element_id") ?? 0);
            Add(edit.Value<long?>("a") ?? 0);
            Add(edit.Value<long?>("b") ?? 0);
            Add(edit.Value<long?>("c") ?? 0);
            return list.GroupBy(id => id.Value).Select(group => group.First()).ToList();
        }

        private static void Connectors(Document doc, JObject edit, out Connector a, out Connector b, out Connector c)
        {
            a = Find(doc, edit.Value<long?>("a") ?? 0, edit.Value<int?>("ai") ?? 0);
            b = Find(doc, edit.Value<long?>("b") ?? 0, edit.Value<int?>("bi") ?? 0);
            c = edit.Value<long?>("c") is long id && id > 0 ? Find(doc, id, edit.Value<int?>("ci") ?? 0) : null;
            if (a == null || b == null) throw new InvalidOperationException("A connector in the plan is not in the document.");
        }

        private static Connector Find(Document doc, long elementId, int index)
        {
            Element element = doc.GetElement(new ElementId(elementId));
            ConnectorManager manager = element is MEPCurve curve ? curve.ConnectorManager
                : element is FamilyInstance instance ? instance.MEPModel?.ConnectorManager : null;
            if (manager == null) return null;
            foreach (Connector connector in manager.Connectors)
                if (connector.Id == index) return connector;
            return null;
        }

        private static void Resize(Document doc, JObject edit)
        {
            if (!(doc.GetElement(new ElementId(edit.Value<long?>("element_id") ?? 0)) is MEPCurve curve))
                throw new InvalidOperationException("Resize applies to a pipe or duct, not a fitting.");
            double size = (edit.Value<double?>("size_mm") ?? 0) / FeetToMm;
            double height = (edit.Value<double?>("height_mm") ?? 0) / FeetToMm;
            Parameter diameter = curve.get_Parameter(BuiltInParameter.RBS_PIPE_DIAMETER_PARAM) ?? curve.get_Parameter(BuiltInParameter.RBS_CURVE_DIAMETER_PARAM);
            if (diameter != null && !diameter.IsReadOnly && size > 0) { diameter.Set(size); return; }
            Parameter width = curve.get_Parameter(BuiltInParameter.RBS_CURVE_WIDTH_PARAM);
            Parameter depth = curve.get_Parameter(BuiltInParameter.RBS_CURVE_HEIGHT_PARAM);
            if (width != null && !width.IsReadOnly && size > 0) width.Set(size);
            if (depth != null && !depth.IsReadOnly && height > 0) depth.Set(height);
        }

        private static void Cap(Document doc, JObject edit, FamilySymbol pipeCap, FamilySymbol ductCap)
        {
            Connector connector = Find(doc, edit.Value<long?>("element_id") ?? 0, edit.Value<int?>("index") ?? 0);
            if (connector == null) throw new InvalidOperationException("The open end is not in the document.");
            FamilySymbol symbol = connector.Domain == Domain.DomainHvac ? ductCap : pipeCap;
            if (symbol == null) throw new InvalidOperationException("No cap family is loaded.");
            if (!symbol.IsActive) symbol.Activate();
            FamilyInstance placed = doc.Create.NewFamilyInstance(connector.Origin, symbol, Autodesk.Revit.DB.Structure.StructuralType.NonStructural);
            Connector mate = null;
            foreach (Connector other in placed.MEPModel.ConnectorManager.Connectors) { mate = other; break; }
            if (mate == null) throw new InvalidOperationException("The cap family has no connector.");
            connector.ConnectTo(mate);
        }

        private static void Assign(Document doc, JObject edit)
        {
            Element element = doc.GetElement(new ElementId(edit.Value<long?>("element_id") ?? 0));
            if (!(doc.GetElement(new ElementId(edit.Value<long?>("system_id") ?? 0)) is MEPSystem system) || element == null)
                throw new InvalidOperationException("The system or the element is not in the document.");
            ConnectorManager manager = element is MEPCurve curve ? curve.ConnectorManager : element is FamilyInstance instance ? instance.MEPModel?.ConnectorManager : null;
            if (manager == null) throw new InvalidOperationException("The element has no connectors to add to the system.");
            var set = new ConnectorSet();
            foreach (Connector connector in manager.Connectors) set.Insert(connector);
            system.Add(set);
        }

        private static void Circuit(Document doc, JObject edit)
        {
            if (!(doc.GetElement(new ElementId(edit.Value<long?>("element_id") ?? 0)) is FamilyInstance device))
                throw new InvalidOperationException("The device is not in the document.");
            if (!(doc.GetElement(new ElementId(edit.Value<long?>("circuit_id") ?? 0)) is ElectricalSystem circuit))
                throw new InvalidOperationException("The circuit is not in the document.");
            var members = new ElementSet();
            members.Insert(device);
            circuit.AddToCircuit(members);
        }

        private static FamilySymbol CapSymbol(Document doc, BuiltInCategory category)
        {
            return new FilteredElementCollector(doc).OfCategory(category).OfClass(typeof(FamilySymbol)).OfType<FamilySymbol>()
                .FirstOrDefault(symbol => Regex.IsMatch((symbol.FamilyName ?? "") + " " + symbol.Name, "cap", RegexOptions.IgnoreCase));
        }

        /// <summary>Open ends, near-miss pairs, size mismatches, uncircuited devices and empty circuits. A rise rolls the transaction back.</summary>
        private static int Score(Document doc, double nearMm, double sizeTolMm, FmcNonFamily skipped)
        {
            int score = 0;
            var open = new List<Connector>();
            foreach (Element element in new FilteredElementCollector(doc).OfClass(typeof(MEPCurve)).WhereElementIsNotElementType())
            {
                if (element is MEPCurve curve) Collect(curve.ConnectorManager, open, ref score, sizeTolMm);
                else skipped?.Add(element);
            }
            foreach (Element element in new FilteredElementCollector(doc).OfClass(typeof(FamilyInstance)).WhereElementIsNotElementType())
            {
                if (element is FamilyInstance instance) Collect(instance.MEPModel?.ConnectorManager, open, ref score, sizeTolMm);
                else skipped?.Add(element);
            }
            double near = nearMm / FeetToMm;
            for (int i = 0; i < open.Count && i < 4000; i++)
                for (int j = i + 1; j < open.Count && j < 4000; j++)
                    if (open[i].Owner.Id != open[j].Owner.Id && open[i].Domain == open[j].Domain && open[i].Origin.DistanceTo(open[j].Origin) <= near)
                        score++;
            foreach (BuiltInCategory category in new[] { BuiltInCategory.OST_ElectricalFixtures, BuiltInCategory.OST_LightingFixtures })
            {
                foreach (Element element in new FilteredElementCollector(doc).OfCategory(category).WhereElementIsNotElementType())
                    ScoreDevice(element, ref score, skipped);
            }
            foreach (Element element in new FilteredElementCollector(doc).OfClass(typeof(ElectricalSystem)))
            {
                if (element is not ElectricalSystem system) { skipped?.Add(element); continue; }
                if (system.SystemType != ElectricalSystemType.PowerCircuit) continue;
                int loads = 0;
                try { foreach (Element member in system.Elements) if (member != null) loads++; } catch (Exception) { continue; }
                if (loads == 0) score++;
            }
            return score;
        }

        private static void ScoreDevice(Element element, ref int score, FmcNonFamily skipped)
        {
            if (element is not FamilyInstance device)
            {
                skipped?.Add(element);
                return;
            }
            bool power = false;
            try
            {
                ConnectorSet set = device.MEPModel?.ConnectorManager?.Connectors;
                if (set == null) return;
                foreach (Connector connector in set)
                    if (connector.Domain == Domain.DomainElectrical && connector.ElectricalSystemType == ElectricalSystemType.PowerCircuit) power = true;
            }
            catch (Exception) { return; }
            if (!power) return;
            int circuits = 0;
            try { circuits = device.MEPModel?.GetElectricalSystems()?.Count(system => system.SystemType == ElectricalSystemType.PowerCircuit) ?? 0; }
            catch (Exception) { circuits = 0; }
            if (circuits == 0) score++;
        }

        private static void Collect(ConnectorManager manager, List<Connector> open, ref int score, double sizeTolMm)
        {
            if (manager == null) return;
            foreach (Connector connector in manager.Connectors)
            {
                try
                {
                    if (connector.Domain != Domain.DomainPiping && connector.Domain != Domain.DomainHvac) continue;
                    if (connector.ConnectorType == ConnectorType.Logical || connector.ConnectorType == ConnectorType.Curve) continue;
                    if (!connector.IsConnected) { open.Add(connector); score++; continue; }
                    foreach (Connector other in connector.AllRefs)
                    {
                        if (other?.Owner == null || other.Owner.Id == connector.Owner.Id) continue;
                        double left = connector.Shape == ConnectorProfileType.Round ? connector.Radius * 2 : connector.Width;
                        double right = other.Shape == ConnectorProfileType.Round ? other.Radius * 2 : other.Width;
                        if (left > 0 && right > 0 && Math.Abs(left - right) * FeetToMm > sizeTolMm) score++;
                        break;
                    }
                }
                catch (Exception) { /* one connector is not a reason to stop the score */ }
            }
        }

    }
}
