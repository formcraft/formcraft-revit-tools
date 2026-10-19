using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.ExtensibleStorage;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_doc geometry ops (plan B1c): extrusions and voids locked to named reference planes, the material parameter, the
    /// visibility, and the flex check. A solid made by an op keeps its op name in extensible storage, so a second run finds
    /// it and skips (solids have no name of their own in Revit).
    /// </summary>
    public static class FmcDocGeometry
    {
        private static double Mm(double v) => UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters);
        private static readonly Guid SchemaId = new Guid("6b1a3f0e-4c2d-4f7a-9a51-2f8e0d9c7b31");

        private static Schema NameSchema()
        {
            Schema s = Schema.Lookup(SchemaId);
            if (s != null) return s;
            var b = new SchemaBuilder(SchemaId);
            b.SetSchemaName("FMC_OpName");
            b.SetReadAccessLevel(AccessLevel.Public);
            b.SetWriteAccessLevel(AccessLevel.Public);
            b.SetVendorId("Formcraft");
            b.AddSimpleField("Name", typeof(string));
            return b.Finish();
        }

        public static string NameOf(Element e)
        {
            Schema s = Schema.Lookup(SchemaId);
            if (s == null) return "";
            Entity en = e.GetEntity(s);
            return en.IsValid() ? en.Get<string>("Name") ?? "" : "";
        }

        /// <summary>Stores the op name on an element (solids, connectors), so a second run finds it.</summary>
        public static void Label(Element e, string name) => Name(e, name);

        private static void Name(Element e, string name)
        {
            Schema s = NameSchema();
            var en = new Entity(s);
            en.Set("Name", name);
            e.SetEntity(en);
        }

        public static GenericForm Solid(Document doc, string name) =>
            new FilteredElementCollector(doc).OfClass(typeof(GenericForm)).Cast<GenericForm>().FirstOrDefault(f => NameOf(f) == name);

        private static ReferencePlane Plane(Document doc, string name) =>
            new FilteredElementCollector(doc).OfClass(typeof(ReferencePlane)).Cast<ReferencePlane>().FirstOrDefault(p => p.Name == name)
            ?? throw new InvalidOperationException("No reference plane " + name);

        private static View ViewNamed(Document doc, string name, ViewType kind)
        {
            var views = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(v => !v.IsTemplate).ToList();
            return views.FirstOrDefault(v => v.Name == name) ?? views.FirstOrDefault(v => v.ViewType == kind)
                ?? throw new InvalidOperationException("No " + kind + " view in the family");
        }

        /// <summary>Where a vertical plane sits in plan: x for a left/right plane, y for a front/back plane.</summary>
        private static (bool IsX, double At) PlanPosition(ReferencePlane p)
        {
            XYZ d = (p.FreeEnd - p.BubbleEnd).Normalize();
            return Math.Abs(d.Y) > Math.Abs(d.X) ? (true, p.BubbleEnd.X) : (false, p.BubbleEnd.Y);
        }

        public static (string, string) Extrusion(Document doc, JObject op, bool isVoid)
        {
            string name = op.Value<string>("name");
            GenericForm existing = Solid(doc, name);
            double start = Mm(op.Value<double?>("start") ?? 0), end = Mm(op.Value<double?>("end") ?? 1000);
            if (existing is Extrusion ex)
            {
                if (Math.Abs(ex.StartOffset - start) < 1e-9 && Math.Abs(ex.EndOffset - end) < 1e-9) return ("skip", "");
                ex.StartOffset = start; ex.EndOffset = end;
                return ("update", "start/end changed (the profile is left as it is)");
            }

            var loop = new CurveArray();
            string[] rect = (op["rect"] as JArray)?.Select(x => x.ToString()).ToArray();
            ReferencePlane[] sides = null;
            if (rect != null && rect.Length == 4)
            {
                sides = rect.Select(r => Plane(doc, r)).ToArray();   // left, right, front, back
                double x1 = PlanPosition(sides[0]).At, x2 = PlanPosition(sides[1]).At, y1 = PlanPosition(sides[2]).At, y2 = PlanPosition(sides[3]).At;
                var c = new[] { new XYZ(x1, y1, 0), new XYZ(x2, y1, 0), new XYZ(x2, y2, 0), new XYZ(x1, y2, 0) };
                for (int k = 0; k < 4; k++) loop.Append(Line.CreateBound(c[k], c[(k + 1) % 4]));
            }
            // F-059: sketch "front" draws [x, z] in the front elevation with depth toward the viewer (-y); "right" draws
            // [y, z] with depth along +x; "plan" (default) draws [x, y] with depth up (z). Before, every extrusion was in plan.
            string sk = (op.Value<string>("sketch") ?? "plan").ToLowerInvariant();
            if (rect != null && sk != "plan") throw new InvalidOperationException("rect (four planes) works with sketch plan only");
            else if (rect == null)
            {
                var pts = (op["points"] as JArray ?? new JArray()).Select(p => sk == "front" ? new XYZ(Mm(p[0].Value<double>()), 0, Mm(p[1].Value<double>()))
                    : sk == "right" ? new XYZ(0, Mm(p[0].Value<double>()), Mm(p[1].Value<double>())) : new XYZ(Mm(p[0].Value<double>()), Mm(p[1].Value<double>()), 0)).ToList();
                if (pts.Count < 3) throw new InvalidOperationException("an extrusion needs rect (four planes) or at least three points");
                for (int k = 0; k < pts.Count; k++) loop.Append(Line.CreateBound(pts[k], pts[(k + 1) % pts.Count]));
            }
            var profile = new CurveArrArray();
            profile.Append(loop);
            XYZ normal = sk == "front" ? XYZ.BasisY.Negate() : sk == "right" ? XYZ.BasisX : XYZ.BasisZ;
            SketchPlane sketch = SketchPlane.Create(doc, Autodesk.Revit.DB.Plane.CreateByNormalAndOrigin(normal, XYZ.Zero));
            Extrusion made = doc.FamilyCreate.NewExtrusion(!isVoid, profile, sketch, end - start);
            made.StartOffset = start; made.EndOffset = end;
            Name(made, name);

            // F-064 #7 / F-062: start_plane and end_plane (a reference plane or a level, e.g. Upper Ref. Level) move the end
            // onto the plane before it is locked, so a lock never fails on a face a fraction of a millimetre off.
            var snapped = new List<string>();
            var ends = new List<(string Name, bool Top, EndTarget Target)>();
            foreach (var (key, isTop) in new[] { ("start_plane", false), ("end_plane", true) })
            {
                string n = op.Value<string>(key);
                if (string.IsNullOrEmpty(n)) continue;
                EndTarget t = FindEndTarget(doc, n);
                double off = t.Point.DotProduct(normal);
                double was = isTop ? made.EndOffset : made.StartOffset;
                if (Math.Abs(was - off) > 1e-9)
                {
                    if (isTop) made.EndOffset = off; else made.StartOffset = off;
                    snapped.Add($"{(isTop ? "end" : "start")} {Math.Round(ToMm(was), 2)} → {Math.Round(ToMm(off), 2)} mm on {n}");
                }
                ends.Add((n, isTop, t));
            }
            if (made.EndOffset <= made.StartOffset) throw new InvalidOperationException($"{name}: its ends meet or cross once moved onto their planes");

            // Lock each side to its plane (in plan), and the top to a level plane in an elevation when one is named.
            var locked = new List<string>();
            var unlocked = new List<string>();
            doc.Regenerate();
            if (sides != null)
            {
                View plan = ViewNamed(doc, op.Value<string>("view") ?? "Ref. Level", ViewType.FloorPlan);
                foreach (ReferencePlane side in sides)
                    if (LockFace(doc, plan, made, side.GetReference(), side.Normal)) locked.Add(side.Name);
            }
            if (ends.Count > 0)
            {
                // ends of a plan sketch are level planes, seen in Front; ends of a front or right sketch are vertical, seen in plan
                View endView = sk == "plan" ? ViewNamed(doc, "Front", ViewType.Elevation) : ViewNamed(doc, op.Value<string>("view") ?? "Ref. Level", ViewType.FloorPlan);
                foreach (var e in ends)
                    if (LockFace(doc, endView, made, e.Target.Ref, normal, e.Target.Point)) locked.Add(e.Name);
                    // as before, a lock that doesn't take doesn't stop the build; it is reported (it used to be silent)
                    else unlocked.Add($"warning: its {(e.Top ? "end" : "start")} sits on {e.Name} but couldn't be locked to it in {endView.Name}");
            }
            return ("create", (isVoid ? "void" : "solid") + (sk != "plan" ? ", sketched " + sk : "") + (locked.Count > 0 ? ", locked to " + string.Join(", ", locked) : "")
                + (snapped.Count > 0 ? "; snapped " + string.Join(", ", snapped) : "") + (unlocked.Count > 0 ? "; " + string.Join("; ", unlocked) : ""));
        }

        /// <summary>Where an extrusion end goes: a reference plane by name, or a level (the column template's Upper Ref. Level).</summary>
        internal readonly struct EndTarget
        {
            public EndTarget(Reference r, XYZ p, string kind) { Ref = r; Point = p; Kind = kind; }
            public Reference Ref { get; }
            public XYZ Point { get; }
            public string Kind { get; }
        }

        internal static EndTarget FindEndTarget(Document doc, string name)
        {
            var rp = new FilteredElementCollector(doc).OfClass(typeof(ReferencePlane)).Cast<ReferencePlane>().FirstOrDefault(p => p.Name == name);
            if (rp != null) return new EndTarget(rp.GetReference(), rp.BubbleEnd, "plane");
            var lv = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().FirstOrDefault(l => l.Name == name);
            if (lv != null) return new EndTarget(lv.GetPlaneReference(), new XYZ(0, 0, lv.ProjectElevation), "level");
            throw new InvalidOperationException("No reference plane or level named " + name);
        }

        private static double ToMm(double feet) => UnitUtils.ConvertFromInternalUnits(feet, UnitTypeId.Millimeters);

        /// <summary>Aligns and locks the solid's planar face that faces the same way as the plane and lies on it.</summary>
        internal static bool LockFace(Document doc, View view, GenericForm form, Reference planeRef, XYZ normal, XYZ planePoint = null)
        {
            var options = new Options { ComputeReferences = true, View = view, IncludeNonVisibleObjects = true };
            foreach (GeometryObject g in form.get_Geometry(options))
            {
                if (!(g is Autodesk.Revit.DB.Solid solid)) continue;
                foreach (Face f in solid.Faces)
                {
                    if (!(f is PlanarFace pf) || f.Reference == null) continue;
                    if (!pf.FaceNormal.IsAlmostEqualTo(normal) && !pf.FaceNormal.IsAlmostEqualTo(normal.Negate())) continue;
                    Element pe = doc.GetElement(planeRef);
                    if (planePoint != null) { if (Math.Abs((pf.Origin - planePoint).DotProduct(normal)) > 1e-6) continue; }
                    else if (pe is ReferencePlane rp && Math.Abs((pf.Origin - rp.BubbleEnd).DotProduct(rp.Normal)) > 1e-6) continue;
                    try
                    {
                        Dimension a = doc.FamilyCreate.NewAlignment(view, planeRef, f.Reference);
                        a.IsLocked = true;
                        return true;
                    }
                    catch (Exception) { return false; }
                }
            }
            return false;
        }

        public static (string, string) MaterialParam(Document doc, JObject op)
        {
            GenericForm form = Solid(doc, op.Value<string>("name")) ?? throw new InvalidOperationException("No solid " + op.Value<string>("name"));
            FamilyManager fm = doc.FamilyManager;
            FamilyParameter fp = fm.get_Parameter(op.Value<string>("param")) ?? throw new InvalidOperationException("No parameter " + op.Value<string>("param"));
            Parameter mat = form.get_Parameter(BuiltInParameter.MATERIAL_ID_PARAM) ?? throw new InvalidOperationException("The solid has no material parameter");
            if (fm.GetAssociatedFamilyParameter(mat)?.Id == fp.Id) return ("skip", "");
            fm.AssociateElementParameterToFamilyParameter(mat, fp);
            return ("update", "material from " + fp.Definition.Name);
        }

        public static (string, string) Visibility(Document doc, JObject op)
        {
            GenericForm form = Solid(doc, op.Value<string>("name")) ?? throw new InvalidOperationException("No solid " + op.Value<string>("name"));
            FamilyElementVisibility v = form.GetVisibility();
            var changed = new List<string>();
            void Flag(string key, Func<bool> get, Action<bool> set)
            {
                if (op[key] == null) return;
                bool want = op.Value<bool>(key);
                if (get() == want) return;
                set(want);
                changed.Add(key + "=" + want);
            }
            var flags = new (string key, Func<bool> get, Action<bool> set)[]
            {
                ("coarse", () => v.IsShownInCoarse, x => v.IsShownInCoarse = x),
                ("medium", () => v.IsShownInMedium, x => v.IsShownInMedium = x),
                ("fine", () => v.IsShownInFine, x => v.IsShownInFine = x),
                ("plan_rcp", () => v.IsShownInTopBottom, x => v.IsShownInTopBottom = x),
                ("front_back", () => v.IsShownInFrontBack, x => v.IsShownInFrontBack = x),
                ("left_right", () => v.IsShownInLeftRight, x => v.IsShownInLeftRight = x),
            };
            // Turn things on before turning others off: Revit refuses any moment where every detail level is off
            // ("Cannot make this element invisible in all levels of detail"), even if the next flag would fix it.
            foreach (var f in flags) if (op[f.key] != null && op.Value<bool>(f.key)) Flag(f.key, f.get, f.set);
            foreach (var f in flags) if (op[f.key] != null && !op.Value<bool>(f.key)) Flag(f.key, f.get, f.set);
            bool levelsLeft = v.IsShownInCoarse || v.IsShownInMedium || v.IsShownInFine;
            if (!levelsLeft) throw new InvalidOperationException("at least one of coarse, medium and fine must stay on (Revit rule)");
            if (changed.Count == 0) return ("skip", "");
            form.SetVisibility(v);
            return ("update", string.Join(", ", changed));
        }

        private sealed class ErrorCollector : IFailuresPreprocessor
        {
            public readonly List<string> Errors = new List<string>();
            public FailureProcessingResult PreprocessFailures(FailuresAccessor a)
            {
                foreach (FailureMessageAccessor f in a.GetFailureMessages())
                {
                    if (f.GetSeverity() == FailureSeverity.Warning) a.DeleteWarning(f);
                    else Errors.Add(f.GetDescriptionText());
                }
                return Errors.Count > 0 ? FailureProcessingResult.ProceedWithRollBack : FailureProcessingResult.Continue;
            }
        }

        /// <summary>The flex check's default time limit (s): under the add-in's 300 s wait for fmc_doc_flex, so its answer arrives (F-072).</summary>
        public const double DefaultFlexSeconds = 240;

        /// <summary>
        /// Flex: every type in turn, regenerated; constraint errors per type, and the labelled dimensions whose plane ended
        /// on the other side of its reference in that type (F-026, F-039). Nothing is kept.
        /// <para>F-072: one regeneration per type, and the size check (Follow) runs on the type it picks right after that
        /// type's own regeneration, reusing it. The check stops before a regeneration that would pass <paramref name="maxSeconds"/>
        /// (from the longest one so far) and says how far it got (unfinished), instead of holding Revit's API thread unbounded
        /// (the detailed operating light held it about 18 minutes). The answer counts its regenerations.</para>
        /// </summary>
        public static JObject Flex(Document doc, JArray follow = null, double maxSeconds = DefaultFlexSeconds)
        {
            FamilyManager fm = doc.FamilyManager;
            var clock = new FlexClock(maxSeconds);
            int sidesChecked = 0, sidesUnrecorded = 0;
            var types = fm.Types.Cast<FamilyType>().Where(t => !string.IsNullOrWhiteSpace(t.Name)).ToList();
            var byType = new Dictionary<string, JObject>();
            var follower = follow != null && follow.Count > 0 ? new Follower(doc, follow) : null;
            using (var group = new TransactionGroup(doc, "Formcraft: flex"))
            {
                group.Start();
                FamilyType startType = fm.CurrentType;
                // the type the size check prefers goes first (the one already at the low values, then the current one), so
                // its own regeneration is the size check's starting state
                var order = follower == null ? types : follower.Order(types, startType);
                foreach (FamilyType type in order)
                {
                    if (!clock.RoomForOneMore()) break;
                    var c = new ErrorCollector();
                    using (var t = new Transaction(doc, "flex " + type.Name))
                    {
                        var fho = t.GetFailureHandlingOptions();
                        fho.SetFailuresPreprocessor(c);
                        t.SetFailureHandlingOptions(fho);
                        t.Start();
                        string error = "";
                        var wrong = new List<JObject>();
                        try
                        {
                            fm.CurrentType = type;
                            clock.Regenerate(doc);
                            var sides = FmcDimSides.Check(doc);
                            wrong = sides.Wrong;
                            sidesChecked = Math.Max(sidesChecked, sides.Checked);
                            sidesUnrecorded = Math.Max(sidesUnrecorded, sides.Unrecorded);
                        }
                        catch (Exception e) { error = e.Message; }
                        var status = error.Length > 0 ? RollBack(t) : t.Commit();
                        if (status != TransactionStatus.Committed && error.Length == 0 && c.Errors.Count == 0) error = "Revit couldn't regenerate it (" + status + ")";
                        var all = c.Errors.Concat(error.Length > 0 ? new[] { error } : new string[0]).ToList();
                        byType[type.Name] = new JObject { ["type"] = type.Name, ["ok"] = all.Count == 0, ["errors"] = new JArray(all), ["dimension_sides"] = new JArray(wrong) };
                        // the size check on this type, from the state just regenerated (no second regeneration to get there)
                        if (follower != null && follower.Pending && all.Count == 0) follower.On(type, clock);
                    }
                }
                group.RollBack();
            }
            // the answer keeps the family's own type order
            var results = new JArray(types.Where(t => byType.ContainsKey(t.Name)).Select(t => byType[t.Name]));
            var answer = new JObject
            {
                ["types"] = results, ["ok"] = results.All(r => r.Value<bool>("ok")),
                ["dimension_sides"] = new JObject { ["checked"] = sidesChecked, ["unrecorded"] = sidesUnrecorded },
                ["regenerations"] = clock.Regenerations, ["seconds"] = Math.Round(clock.Seconds, 1),
            };
            bool unfinished = results.Count < types.Count || (follower != null && follower.Pending && clock.Stopped);
            if (unfinished)
                answer["unfinished"] = new JObject
                {
                    ["minutes"] = Math.Round(maxSeconds / 60, 1), ["checked"] = results.Count, ["of"] = types.Count,
                    ["seconds"] = Math.Round(clock.Seconds, 1), ["size_check_done"] = follower == null || !follower.Pending,
                };
            if (follower != null) answer["follow"] = follower.Report(clock.Stopped);
            return answer;
        }

        private static TransactionStatus RollBack(Transaction t)
        {
            try { return t.RollBack(); } catch (Exception) { return TransactionStatus.Error; }
        }

        /// <summary>Counts flex's regenerations and keeps it inside its time limit (F-072).</summary>
        private sealed class FlexClock
        {
            private readonly System.Diagnostics.Stopwatch _watch = System.Diagnostics.Stopwatch.StartNew();
            private readonly double _max;
            private double _longest;
            public FlexClock(double maxSeconds) { _max = maxSeconds > 0 ? maxSeconds : double.MaxValue; }
            public int Regenerations { get; private set; }
            public double Seconds => _watch.Elapsed.TotalSeconds;
            /// <summary>True once a regeneration was refused for time.</summary>
            public bool Stopped { get; private set; }

            /// <summary>Whether one more regeneration (as long as the longest so far) still ends inside the limit.</summary>
            public bool RoomForOneMore()
            {
                if (Seconds + _longest <= _max) return true;
                Stopped = true;
                return false;
            }

            public void Regenerate(Document doc)
            {
                double t0 = Seconds;
                Regenerations++;
                try { doc.Regenerate(); }
                finally { _longest = Math.Max(_longest, Seconds - t0); }
            }
        }

        /// <summary>
        /// Gate A's size check: each size parameter (Width, Height, Fanlight Height…) set to its lowest and then its highest
        /// type value on one type, the rest of that type left as it is, and every named solid's bounding box compared
        /// between the two. A solid whose box changed moved with the parameter. The type tried first is the one that
        /// already has the lowest values; a type where a value doesn't regenerate leaves that parameter for the next.
        /// Inside flex's group, so nothing is kept.
        /// <para>F-072, the same check in fewer regenerations: it starts from the type's own regeneration (flex's), sets
        /// every parameter not already at its low value in one step (one parameter at a time only to find which one fails),
        /// then raises one parameter per step, each step's boxes being the next one's "before". The state before raising a
        /// parameter is the one the old code reached with a step of its own (the earlier parameters raised, this one low),
        /// so what is compared is unchanged. P parameters on a type already at its low values: P regenerations (it was 2P).</para>
        /// </summary>
        private sealed class Follower
        {
            private sealed class Spec
            {
                public string Name;
                public double Lo, Hi;
                public FamilyParameter P;
                public JObject Line;
                public bool Done;
            }

            private readonly Document _doc;
            private readonly List<Spec> _specs = new List<Spec>();
            private readonly JArray _lines = new JArray();
            private readonly Dictionary<string, List<string>> _moved = new Dictionary<string, List<string>>();
            private readonly Dictionary<string, List<string>> _still = new Dictionary<string, List<string>>();
            private readonly HashSet<string> _noBox = new HashSet<string>();
            private readonly Dictionary<string, string> _firstError = new Dictionary<string, string>();
            private int _typesTried;

            public Follower(Document doc, JArray follow)
            {
                _doc = doc;
                FamilyManager fm = doc.FamilyManager;
                foreach (JObject f in follow.OfType<JObject>())
                {
                    string name = f.Value<string>("param");
                    var line = new JObject { ["param"] = name, ["low_mm"] = f["low_mm"], ["high_mm"] = f["high_mm"], ["ok"] = false };
                    _lines.Add(line);
                    FamilyParameter p = fm.get_Parameter(name);
                    if (p == null) { line["error"] = "no parameter " + name; continue; }
                    if (p.Definition.GetDataType() != SpecTypeId.Length) { line["error"] = name + " isn't a Length parameter"; continue; }
                    // a size parameter a formula or a reporting dimension drives can't be set: reported, never stepped
                    if (!string.IsNullOrEmpty(p.Formula) || p.IsReporting) { line["error"] = name + " is driven (formula or reporting)"; continue; }
                    _specs.Add(new Spec { Name = name, Lo = Mm(f.Value<double>("low_mm")), Hi = Mm(f.Value<double>("high_mm")), P = p, Line = line });
                }
            }

            public bool Pending => _specs.Any(s => !s.Done);

            private static bool AtLow(FamilyType t, Spec s) => t.HasValue(s.P) && Math.Abs((t.AsDouble(s.P) ?? 0) - s.Lo) < 1e-9;

            /// <summary>Types in the order the size check tries them: most parameters already low, then the current type.</summary>
            public List<FamilyType> Order(List<FamilyType> types, FamilyType current) =>
                types.Select((t, i) => (t, i)).OrderByDescending(x => _specs.Count(s => AtLow(x.t, s))).ThenBy(x => x.t.Name == current?.Name ? 0 : 1)
                    .ThenBy(x => x.i).Select(x => x.t).ToList();

            /// <summary>The size check on this type, current and just regenerated (by flex).</summary>
            public void On(FamilyType type, FlexClock clock)
            {
                _typesTried++;
                var pending = _specs.Where(s => !s.Done).ToList();
                var notLow = pending.Where(s => !AtLow(type, s)).ToList();
                var failedHere = new HashSet<Spec>();
                Dictionary<string, BoundingBoxXYZ> before;
                if (notLow.Count == 0) before = FmcDocSweep.Boxes(_doc);   // flex's own regeneration is the low state
                else
                {
                    if (!clock.RoomForOneMore()) return;
                    before = Step(type, notLow.Select(s => (s, s.Lo)).ToList(), clock, out string e);
                    if (before == null)
                    {
                        // which one fails: one at a time (only now)
                        foreach (var s in notLow)
                        {
                            if (!clock.RoomForOneMore()) return;
                            var b = Step(type, new List<(Spec, double)> { (s, s.Lo) }, clock, out string e1);
                            if (b == null) { failedHere.Add(s); Note(s, type.Name + ": " + e1); }
                            else before = b;
                        }
                        if (before == null) before = FmcDocSweep.Boxes(_doc);
                    }
                }
                foreach (var s in pending)
                {
                    if (failedHere.Contains(s)) continue;
                    if (!clock.RoomForOneMore()) return;
                    var after = Step(type, new List<(Spec, double)> { (s, s.Hi) }, clock, out string e2);
                    if (after == null) { Note(s, type.Name + ": " + e2); continue; }   // rolled back: `before` still holds
                    foreach (var kv in before)
                    {
                        if (!_moved.ContainsKey(kv.Key)) { _moved[kv.Key] = new List<string>(); _still[kv.Key] = new List<string>(); }
                        after.TryGetValue(kv.Key, out BoundingBoxXYZ b2);
                        if (kv.Value == null || b2 == null) { _noBox.Add(kv.Key); continue; }
                        (FmcDocSweep.Moved(kv.Value, b2) ? _moved[kv.Key] : _still[kv.Key]).Add(s.Name);
                    }
                    s.Done = true;
                    s.Line["ok"] = true;
                    s.Line["type"] = type.Name;
                    before = after;
                }
            }

            private void Note(Spec s, string error) { if (!_firstError.ContainsKey(s.Name)) _firstError[s.Name] = error; }

            /// <summary>The values set on the current type in one transaction and one regeneration, committed; the named
            /// solids' boxes after it, or null when Revit refused it (rolled back, the state as before).</summary>
            private Dictionary<string, BoundingBoxXYZ> Step(FamilyType type, List<(Spec S, double Value)> set, FlexClock clock, out string error)
            {
                error = "";
                FamilyManager fm = _doc.FamilyManager;
                var c = new ErrorCollector();
                using (var t = new Transaction(_doc, "follow " + string.Join(", ", set.Select(x => x.S.Name))))
                {
                    var fho = t.GetFailureHandlingOptions();
                    fho.SetFailuresPreprocessor(c);
                    t.SetFailureHandlingOptions(fho);
                    t.Start();
                    try
                    {
                        if (fm.CurrentType?.Name != type.Name) fm.CurrentType = type;
                        foreach (var (s, v) in set) fm.Set(s.P, v);
                        clock.Regenerate(_doc);
                    }
                    catch (Exception e) { error = e.Message; }
                    if (error.Length > 0) { RollBack(t); return null; }
                    var status = t.Commit();
                    if (status != TransactionStatus.Committed || c.Errors.Count > 0)
                    {
                        error = string.Join(", ", set.Select(x => x.S.Name + " = " + Math.Round(ToMm(x.Value), 1) + " mm")) + ": " +
                            (c.Errors.Count > 0 ? c.Errors[0] : "Revit couldn't regenerate it (" + status + ")");
                        return null;
                    }
                }
                return FmcDocSweep.Boxes(_doc);
            }

            public JObject Report(bool stoppedForTime)
            {
                foreach (var s in _specs.Where(x => !x.Done))
                    s.Line["error"] = _firstError.TryGetValue(s.Name, out string e) ? e
                        : stoppedForTime ? "not checked: flex reached its time limit first"
                        : _typesTried == 0 ? "no type to flex" : "no type moved it";
                var elements = new JArray();
                foreach (var n in _moved.Keys.OrderBy(k => k))
                {
                    var e = new JObject { ["name"] = n, ["kind"] = FmcDocSweep.KindOf(_doc, n), ["moved"] = new JArray(_moved[n]), ["fixed"] = new JArray(_still[n]) };
                    if (_noBox.Contains(n)) e["no_box"] = true;
                    elements.Add(e);
                }
                return new JObject { ["params"] = _lines, ["elements"] = elements };
            }
        }
    }
}
