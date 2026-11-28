using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Pipe and duct types (with their routing preferences, read only), system types and levels for a route. No transaction.
    /// </summary>
    public class FmcMepRouteHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft MEP route scan";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    bool duct = string.Equals(Parameters.Value<string>("kind"), "duct", StringComparison.OrdinalIgnoreCase);
                    var curveTypes = new JArray();
                    IEnumerable<MEPCurveType> types = duct
                        ? new FilteredElementCollector(doc).OfClass(typeof(DuctType)).Cast<MEPCurveType>()
                        : new FilteredElementCollector(doc).OfClass(typeof(PipeType)).Cast<MEPCurveType>();
                    foreach (MEPCurveType type in types) curveTypes.Add(FmcMepSystemsHandler.RoutingRow(doc, type));
                    var systemTypes = new JArray();
                    foreach (MEPSystemType t in new FilteredElementCollector(doc).OfClass(typeof(MEPSystemType)).Cast<MEPSystemType>())
                    {
                        if (duct ? !(t is MechanicalSystemType) : !(t is PipingSystemType)) continue;
                        systemTypes.Add(new JObject { ["id"] = t.Id.Value, ["name"] = t.Name, ["classification"] = t.SystemClassification.ToString() });
                    }
                    var levels = new JArray();
                    foreach (Level level in new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => l.Elevation))
                        levels.Add(new JObject { ["id"] = level.Id.Value, ["name"] = level.Name, ["elevation_mm"] = Math.Round(level.Elevation * FmcMepRouteApplyHandler.FeetToMm, 1) });
                    bool central = false;
                    try
                    {
                        if (doc.IsWorkshared && !string.IsNullOrEmpty(doc.PathName))
                        {
                            string c = ModelPathUtils.ConvertModelPathToUserVisiblePath(doc.GetWorksharingCentralModelPath());
                            central = !string.IsNullOrEmpty(c) && string.Equals(Path.GetFullPath(c), Path.GetFullPath(doc.PathName), StringComparison.OrdinalIgnoreCase);
                        }
                    }
                    catch (Exception) { /* checked again by the apply handler */ }
                    Result["model"] = doc.Title;
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                    Result["is_central"] = central;
                    Result["kind"] = duct ? "duct" : "pipe";
                    Result["curve_types"] = curveTypes;
                    Result["system_types"] = systemTypes;
                    Result["levels"] = levels;
                    Result["read_only"] = true;
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }
    }

    /// <summary>
    /// One transaction. Each pipe or duct piece is its own subtransaction, then each fitting is its own subtransaction,
    /// with a failure preprocessor (the FmcConduitWork pattern), so one failed fitting does not roll back the rest.
    /// Fittings come from the type's routing preferences as they are; nothing here writes a routing preference.
    /// </summary>
    public class FmcMepRouteApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        internal const double FeetToMm = 304.8;
        private const double SnapFeet = 2.0 / FeetToMm;
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft MEP route place";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            var done = new JArray();
            var failed = new JArray();
            var created = new JArray();
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    Refuse(doc);
                    bool duct = string.Equals(Parameters.Value<string>("kind"), "duct", StringComparison.OrdinalIgnoreCase);
                    var typeId = new ElementId(Parameters.Value<long?>("type_id") ?? 0);
                    var systemTypeId = new ElementId(Parameters.Value<long?>("system_type_id") ?? 0);
                    var levelId = new ElementId(Parameters.Value<long?>("level_id") ?? 0);
                    var curveType = doc.GetElement(typeId) as MEPCurveType;
                    if (curveType == null || (duct ? !(curveType is DuctType) : !(curveType is PipeType))) throw new InvalidOperationException("The " + (duct ? "duct" : "pipe") + " type was not found.");
                    if (!(doc.GetElement(systemTypeId) is MEPSystemType)) throw new InvalidOperationException("The system type was not found.");
                    if (!(doc.GetElement(levelId) is Level)) throw new InvalidOperationException("The level was not found.");
                    double sizeMm = Parameters.Value<double?>("size_mm") ?? 0;
                    var pieces = new List<MEPCurve>();
                    bool committed = false;
                    using (var transaction = new Transaction(doc, "Formcraft MEP route"))
                    {
                        transaction.Start();
                        var options = transaction.GetFailureHandlingOptions();
                        var preprocessor = new RouteFailures();
                        options.SetFailuresPreprocessor(preprocessor);
                        options.SetClearAfterRollback(true);
                        transaction.SetFailureHandlingOptions(options);
                        foreach (JObject piece in (Parameters["pieces"] as JArray ?? new JArray()).OfType<JObject>())
                        {
                            using (var sub = new SubTransaction(doc))
                            {
                                sub.Start();
                                try
                                {
                                    XYZ a = Point(piece["from"]), b = Point(piece["to"]);
                                    if (a.DistanceTo(b) < doc.Application.ShortCurveTolerance) throw new InvalidOperationException("The piece is too short.");
                                    MEPCurve curve = duct
                                        ? (MEPCurve)Duct.Create(doc, systemTypeId, typeId, levelId, a, b)
                                        : Pipe.Create(doc, systemTypeId, typeId, levelId, a, b);
                                    if (sizeMm > 0)
                                    {
                                        Parameter diameter = curve.get_Parameter(duct ? BuiltInParameter.RBS_CURVE_DIAMETER_PARAM : BuiltInParameter.RBS_PIPE_DIAMETER_PARAM);
                                        if (diameter != null && !diameter.IsReadOnly) diameter.Set(sizeMm / FeetToMm);
                                    }
                                    sub.Commit();
                                    pieces.Add(curve);
                                    created.Add(curve.Id.Value);
                                    done.Add(new JObject { ["op"] = "piece", ["ok"] = true, ["run"] = piece["run"], ["index"] = piece["index"], ["id"] = curve.Id.Value });
                                }
                                catch (Exception ex)
                                {
                                    try { sub.RollBack(); } catch (Exception) { /* already closed */ }
                                    failed.Add(new JObject { ["op"] = "piece", ["run"] = piece["run"], ["index"] = piece["index"], ["error"] = ex.Message });
                                }
                            }
                        }
                        foreach (JObject fit in (Parameters["fittings"] as JArray ?? new JArray()).OfType<JObject>())
                        {
                            string op = (fit.Value<string>("op") ?? "").Trim();
                            using (var sub = new SubTransaction(doc))
                            {
                                sub.Start();
                                try
                                {
                                    XYZ at = Point(fit["at"]);
                                    List<Connector> free = FreeConnectorsAt(pieces, at);
                                    FamilyInstance placed;
                                    if (op == "elbow")
                                    {
                                        if (free.Count < 2) throw new InvalidOperationException("Two free ends are not at the corner.");
                                        placed = doc.Create.NewElbowFitting(free[0], free[1]);
                                    }
                                    else if (op == "union")
                                    {
                                        if (free.Count < 2) throw new InvalidOperationException("Two free ends are not at the joint.");
                                        placed = doc.Create.NewUnionFitting(free[0], free[1]);
                                    }
                                    else if (op == "tee")
                                    {
                                        if (free.Count < 3) throw new InvalidOperationException("Three free ends are not at the tee.");
                                        (Connector m1, Connector m2, Connector branch) = TeeOrder(free);
                                        placed = doc.Create.NewTeeFitting(m1, m2, branch);
                                    }
                                    else if (op == "cap")
                                    {
                                        if (free.Count < 1) throw new InvalidOperationException("No free end at the cap point.");
                                        ElementId capType = CapPart(curveType);
                                        if (capType == ElementId.InvalidElementId) throw new InvalidOperationException("FMC-NO-FITTING-TYPE The type has no cap rule.");
                                        PlumbingUtils.PlaceCapOnOpenEnds(doc, free[0].Owner.Id, capType);
                                        placed = null;
                                    }
                                    else throw new InvalidOperationException("Unknown fitting op " + op);
                                    sub.Commit();
                                    if (placed != null) created.Add(placed.Id.Value);
                                    done.Add(new JObject { ["op"] = op, ["ok"] = true, ["run"] = fit["run"], ["id"] = placed?.Id.Value });
                                }
                                catch (Exception ex)
                                {
                                    try { sub.RollBack(); } catch (Exception) { /* already closed */ }
                                    string message = ex.Message ?? "";
                                    var row = new JObject { ["op"] = op, ["run"] = fit["run"], ["error"] = message };
                                    if (message.IndexOf("fitting", StringComparison.OrdinalIgnoreCase) >= 0 || message.IndexOf("routing", StringComparison.OrdinalIgnoreCase) >= 0)
                                        row["code"] = "FMC-NO-FITTING-TYPE";
                                    failed.Add(row);
                                }
                            }
                        }
                        foreach (string message in preprocessor.Notes) failed.Add(new JObject { ["error"] = message, ["at"] = "commit" });
                        transaction.Commit();
                        committed = true;
                    }
                    Result["applied"] = committed && pieces.Count > 0;
                    Result["complete"] = committed && failed.Count == 0;
                    Result["done"] = done;
                    Result["failed"] = failed;
                    Result["created_ids"] = created;
                    Result["saved"] = false;
                    Result["model"] = doc.Title;
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                    Result["note"] = "Each piece and each fitting was its own subtransaction. Fittings are the type's routing preferences as they are; none was changed.";
                }
            }
            catch (Exception ex)
            {
                Error = ex.Message;
                Result["applied"] = false;
                Result["done"] = done;
                Result["failed"] = failed;
            }
            finally { _done.Set(); }
        }

        private static XYZ Point(JToken token)
        {
            var a = token as JArray;
            if (a == null || a.Count < 3) throw new InvalidOperationException("A point needs [x, y, z] in mm.");
            return new XYZ(a[0].Value<double>() / FeetToMm, a[1].Value<double>() / FeetToMm, a[2].Value<double>() / FeetToMm);
        }

        private static List<Connector> FreeConnectorsAt(IEnumerable<MEPCurve> pieces, XYZ at)
        {
            var list = new List<Connector>();
            foreach (MEPCurve curve in pieces)
            {
                if (!curve.IsValidObject) continue;
                foreach (Connector c in curve.ConnectorManager.Connectors)
                {
                    if (c.ConnectorType != ConnectorType.End) continue;
                    bool connected;
                    try { connected = c.IsConnected; } catch (Exception) { connected = false; }
                    if (!connected && c.Origin.DistanceTo(at) <= SnapFeet) list.Add(c);
                }
            }
            return list;
        }

        /// <summary>The two ends whose directions are most nearly opposite are the main run; the other is the branch.</summary>
        private static (Connector, Connector, Connector) TeeOrder(List<Connector> ends)
        {
            double best = double.MaxValue;
            (int, int) pair = (0, 1);
            for (int i = 0; i < ends.Count; i++)
                for (int j = i + 1; j < ends.Count; j++)
                {
                    double dot = ends[i].CoordinateSystem.BasisZ.DotProduct(ends[j].CoordinateSystem.BasisZ);
                    if (dot < best) { best = dot; pair = (i, j); }
                }
            Connector branch = ends.Where((_, k) => k != pair.Item1 && k != pair.Item2).First();
            return (ends[pair.Item1], ends[pair.Item2], branch);
        }

        /// <summary>The first cap rule on the type's routing preferences, read only.</summary>
        private static ElementId CapPart(MEPCurveType type)
        {
            try
            {
                RoutingPreferenceManager rpm = type.RoutingPreferenceManager;
                if (rpm.GetNumberOfRules(RoutingPreferenceRuleGroupType.Caps) > 0)
                    return rpm.GetRule(RoutingPreferenceRuleGroupType.Caps, 0).MEPPartId;
            }
            catch (Exception) { /* no cap rule */ }
            return ElementId.InvalidElementId;
        }

        private static void Refuse(Document doc)
        {
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (Regex.IsMatch(blob, "hebert hostels", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("HEBERT HOSTELS is not written by fmc_mep_route.");
            if (doc.IsWorkshared && !string.IsNullOrEmpty(doc.PathName))
            {
                try
                {
                    string central = ModelPathUtils.ConvertModelPathToUserVisiblePath(doc.GetWorksharingCentralModelPath());
                    if (!string.IsNullOrEmpty(central) && string.Equals(Path.GetFullPath(central), Path.GetFullPath(doc.PathName), StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("A central model is not written by fmc_mep_route.");
                }
                catch (InvalidOperationException) { throw; }
                catch (Exception) { /* checked again by the server */ }
            }
        }

        private sealed class RouteFailures : IFailuresPreprocessor
        {
            public List<string> Notes { get; } = new List<string>();
            public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor)
            {
                accessor.DeleteAllWarnings();
                foreach (FailureMessageAccessor failure in accessor.GetFailureMessages().ToList())
                {
                    if (failure.GetSeverity() == FailureSeverity.Warning)
                    {
                        accessor.DeleteWarning(failure);
                        continue;
                    }
                    IList<ElementId> ids = failure.GetFailingElementIds()?.ToList();
                    Notes.Add(failure.GetDescriptionText());
                    if (ids != null && ids.Count > 0) accessor.DeleteElements(ids.ToList());
                    else return FailureProcessingResult.ProceedWithRollBack;
                }
                return FailureProcessingResult.Continue;
            }
        }
    }
}
