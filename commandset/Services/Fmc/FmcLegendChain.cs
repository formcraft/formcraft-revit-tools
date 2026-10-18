using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Bridge;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// F-064 #6 (QG8): a chain-test project per role. From the role's template (in the background), it makes a wall, a
    /// ceiling and uses the level; loads the staged families; places one instance of every type on the host the register
    /// gives (wall face, ceiling underside, or the level); tags each with a keynote tag when the template has one; makes the
    /// keynote legend and a type schedule per category (Family and Type, Type Mark, Keynote, Count); lays them out on a sheet
    /// with the template's first title block; and saves it to 04_Families\_ChainTests (an older copy goes to _Archive
    /// first). It shows that each family loads, places, flexes, tags and schedules: Gate A's last "Not checked" line.
    /// </summary>
    public class FmcLegendChainEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public string GetName() => "FMC legend chain";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                FmcAiJob.Enter(app, FmcAiJob.JobOf(Parameters));
                Result = Run(app, Parameters);
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _resetEvent.Set(); }
        }

        private static double Mm(double v) => UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters);

        private sealed class Overwrite : IFamilyLoadOptions
        {
            public bool OnFamilyFound(bool familyInUse, out bool overwriteParameterValues) { overwriteParameterValues = true; return true; }
            public bool OnSharedFamilyFound(Family sharedFamily, bool familyInUse, out FamilySource source, out bool overwriteParameterValues)
            { source = FamilySource.Family; overwriteParameterValues = true; return true; }
        }

        private sealed class Quiet : IFailuresPreprocessor
        {
            public FailureProcessingResult PreprocessFailures(FailuresAccessor a)
            {
                foreach (var f in a.GetFailureMessages()) if (f.GetSeverity() == FailureSeverity.Warning) a.DeleteWarning(f);
                return FailureProcessingResult.Continue;
            }
        }

        private static JObject Run(UIApplication app, JObject p)
        {
            string template = p.Value<string>("template") ?? "";
            string output = p.Value<string>("output") ?? throw new ArgumentException("output (the chain-test .rvt) is needed");
            if (!File.Exists(template)) throw new FileNotFoundException("No project template at " + template);
            var families = (p["families"] as JArray ?? new JArray()).OfType<JObject>().ToList();

            var result = new JObject { ["template"] = Path.GetFileName(template), ["output"] = output };
            var rows = new JArray();
            Document doc = app.Application.NewProjectDocument(template);
            try
            {
                using (var t = new Transaction(doc, "FMC chain test"))
                {
                    var opts = t.GetFailureHandlingOptions();
                    opts.SetFailuresPreprocessor(new Quiet());
                    t.SetFailureHandlingOptions(opts);
                    t.Start();
                    Level level = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => l.Elevation).FirstOrDefault() ?? Level.Create(doc, 0);
                    // hosts: a long wall along y = 0 and a ceiling over x 0..len, y 2..8 m at 2.7 m
                    double len = Math.Max(6000, 1500.0 * Math.Max(1, families.Sum(f => Math.Max(1, f.Value<int?>("types") ?? 1))));
                    Wall wall = Wall.Create(doc, Line.CreateBound(new XYZ(0, 0, 0), new XYZ(Mm(len), 0, 0)), level.Id, false);
                    wall.get_Parameter(BuiltInParameter.WALL_USER_HEIGHT_PARAM)?.Set(Mm(3000));
                    Ceiling ceiling = null;
                    ElementId ceilingType = new FilteredElementCollector(doc).OfClass(typeof(CeilingType)).FirstElementId();
                    if (ceilingType != ElementId.InvalidElementId)
                    {
                        var loop = CurveLoop.Create(new List<Curve>
                        {
                            Line.CreateBound(new XYZ(0, Mm(2000), 0), new XYZ(Mm(len), Mm(2000), 0)), Line.CreateBound(new XYZ(Mm(len), Mm(2000), 0), new XYZ(Mm(len), Mm(8000), 0)),
                            Line.CreateBound(new XYZ(Mm(len), Mm(8000), 0), new XYZ(0, Mm(8000), 0)), Line.CreateBound(new XYZ(0, Mm(8000), 0), new XYZ(0, Mm(2000), 0)),
                        });
                        ceiling = Ceiling.Create(doc, new List<CurveLoop> { loop }, ceilingType, level.Id);
                        ceiling.get_Parameter(BuiltInParameter.CEILING_HEIGHTABOVELEVEL_PARAM)?.Set(Mm(2700));
                    }
                    doc.Regenerate();
                    Reference wallFace = HostObjectUtils.GetSideFaces(wall, ShellLayerType.Exterior).First();
                    Reference ceilingFace = ceiling != null ? HostObjectUtils.GetBottomFaces(ceiling).First() : null;
                    XYZ wallNormal = ((PlanarFace)wall.GetGeometryObjectFromReference(wallFace)).FaceNormal;
                    FamilySymbol keynoteTag = new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).OfCategory(BuiltInCategory.OST_KeynoteTags)
                        .Cast<FamilySymbol>().FirstOrDefault();
                    if (keynoteTag != null && !keynoteTag.IsActive) keynoteTag.Activate();
                    View plan = new FilteredElementCollector(doc).OfClass(typeof(ViewPlan)).Cast<ViewPlan>()
                        .FirstOrDefault(v => !v.IsTemplate && v.GenLevel?.Id == level.Id && v.ViewType == ViewType.FloorPlan);

                    int slot = 0, tagged = 0;
                    var categories = new HashSet<ElementId>();
                    foreach (JObject f in families)
                    {
                        string path = f.Value<string>("path") ?? "";
                        string host = (f.Value<string>("host") ?? "level").ToLowerInvariant();
                        var row = new JObject { ["family"] = Path.GetFileNameWithoutExtension(path), ["host"] = host };
                        try
                        {
                            if (!doc.LoadFamily(path, new Overwrite(), out Family family) || family == null)
                                family = new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>()
                                    .FirstOrDefault(x => x.Name == Path.GetFileNameWithoutExtension(path)) ?? throw new InvalidOperationException("couldn't load " + path);
                            var symbols = family.GetFamilySymbolIds().Select(id => (FamilySymbol)doc.GetElement(id)).OrderBy(s => s.Name).ToList();
                            int placed = 0;
                            var problems = new JArray();
                            foreach (FamilySymbol s in symbols)
                            {
                                if (!s.IsActive) s.Activate();
                                double x = Mm(750 + 1500 * slot++);
                                FamilyInstance inst = null;
                                try
                                {
                                    var placement = family.FamilyPlacementType;
                                    if (host == "wall" && placement == FamilyPlacementType.WorkPlaneBased)
                                        inst = doc.Create.NewFamilyInstance(wallFace, new XYZ(x, 0, Mm(1200)), XYZ.BasisZ.CrossProduct(wallNormal).Normalize(), s);
                                    else if (host == "wall" && placement == FamilyPlacementType.OneLevelBasedHosted)
                                        inst = doc.Create.NewFamilyInstance(new XYZ(x, 0, 0), s, wall, level, StructuralType.NonStructural);
                                    else if (host == "ceiling" && ceilingFace != null && placement == FamilyPlacementType.WorkPlaneBased)
                                        inst = doc.Create.NewFamilyInstance(ceilingFace, new XYZ(x, Mm(5000), Mm(2700)), XYZ.BasisX, s);
                                    else if (host == "ceiling" && ceiling != null && placement == FamilyPlacementType.OneLevelBasedHosted)
                                        inst = doc.Create.NewFamilyInstance(new XYZ(x, Mm(5000), Mm(2700)), s, ceiling, level, StructuralType.NonStructural);
                                    else if (placement == FamilyPlacementType.WorkPlaneBased)
                                        // a face based family with no host to go on is placed on the level's own plane
                                        inst = doc.Create.NewFamilyInstance(level.GetPlaneReference(), new XYZ(x, Mm(-3000), 0), XYZ.BasisX, s);
                                    else if (placement == FamilyPlacementType.OneLevelBased)
                                        inst = doc.Create.NewFamilyInstance(new XYZ(x, Mm(-3000), 0), s, level, StructuralType.NonStructural);
                                    else problems.Add($"{s.Name}: {placement} isn't placed by the chain test (place it by hand)");
                                }
                                catch (Exception ex) { problems.Add($"{s.Name}: {ex.Message}"); }
                                if (inst == null) continue;
                                placed++;
                                categories.Add(family.FamilyCategory?.Id ?? ElementId.InvalidElementId);
                                if (keynoteTag != null && plan != null)
                                {
                                    try
                                    {
                                        IndependentTag.Create(doc, keynoteTag.Id, plan.Id, new Reference(inst), false, TagOrientation.Horizontal, (inst.Location as LocationPoint)?.Point ?? XYZ.Zero);
                                        tagged++;
                                    }
                                    catch (Exception ex) { problems.Add($"{s.Name}: keynote tag: {ex.Message}"); }
                                }
                            }
                            row["types"] = symbols.Count;
                            row["placed"] = placed;
                            if (problems.Count > 0) row["problems"] = problems;
                            row["ok"] = placed == symbols.Count && symbols.Count > 0;
                        }
                        catch (Exception ex) { row["ok"] = false; row["error"] = ex.Message; }
                        rows.Add(row);
                    }
                    result["tagged"] = tagged;
                    result["keynote_tag"] = keynoteTag != null ? keynoteTag.FamilyName + ": " + keynoteTag.Name : "none in the template: not tagged";

                    // keynote legend and a type schedule per category, on one sheet
                    var views = new List<View>();
                    try { var kl = ViewSchedule.CreateKeynoteLegend(doc); kl.Name = "FMC Chain Test Keynotes"; views.Add(kl); }
                    catch (Exception ex) { result["keynote_legend"] = "not made: " + ex.Message; }
                    var schedules = new JArray();
                    foreach (ElementId cat in categories.Where(c => c != ElementId.InvalidElementId))
                    {
                        try
                        {
                            var vs = ViewSchedule.CreateSchedule(doc, cat);
                            vs.Name = "FMC Chain Test " + (Category.GetCategory(doc, cat)?.Name ?? cat.ToString());
                            foreach (var want in new[] { BuiltInParameter.ELEM_FAMILY_AND_TYPE_PARAM, BuiltInParameter.WINDOW_TYPE_ID, BuiltInParameter.KEYNOTE_PARAM })
                            {
                                var field = vs.Definition.GetSchedulableFields().FirstOrDefault(sf => sf.ParameterId.Value == (long)want);
                                if (field != null) vs.Definition.AddField(field);
                            }
                            var count = vs.Definition.GetSchedulableFields().FirstOrDefault(sf => sf.FieldType == ScheduleFieldType.Count);
                            if (count != null) vs.Definition.AddField(count);
                            vs.Definition.IsItemized = false;
                            views.Add(vs);
                            schedules.Add(vs.Name);
                        }
                        catch (Exception ex) { schedules.Add("not made: " + ex.Message); }
                    }
                    result["schedules"] = schedules;
                    ElementId titleBlock = new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).OfCategory(BuiltInCategory.OST_TitleBlocks).FirstElementId();
                    if (titleBlock != ElementId.InvalidElementId && views.Count > 0)
                    {
                        ViewSheet sheet = ViewSheet.Create(doc, titleBlock);
                        sheet.Name = "Chain test";
                        double y = Mm(500);
                        foreach (View v in views.OfType<ViewSchedule>())
                        {
                            try { ScheduleSheetInstance.Create(doc, sheet.Id, v.Id, new XYZ(Mm(50), y, 0)); y -= Mm(120); }
                            catch (Exception) { /* a schedule that doesn't fit stays in the browser */ }
                        }
                        result["sheet"] = sheet.SheetNumber + " " + sheet.Name;
                    }
                    else result["sheet"] = titleBlock == ElementId.InvalidElementId ? "no title block in the template: no sheet" : "nothing to put on a sheet";
                    t.Commit();
                }

                // an older chain test goes to _Archive first; nothing is deleted
                if (File.Exists(output))
                {
                    string archive = Path.Combine(Path.GetDirectoryName(output), "_Archive");
                    Directory.CreateDirectory(archive);
                    string to = Path.Combine(archive, Path.GetFileNameWithoutExtension(output) + "_" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".rvt");
                    File.Move(output, to);
                    result["archived"] = to;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(output));
                doc.SaveAs(output, new SaveAsOptions { OverwriteExistingFile = false, MaximumBackups = 1 });
                result["saved"] = output;
            }
            finally
            {
                try { doc.Close(false); } catch (Exception) { /* closing */ }
            }
            result["families"] = rows;
            result["placed_all"] = rows.OfType<JObject>().Count(r => r.Value<bool?>("ok") == true);
            result["with_problems"] = rows.OfType<JObject>().Count(r => r.Value<bool?>("ok") != true);
            return result;
        }
    }
}
