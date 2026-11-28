using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>Free conduit and cable-tray ends. No transaction.</summary>
    public class FmcConduitHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double FeetToMm = 304.8;
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft conduit scan";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    string domain = (Parameters.Value<string>("domain") ?? "conduit").Trim().ToLowerInvariant();
                    var ends = new JArray();
                    var skipped = new FmcNonFamily();
                    int conduits = 0, trays = 0, conduitFittings = 0, trayFittings = 0, connectorsRead = 0, connectedEnds = 0;
                    var categories = new List<BuiltInCategory>();
                    if (domain != "tray") { categories.Add(BuiltInCategory.OST_Conduit); categories.Add(BuiltInCategory.OST_ConduitFitting); }
                    if (domain != "conduit") { categories.Add(BuiltInCategory.OST_CableTray); categories.Add(BuiltInCategory.OST_CableTrayFitting); }
                    foreach (Element element in new FilteredElementCollector(doc).WherePasses(new ElementMulticategoryFilter(categories)).WhereElementIsNotElementType())
                    {
                        if (element is not MEPCurve && element is not FamilyInstance)
                        {
                            skipped.Add(element);
                            continue;
                        }
                        long cat = element.Category?.Id.Value ?? 0;
                        if (element is Conduit) conduits++;
                        else if (element is CableTray) trays++;
                        else if (cat == (long)BuiltInCategory.OST_ConduitFitting) conduitFittings++;
                        else if (cat == (long)BuiltInCategory.OST_CableTrayFitting) trayFittings++;
                        ConnectorManager manager = element is MEPCurve curve ? curve.ConnectorManager : ((FamilyInstance)element).MEPModel?.ConnectorManager;
                        if (manager == null) continue;
                        foreach (Connector connector in manager.Connectors)
                        {
                            try
                            {
                                if (connector.ConnectorType != ConnectorType.End) continue;
                                connectorsRead++;
                                bool connected = false;
                                try { connected = connector.IsConnected; } catch (Exception) { connected = false; }
                                if (connected) { connectedEnds++; continue; }
                                double size = 0;
                                try { size = connector.Radius * 2 * FeetToMm; } catch (Exception) { size = 0; }
                                var direction = new JArray();
                                try
                                {
                                    Transform frame = connector.CoordinateSystem;
                                    if (frame != null) direction = new JArray(frame.BasisZ.X, frame.BasisZ.Y, frame.BasisZ.Z);
                                }
                                catch (Exception) { /* no axis */ }
                                ElementId typeId = element.GetTypeId();
                                ends.Add(new JObject
                                {
                                    ["element_id"] = element.Id.Value,
                                    ["index"] = connector.Id,
                                    ["size_mm"] = Math.Round(size, 1),
                                    ["origin"] = new JArray(connector.Origin.X * FeetToMm, connector.Origin.Y * FeetToMm, connector.Origin.Z * FeetToMm),
                                    ["direction"] = direction,
                                    ["kind"] = element is Conduit or CableTray ? "curve" : "fitting",
                                    ["type_id"] = typeId?.Value ?? 0,
                                    ["type_name"] = (doc.GetElement(typeId) as ElementType)?.Name ?? "",
                                    ["connected"] = false,
                                });
                            }
                            catch (Exception) { skipped.Add(element); }
                        }
                    }
                    string typeName = Parameters.Value<string>("type_name") ?? "";
                    ConduitType conduitType = FindConduitType(doc, typeName);
                    var sizes = new JArray();
                    var fittingFlags = new JObject { ["elbow"] = false, ["union"] = false, ["tee"] = false, ["cross"] = false, ["transition"] = false };
                    if (conduitType != null)
                    {
                        fittingFlags["elbow"] = conduitType.Elbow != null;
                        fittingFlags["union"] = conduitType.Union != null;
                        fittingFlags["tee"] = conduitType.Tee != null;
                        fittingFlags["cross"] = conduitType.Cross != null;
                        fittingFlags["transition"] = conduitType.Transition != null;
                        try
                        {
                            ConduitSizeSettings settings = ConduitSizeSettings.GetConduitSizeSettings(doc);
                            string standard = StandardName(settings, conduitType);
                            foreach (KeyValuePair<string, ConduitSizes> entry in settings)
                            {
                                if (!string.IsNullOrEmpty(standard) && !string.Equals(entry.Key, standard, StringComparison.OrdinalIgnoreCase)) continue;
                                foreach (ConduitSize size in entry.Value)
                                    sizes.Add(Math.Round(size.NominalDiameter * FeetToMm, 2));
                            }
                        }
                        catch (Exception) { /* the size table is reported empty and the sizes action can still try */ }
                    }
                    var loaded = new JArray();
                    foreach (FamilySymbol symbol in new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>())
                    {
                        string label = ((symbol.FamilyName ?? "") + " " + symbol.Name).Trim();
                        if (label.Length == 0) continue;
                        long category = symbol.Category?.Id.Value ?? 0;
                        if (category == (long)BuiltInCategory.OST_ConduitFitting || category == (long)BuiltInCategory.OST_CableTrayFitting || category == (long)BuiltInCategory.OST_ElectricalFixtures)
                            loaded.Add(label);
                    }
                    Result["model"] = doc.Title;
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                    Result["is_central"] = false;
                    Result["ends"] = ends;
                    Result["counts"] = new JObject
                    {
                        ["conduits"] = conduits, ["trays"] = trays, ["conduit_fittings"] = conduitFittings, ["tray_fittings"] = trayFittings,
                        ["end_connectors_read"] = connectorsRead, ["connected_ends"] = connectedEnds, ["free_ends"] = ends.Count,
                    };
                    Result["sizes_mm"] = sizes;
                    Result["fittings"] = fittingFlags;
                    Result["fitting_types_loaded"] = loaded;
                    Result["skipped_non_family"] = skipped.Report();
                    Result["read_only"] = true;
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        internal static ConduitType FindConduitType(Document doc, string name)
        {
            var types = new FilteredElementCollector(doc).OfClass(typeof(ConduitType)).Cast<ConduitType>().ToList();
            if (!string.IsNullOrWhiteSpace(name))
                return types.FirstOrDefault(type => string.Equals(type.Name, name, StringComparison.OrdinalIgnoreCase));
            return types.FirstOrDefault();
        }

        internal static string StandardName(ConduitSizeSettings settings, ConduitType type)
        {
            string named = type?.LookupParameter("Standard")?.AsString() ?? "";
            if (!string.IsNullOrWhiteSpace(named) && settings.DoesConduitStandardTypeExist(named)) return named;
            foreach (KeyValuePair<string, ConduitSizes> entry in settings) return entry.Key;
            return "";
        }

        internal static IEnumerable<ConduitSize> Sizes(ConduitSizeSettings settings, string standard)
        {
            foreach (KeyValuePair<string, ConduitSizes> entry in settings)
            {
                if (!string.IsNullOrEmpty(standard) && !string.Equals(entry.Key, standard, StringComparison.OrdinalIgnoreCase)) continue;
                foreach (ConduitSize size in entry.Value) yield return size;
            }
        }
    }

    /// <summary>
    /// One transaction. Each fitting is a subtransaction, and a failure preprocessor deletes elements
    /// that only fail when the transaction commits, so the rest of the batch is kept.
    /// </summary>
    public class FmcConduitApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double FeetToMm = 304.8;
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft conduit fix";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            var done = new JArray();
            var failed = new JArray();
            try
            {
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    Refuse(doc);
                    string mode = (Parameters.Value<string>("mode") ?? "fix").Trim();
                    bool committed = false;
                    using (var transaction = new Transaction(doc, "Formcraft conduit"))
                    {
                        transaction.Start();
                        var options = transaction.GetFailureHandlingOptions();
                        var preprocessor = new ConduitFailures();
                        options.SetFailuresPreprocessor(preprocessor);
                        options.SetClearAfterRollback(true);
                        transaction.SetFailureHandlingOptions(options);
                        if (mode == "sizes") AddSizes(doc, done, failed);
                        else if (mode == "fittings") SetFittings(doc, done, failed);
                        else Fix(doc, done, failed);
                        foreach (string message in preprocessor.Notes) failed.Add(new JObject { ["error"] = message, ["at"] = "commit" });
                        transaction.Commit();
                        committed = true;
                    }
                    Result["applied"] = committed && failed.Count == 0 && (done.Count > 0 || mode != "fix");
                    if (mode == "fix" && done.Count == 0) Result["applied"] = false;
                    if (mode != "fix" && done.Count > 0) Result["applied"] = committed;
                    Result["done"] = done;
                    Result["failed"] = failed;
                    Result["saved"] = false;
                    Result["model"] = doc.Title;
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                    Result["note"] = "Each fitting was its own subtransaction. A size is covered when it is in the size table and the conduit type has the fitting set. Revit resolves the fitting family when that subtransaction commits.";
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

        private void Fix(Document doc, JArray done, JArray failed)
        {
            bool resize = Parameters.Value<bool?>("resize_fallback") == true;
            string material = Parameters.Value<string>("comment_material") ?? "PVC";
            bool junction = Parameters.Value<bool?>("junction") == true;
            string junctionName = Parameters.Value<string>("junction_family") ?? "";
            foreach (JObject op in (Parameters["ops"] as JArray ?? new JArray()).OfType<JObject>())
            {
                using (var sub = new SubTransaction(doc))
                {
                    sub.Start();
                    try
                    {
                        string kind = (op.Value<string>("op") ?? "").Trim();
                        Connector a = Find(doc, op.Value<long?>("a") ?? 0, op.Value<int?>("ai") ?? 0);
                        Connector b = Find(doc, op.Value<long?>("b") ?? 0, op.Value<int?>("bi") ?? 0);
                        if (a == null || b == null) throw new InvalidOperationException("A connector in the plan is not in the document.");
                        if (doc.GetElement(a.Owner.Id) is DirectShape || doc.GetElement(b.Owner.Id) is DirectShape)
                            throw new InvalidOperationException("DirectShape skipped.");
                        long createdId = 0;
                        if (kind == "extend") Extend(a, b);
                        else if (kind == "elbow") createdId = doc.Create.NewElbowFitting(a, b)?.Id.Value ?? 0;
                        else if (kind == "union") createdId = doc.Create.NewUnionFitting(a, b)?.Id.Value ?? 0;
                        else if (kind == "transition") createdId = doc.Create.NewTransitionFitting(a, b)?.Id.Value ?? 0;
                        else if (kind == "junction") createdId = PlaceJunction(doc, a, junctionName);
                        else throw new InvalidOperationException("Unknown conduit op " + kind);
                        sub.Commit();
                        var row = new JObject { ["op"] = kind, ["ok"] = true, ["a"] = op["a"], ["b"] = op["b"] };
                        if (createdId > 0) row["created_id"] = createdId;
                        done.Add(row);
                    }
                    catch (Exception ex)
                    {
                        try { sub.RollBack(); } catch (Exception) { /* already closed */ }
                        if (resize && (ex.Message ?? "").IndexOf("size", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            using (var again = new SubTransaction(doc))
                            {
                                again.Start();
                                try
                                {
                                    ResizeNearest(doc, op, material);
                                    again.Commit();
                                    done.Add(new JObject { ["op"] = "resize_nearest", ["ok"] = true, ["a"] = op["a"], ["comment"] = "nominal " + (op.Value<double?>("size_mm") ?? 0) + " mm " + material });
                                    continue;
                                }
                                catch (Exception inner)
                                {
                                    try { again.RollBack(); } catch (Exception) { /* already closed */ }
                                    failed.Add(new JObject { ["op"] = op.Value<string>("op"), ["error"] = inner.Message, ["a"] = op["a"] });
                                    continue;
                                }
                            }
                        }
                        string message = ex.Message ?? "";
                        if (message.IndexOf("fitting", StringComparison.OrdinalIgnoreCase) >= 0 || junction && message.IndexOf("junction", StringComparison.OrdinalIgnoreCase) >= 0)
                            failed.Add(new JObject { ["code"] = "FMC-NO-FITTING-TYPE", ["op"] = op.Value<string>("op"), ["error"] = message, ["a"] = op["a"] });
                        else failed.Add(new JObject { ["op"] = op.Value<string>("op"), ["error"] = message, ["a"] = op["a"] });
                    }
                }
            }
        }

        private void AddSizes(Document doc, JArray done, JArray failed)
        {
            ConduitType type = FmcConduitHandler.FindConduitType(doc, Parameters.Value<string>("type_name") ?? "");
            ConduitSizeSettings settings = ConduitSizeSettings.GetConduitSizeSettings(doc);
            string standard = Parameters.Value<string>("standard_name");
            if (string.IsNullOrWhiteSpace(standard)) standard = type == null ? "" : FmcConduitHandler.StandardName(settings, type);
            if (string.IsNullOrWhiteSpace(standard)) { failed.Add(new JObject { ["error"] = "No conduit standard name. Pass standard_name." }); return; }
            foreach (JObject row in (Parameters["sizes"] as JArray ?? new JArray()).OfType<JObject>())
            {
                double nominal = row.Value<double?>("nominal_mm") ?? 0;
                double inner = row.Value<double?>("id_mm") ?? 0;
                double outer = row.Value<double?>("od_mm") ?? 0;
                double bend = row.Value<double?>("bend_mm") ?? nominal * 4;
                if (nominal <= 0 || inner <= 0 || outer <= 0) { failed.Add(new JObject { ["error"] = "A size needs nominal_mm, id_mm and od_mm." }); continue; }
                using (var sub = new SubTransaction(doc))
                {
                    sub.Start();
                    try
                    {
                        var size = new ConduitSize(nominal / FeetToMm, inner / FeetToMm, outer / FeetToMm, bend / FeetToMm, true, true);
                        settings.AddSize(standard, size);
                        sub.Commit();
                        bool elbow = type?.Elbow != null;
                        bool union = type?.Union != null;
                        bool transition = type?.Transition != null;
                        done.Add(new JObject
                        {
                            ["nominal_mm"] = nominal, ["added"] = true, ["in_table"] = true,
                            ["fittings_set"] = elbow && union && transition,
                            ["note"] = "The size is in the table. Routing coverage is not a separate API: Revit looks up the fitting when a subtransaction commits, and only if elbow, union and transition are set on the type.",
                        });
                    }
                    catch (Exception ex)
                    {
                        try { sub.RollBack(); } catch (Exception) { /* already closed */ }
                        failed.Add(new JObject { ["nominal_mm"] = nominal, ["error"] = ex.Message });
                    }
                }
            }
        }

        private void SetFittings(Document doc, JArray done, JArray failed)
        {
            ConduitType type = FmcConduitHandler.FindConduitType(doc, Parameters.Value<string>("type_name") ?? "");
            if (type == null) { failed.Add(new JObject { ["code"] = "FMC-NO-FITTING-TYPE", ["error"] = "Conduit type was not found." }); return; }
            void Set(string role, string name)
            {
                if (string.IsNullOrWhiteSpace(name)) return;
                FamilySymbol symbol = FindSymbol(doc, name);
                if (symbol == null) { failed.Add(new JObject { ["code"] = "FMC-NO-FITTING-TYPE", ["role"] = role, ["error"] = name + " is not loaded." }); return; }
                if (!symbol.IsActive) symbol.Activate();
                if (role == "elbow") type.Elbow = symbol;
                else if (role == "union") type.Union = symbol;
                else if (role == "tee") type.Tee = symbol;
                else if (role == "cross") type.Cross = symbol;
                else if (role == "transition") type.Transition = symbol;
                done.Add(new JObject { ["role"] = role, ["type"] = symbol.FamilyName + " " + symbol.Name, ["ok"] = true });
            }
            Set("elbow", Parameters.Value<string>("elbow"));
            Set("union", Parameters.Value<string>("union"));
            Set("tee", Parameters.Value<string>("tee"));
            Set("cross", Parameters.Value<string>("cross"));
            Set("transition", Parameters.Value<string>("transition"));
        }

        private static void Extend(Connector a, Connector b)
        {
            if (a.Owner is MEPCurve curve && curve.Location is LocationCurve located && located.Curve is Line line)
            {
                XYZ end0 = line.GetEndPoint(0);
                XYZ end1 = line.GetEndPoint(1);
                bool start = a.Origin.DistanceTo(end0) <= a.Origin.DistanceTo(end1);
                XYZ target = b.Origin;
                located.Curve = start ? Line.CreateBound(target, end1) : Line.CreateBound(end0, target);
            }
            a.ConnectTo(b);
        }

        private static long PlaceJunction(Document doc, Connector connector, string family)
        {
            FamilySymbol symbol = FindSymbol(doc, family);
            if (symbol == null) throw new InvalidOperationException("FMC-NO-FITTING-TYPE " + family + " is not loaded.");
            if (!symbol.IsActive) symbol.Activate();
            FamilyInstance placed = doc.Create.NewFamilyInstance(connector.Origin, symbol, Autodesk.Revit.DB.Structure.StructuralType.NonStructural);
            Connector mate = null;
            foreach (Connector other in placed.MEPModel.ConnectorManager.Connectors) { mate = other; break; }
            if (mate == null) throw new InvalidOperationException("FMC-NO-FITTING-TYPE The junction box has no connector.");
            connector.ConnectTo(mate);
            return placed.Id.Value;
        }

        private static void ResizeNearest(Document doc, JObject op, string material)
        {
            double nominal = op.Value<double?>("size_mm") ?? 0;
            if (!(doc.GetElement(new ElementId(op.Value<long?>("a") ?? 0)) is MEPCurve curve))
                throw new InvalidOperationException("Resize applies to a conduit curve.");
            Parameter diameter = curve.get_Parameter(BuiltInParameter.RBS_CONDUIT_DIAMETER_PARAM);
            if (diameter == null || diameter.IsReadOnly) throw new InvalidOperationException("Conduit diameter is read-only.");
            ConduitSizeSettings settings = ConduitSizeSettings.GetConduitSizeSettings(doc);
            string standard = FmcConduitHandler.StandardName(settings, curve.Document.GetElement(curve.GetTypeId()) as ConduitType);
            double best = 0;
            double bestDelta = double.MaxValue;
            foreach (ConduitSize size in FmcConduitHandler.Sizes(settings, standard))
            {
                double mm = size.NominalDiameter * FeetToMm;
                double delta = Math.Abs(mm - nominal);
                if (delta < bestDelta) { bestDelta = delta; best = size.NominalDiameter; }
            }
            if (best <= 0) throw new InvalidOperationException("The size table has no size to fall back to.");
            diameter.Set(best);
            Parameter comments = curve.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS);
            if (comments != null && !comments.IsReadOnly) comments.Set("nominal " + nominal + " mm " + material);
        }

        private static Connector Find(Document doc, long elementId, int index)
        {
            Element element = doc.GetElement(new ElementId(elementId));
            ConnectorManager manager = element is MEPCurve curve ? curve.ConnectorManager : element is FamilyInstance instance ? instance.MEPModel?.ConnectorManager : null;
            if (manager == null) return null;
            foreach (Connector connector in manager.Connectors)
                if (connector.Id == index) return connector;
            return null;
        }

        private static FamilySymbol FindSymbol(Document doc, string name)
        {
            string want = (name ?? "").Trim();
            if (want.Length == 0) return null;
            return new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().FirstOrDefault(symbol =>
                string.Equals(symbol.Name, want, StringComparison.OrdinalIgnoreCase)
                || string.Equals(symbol.FamilyName, want, StringComparison.OrdinalIgnoreCase)
                || string.Equals(((symbol.FamilyName ?? "") + " " + symbol.Name).Trim(), want, StringComparison.OrdinalIgnoreCase));
        }

        private static void Refuse(Document doc)
        {
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (Regex.IsMatch(blob, "hebert hostels", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("HEBERT HOSTELS is not written by fmc_conduit.");
            if (doc.IsWorkshared && !string.IsNullOrEmpty(doc.PathName))
            {
                try
                {
                    string central = ModelPathUtils.ConvertModelPathToUserVisiblePath(doc.GetWorksharingCentralModelPath());
                    if (!string.IsNullOrEmpty(central) && string.Equals(Path.GetFullPath(central), Path.GetFullPath(doc.PathName), StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("A central model is not written by fmc_conduit.");
                }
                catch (InvalidOperationException) { throw; }
                catch (Exception) { /* checked again by the server */ }
            }
        }

        private sealed class ConduitFailures : IFailuresPreprocessor
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
