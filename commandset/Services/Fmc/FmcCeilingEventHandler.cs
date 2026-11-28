using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Ceilings (docs/PLAN_CEILINGS.md) on the Revit main thread. place (CL2) builds a ceiling design planned by the server
    /// (server/src/fmc/ceiling/place.ts; every position in model mm, heights above the level): a ceiling of the kit's I.CLG
    /// type for each part of each zone, the step faces, cove, cornice and coffer mouldings with line-based families when
    /// they are loaded (the rest are reported as kit change requests: families are never invented, rule 7), and the
    /// fixtures as marks only (model lines), because the engineers design lights, fans and detectors (rule 5). edit removes
    /// what the last place made (its UniqueIds, from the server's record) and builds the design again. sheet (CL4) draws the
    /// set-out and section drafting views, the RCP and the sheet (FmcCeilingSheet). Everything runs in one transaction
    /// group: a dry run is the real run rolled back; a real run is one Undo. The server sends real runs through the lock.
    /// </summary>
    public class FmcCeilingEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public string Action { get; set; } = "";
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "FMC ceilings";

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try
            {
                using var target = FmcTarget.Resolve(app, Parameters, mayOpen: false);
                Document doc = target.Doc;
                if (doc.IsFamilyDocument) throw new InvalidOperationException("Ceilings are placed in a project model, not a family.");
                switch (Action)
                {
                    case "place": Result = FmcCeilingPlace.Run(doc, Parameters, false); break;
                    case "edit": Result = FmcCeilingPlace.Run(doc, Parameters, true); break;
                    case "sheet": Result = FmcCeilingSheet.Run(doc, Parameters); break;
                    default: Error = $"Unknown FMC ceiling action '{Action}'"; break;
                }
            }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }
    }

    /// <summary>Collects Revit's warnings instead of showing them (a dialog would block the bridge).</summary>
    internal sealed class FmcWarningCollector : IFailuresPreprocessor
    {
        public readonly List<string> Warnings = new List<string>();
        public FailureProcessingResult PreprocessFailures(FailuresAccessor a)
        {
            foreach (FailureMessageAccessor f in a.GetFailureMessages())
                if (f.GetSeverity() == FailureSeverity.Warning) { Warnings.Add(f.GetDescriptionText()); a.DeleteWarning(f); }
            return FailureProcessingResult.Continue;
        }

        public static FmcWarningCollector On(Transaction t)
        {
            var c = new FmcWarningCollector();
            var o = t.GetFailureHandlingOptions();
            o.SetFailuresPreprocessor(c);
            t.SetFailureHandlingOptions(o);
            return c;
        }
    }

    public static class FmcCeilingPlace
    {
        private static double Ft(double mm) => mm / 304.8;

        /// <summary>The words a loaded line-based family's name must hold to draw each line role (any FMC_ family first).</summary>
        private static readonly Dictionary<string, string[]> RoleWords = new Dictionary<string, string[]>
        {
            ["face"] = new[] { "CeilingFace", "BulkheadFace", "Bulkhead_Face", "Ceiling_Face" },
            ["cove"] = new[] { "Cove" },
            ["cornice"] = new[] { "Cornice" },
            ["coffer_moulding"] = new[] { "CofferMould", "Coffer_Mould", "Coffer" },
        };

        private static readonly Dictionary<string, string> RoleNames = new Dictionary<string, string>
        {
            ["face"] = "bulkhead, raft and coffer faces (vertical board between two ceiling heights)",
            ["cove"] = "cove (LED trough at the step)",
            ["cornice"] = "cornice (from the kit's profile sets, FMC_Profile_Cornice_*)",
            ["coffer_moulding"] = "coffer mouldings",
        };

        public static JObject Run(Document doc, JObject p, bool edit)
        {
            bool dry = p.Value<bool?>("dry_run") != false;
            FmcDesignOption.Check(doc, p.Value<string>("design_option") ?? "");
            string room = p.Value<string>("room") ?? "Room";
            string tag = p.Value<string>("tag") ?? ("FMC:CEILING:" + room);
            string levelName = p.Value<string>("level") ?? "";
            Level level = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>()
                .FirstOrDefault(l => string.Equals(l.Name, levelName, StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException($"No level {levelName} in {doc.Title}. Levels: {string.Join(", ", new FilteredElementCollector(doc).OfClass(typeof(Level)).Select(l => l.Name))}");
            string board = p.Value<string>("board") ?? "";
            CeilingType type = PickType(doc, p.Value<string>("ceiling_type") ?? "", board);

            var notes = new JArray();
            var kcr = new JArray();
            var notPlaced = new JArray();
            var made = new List<(Element e, string key)>();
            int removed = 0, ceilings = 0, lines = 0, marks = 0;
            var replace = (p["replace"] as JArray ?? new JArray()).Select(x => x.Value<string>()).Where(x => !string.IsNullOrEmpty(x)).ToList();
            if (edit && replace.Count == 0) notes.Add("Nothing recorded to replace: the design is placed as new.");
            List<string> warnings;

            using (var group = new TransactionGroup(doc, (edit ? "Formcraft: ceiling edit " : "Formcraft: ceiling ") + room))
            {
                group.Start();
                using (var t = new Transaction(doc, "Formcraft: ceiling " + room))
                {
                    var collector = FmcWarningCollector.On(t);
                    t.Start();
                    // edit: what the last place made goes first (only the elements the server recorded)
                    foreach (string uid in replace)
                    {
                        Element old = doc.GetElement(uid);
                        if (old == null) continue;
                        try { doc.Delete(old.Id); removed++; } catch (Exception) { notes.Add($"{uid} could not be removed"); }
                    }

                    foreach (JObject c in (p["ceilings"] as JArray ?? new JArray()).OfType<JObject>())
                    {
                        string key = c.Value<string>("key") ?? "";
                        try
                        {
                            var loops = new List<CurveLoop>();
                            foreach (JArray loop in (c["loops"] as JArray ?? new JArray()).OfType<JArray>())
                            {
                                var pts = loop.OfType<JArray>().Select(q => new XYZ(Ft(q[0].Value<double>()), Ft(q[1].Value<double>()), level.Elevation)).ToList();
                                var cl = new CurveLoop();
                                for (int i = 0; i < pts.Count; i++) cl.Append(Line.CreateBound(pts[i], pts[(i + 1) % pts.Count]));
                                loops.Add(cl);
                            }
                            Ceiling ceiling = Ceiling.Create(doc, loops, type.Id, level.Id);
                            ceiling.get_Parameter(BuiltInParameter.CEILING_HEIGHTABOVELEVEL_PARAM)?.Set(Ft(c.Value<double>("height_mm")));
                            made.Add((ceiling, key));
                            ceilings++;
                        }
                        catch (Exception e) { notes.Add($"{key}: not placed: {e.Message}"); }
                    }

                    // line features: a loaded line-based family per role, or a kit change request
                    var families = (p["families"] as JObject) ?? new JObject();
                    foreach (var byRole in (p["lines"] as JArray ?? new JArray()).OfType<JObject>().GroupBy(l => l.Value<string>("role") ?? ""))
                    {
                        string role = byRole.Key;
                        FamilySymbol sym = LineFamily(doc, role, families.Value<string>(role) ?? "");
                        if (sym == null)
                        {
                            double m = byRole.Sum(l => l.Value<double?>("length_mm") ?? 0) / 1000.0;
                            string what = RoleNames.TryGetValue(role, out string w) ? w : role;
                            notPlaced.Add(new JObject { ["role"] = role, ["runs"] = byRole.Count(), ["length_m"] = Math.Round(m, 1), ["why"] = "no line-based family for it is loaded" });
                            kcr.Add($"A line-based family for the {what}: built with fmc_doc recipes, through Gate A and released by a person; until then {byRole.Count()} run(s), {Math.Round(m, 1)} m, are not modelled");
                            continue;
                        }
                        if (!sym.IsActive) { sym.Activate(); doc.Regenerate(); }
                        foreach (JObject l in byRole)
                        {
                            string key = l.Value<string>("key") ?? "";
                            try
                            {
                                double z = level.Elevation + Ft(l.Value<double>("z_mm"));
                                var a = l["from"] as JArray; var b = l["to"] as JArray;
                                var curve = Line.CreateBound(new XYZ(Ft(a[0].Value<double>()), Ft(a[1].Value<double>()), z), new XYZ(Ft(b[0].Value<double>()), Ft(b[1].Value<double>()), z));
                                FamilyInstance fi = doc.Create.NewFamilyInstance(curve, sym, level, StructuralType.NonStructural);
                                made.Add((fi, key));
                                lines++;
                            }
                            catch (Exception e) { notes.Add($"{key}: not placed with {sym.FamilyName}: {e.Message}"); }
                        }
                        notes.Add($"{role}: {sym.FamilyName} : {sym.Name}; its own parameters set the profile and drop (check them in Revit)");
                    }

                    // fixture marks: model lines at the ceiling, never fixtures
                    var planes = new Dictionary<double, SketchPlane>();
                    SketchPlane PlaneAt(double z)
                    {
                        double k = Math.Round(z, 6);
                        if (!planes.TryGetValue(k, out SketchPlane sp))
                            planes[k] = sp = SketchPlane.Create(doc, Plane.CreateByNormalAndOrigin(XYZ.BasisZ, new XYZ(0, 0, z)));
                        return sp;
                    }
                    foreach (JObject m in (p["marks"] as JArray ?? new JArray()).OfType<JObject>())
                    {
                        string key = m.Value<string>("key") ?? "";
                        try
                        {
                            double z = level.Elevation + Ft(m.Value<double>("z_mm"));
                            var c = new XYZ(Ft(m.Value<double>("x")), Ft(m.Value<double>("y")), z);
                            SketchPlane sp = PlaneAt(z);
                            foreach (Curve curve in MarkCurves(m.Value<string>("kind") ?? "", c, m))
                            {
                                made.Add((doc.Create.NewModelCurve(curve, sp), key));
                            }
                            marks++;
                        }
                        catch (Exception e) { notes.Add($"{key}: mark not drawn: {e.Message}"); }
                    }

                    foreach (var (e, _) in made)
                    {
                        Parameter cm = e.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS);
                        if (cm != null && !cm.IsReadOnly) cm.Set(tag);
                    }
                    TransactionStatus status = t.Commit();
                    warnings = collector.Warnings;
                    if (status != TransactionStatus.Committed) throw new InvalidOperationException($"Revit did not accept the ceiling ({status}); nothing was changed.");
                }
                var elements = dry ? new JArray() : new JArray(made.Select(m => new JObject { ["unique_id"] = m.e.UniqueId, ["key"] = m.key }));
                if (dry) group.RollBack(); else group.Assimilate();
                return new JObject
                {
                    ["dry_run"] = dry,
                    ["result"] = dry ? "would place (rolled back)" : (edit ? "replaced" : "placed"),
                    ["ceiling_type"] = type.Name,
                    ["level"] = level.Name,
                    ["counts"] = new JObject { ["ceilings"] = ceilings, ["line_features"] = lines, ["marks"] = marks, ["elements"] = made.Count },
                    ["removed"] = removed,
                    ["elements"] = elements,
                    ["not_placed"] = notPlaced,
                    ["notes"] = notes,
                    ["warnings"] = new JArray(warnings.Distinct()),
                    ["kit_change_requests"] = kcr,
                };
            }
        }

        /// <summary>The ceiling type: the one named, else the one whose keynote is the board (I.CLG_xx), else its name holds it.</summary>
        private static CeilingType PickType(Document doc, string name, string board)
        {
            var types = new FilteredElementCollector(doc).OfClass(typeof(CeilingType)).Cast<CeilingType>().ToList();
            CeilingType t = null;
            if (name.Trim().Length > 0)
                t = types.FirstOrDefault(x => string.Equals(x.Name, name.Trim(), StringComparison.OrdinalIgnoreCase));
            else if (board.Length > 0)
                t = types.FirstOrDefault(x => string.Equals(x.get_Parameter(BuiltInParameter.KEYNOTE_PARAM)?.AsString() ?? "", board, StringComparison.OrdinalIgnoreCase))
                    ?? types.FirstOrDefault(x => x.Name.IndexOf(board, StringComparison.OrdinalIgnoreCase) >= 0
                                              || x.Name.IndexOf(board.Replace(".", "_"), StringComparison.OrdinalIgnoreCase) >= 0);
            if (t != null) return t;
            string have = types.Count == 0 ? "none" : string.Join(", ", types.Select(x => $"{x.Name} (keynote {x.get_Parameter(BuiltInParameter.KEYNOTE_PARAM)?.AsString() ?? "-"})"));
            throw new InvalidOperationException(name.Trim().Length > 0
                ? $"No ceiling type named {name} in {doc.Title}. Ceiling types: {have}."
                : $"No ceiling type with keynote {board} in {doc.Title} (kit change request: the I template needs an I.CLG ceiling type with that keynote, or name one with place.ceiling_type). Ceiling types: {have}.");
        }

        /// <summary>A loaded line-based model family for a role: the one named ("Family:Type" or "Family"), else by the role's words.</summary>
        private static FamilySymbol LineFamily(Document doc, string role, string named)
        {
            var curveBased = new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>()
                .Where(s => s.Family != null && s.Family.FamilyPlacementType == FamilyPlacementType.CurveBased).ToList();
            if (named.Trim().Length > 0)
            {
                string[] parts = named.Split(':');
                string fam = parts[0].Trim(), typ = parts.Length > 1 ? parts[1].Trim() : "";
                return curveBased.FirstOrDefault(s => s.FamilyName == fam && (typ.Length == 0 || s.Name == typ));
            }
            if (!RoleWords.TryGetValue(role, out string[] words)) return null;
            return curveBased
                .Where(s => words.Any(w => s.FamilyName.IndexOf(w, StringComparison.OrdinalIgnoreCase) >= 0))
                .OrderBy(s => s.FamilyName.StartsWith("FMC_", StringComparison.Ordinal) ? 0 : 1).ThenBy(s => s.FamilyName).FirstOrDefault();
        }

        /// <summary>The model lines that mark a fixture's position: a cross, plus the fan's sweep, a grille's or hatch's outline.</summary>
        private static IEnumerable<Curve> MarkCurves(string kind, XYZ c, JObject m)
        {
            double half = Ft(kind == "fan" ? 150 : kind == "sprinkler" ? 75 : 100);
            yield return Line.CreateBound(c - XYZ.BasisX * half, c + XYZ.BasisX * half);
            yield return Line.CreateBound(c - XYZ.BasisY * half, c + XYZ.BasisY * half);
            if (kind == "fan" || kind == "detector")
            {
                double r = kind == "fan" ? Ft((m.Value<double?>("sweep_mm") ?? 1200) / 2) : Ft(75);
                yield return Arc.Create(c, r, 0, Math.PI, XYZ.BasisX, XYZ.BasisY);
                yield return Arc.Create(c, r, Math.PI, 2 * Math.PI, XYZ.BasisX, XYZ.BasisY);
            }
            double w = 0, d = 0;
            if (kind == "ac_grille") { w = m.Value<double?>("width_mm") ?? 600; d = m.Value<double?>("depth_mm") ?? 160; }
            if (kind == "hatch") { w = d = m.Value<double?>("size_mm") ?? 600; }
            if (w > 0 && d > 0)
            {
                double hx = Ft(w / 2), hy = Ft(d / 2);
                var q = new[] { c + new XYZ(-hx, -hy, 0), c + new XYZ(hx, -hy, 0), c + new XYZ(hx, hy, 0), c + new XYZ(-hx, hy, 0) };
                for (int i = 0; i < 4; i++) yield return Line.CreateBound(q[i], q[(i + 1) % 4]);
            }
        }
    }
}
