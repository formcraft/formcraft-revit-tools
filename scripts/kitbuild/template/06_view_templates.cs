// Step 6: 81 view templates from FMC_VT_build.txt (name|FP/CP/SP/AP/3D/EL/SE/DR|scale or 0|C/M/F|discipline|filters;...)
// with filter overrides from FMC_FilterStyle_build.txt (name|r,g,b|line pattern|S surface fill or L lines). A temporary
// view is made, turned into a template, then removed. Existing templates are skipped. Stops at ~33 s; run again to continue.
var app = document.Application; var p = @"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\06_Templates\_Staging\FMC_Base_Template_v2.2.rte";
var dir = @"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\06_Templates\_Staging\_Build\";
var d = app.Documents.Cast<Document>().FirstOrDefault(x => x.PathName == p) ?? app.OpenDocumentFile(p);
var sw = System.Diagnostics.Stopwatch.StartNew(); var r = new System.Text.StringBuilder(); int made = 0, skip = 0;
var style = System.IO.File.ReadAllLines(dir + "FMC_FilterStyle_build.txt").Select(l => l.Split('|')).ToDictionary(a => a[0], a => a);
var vfts = new FilteredElementCollector(d).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().ToList();
System.Func<ViewFamily, ElementId> VFT = f => vfts.First(x => x.ViewFamily == f).Id;
var lvl = new FilteredElementCollector(d).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => l.Elevation).First();
var flt = new FilteredElementCollector(d).OfClass(typeof(ParameterFilterElement)).Cast<ParameterFilterElement>().ToDictionary(x => x.Name, x => x);
var solid = FillPatternElement.GetFillPatternElementByName(d, FillPatternTarget.Drafting, "<Solid fill>").Id;
var have = new HashSet<string>(new FilteredElementCollector(d).OfClass(typeof(View)).Cast<View>().Where(v => v.IsTemplate).Select(v => v.Name));
var disc = new Dictionary<string,int>{ {"Architectural",1},{"Structural",2},{"Mechanical",4},{"Electrical",8},{"Plumbing",16},{"Coordination",4095} };
using (var t = new Transaction(d, "FMC base: view templates")) { t.Start();
 foreach (var line in System.IO.File.ReadAllLines(dir + "FMC_VT_build.txt")) { var a = line.Split('|'); if (a.Length < 6) continue;
  if (have.Contains(a[0])) { skip++; continue; } if (sw.Elapsed.TotalSeconds > 33) break;
  var tmp = new List<ElementId>();
  try { View v = null;
   switch (a[1]) {
    case "FP": v = ViewPlan.Create(d, VFT(ViewFamily.FloorPlan), lvl.Id); break;
    case "CP": v = ViewPlan.Create(d, VFT(ViewFamily.CeilingPlan), lvl.Id); break;
    case "SP": v = ViewPlan.Create(d, VFT(ViewFamily.StructuralPlan), lvl.Id); break;
    case "AP": { var sch = new FilteredElementCollector(d).OfClass(typeof(AreaScheme)).Cast<AreaScheme>().First(); v = ViewPlan.CreateAreaPlan(d, sch.Id, lvl.Id); break; }
    case "3D": v = View3D.CreateIsometric(d, VFT(ViewFamily.ThreeDimensional)); break;
    case "DR": v = ViewDrafting.Create(d, VFT(ViewFamily.Drafting)); break;
    case "SE": { var bb = new BoundingBoxXYZ(); bb.Min = new XYZ(-10,-10,-10); bb.Max = new XYZ(10,10,10); v = ViewSection.CreateSection(d, VFT(ViewFamily.Section), bb); break; }
    case "EL": { var pl = ViewPlan.Create(d, VFT(ViewFamily.FloorPlan), lvl.Id); tmp.Add(pl.Id); var mk = ElevationMarker.CreateElevationMarker(d, VFT(ViewFamily.Elevation), XYZ.Zero, 100); tmp.Insert(0, mk.Id); v = mk.CreateElevation(d, pl.Id, 0); break; }
   }
   tmp.Insert(0, v.Id);
   if (a[2] != "0") v.Scale = int.Parse(a[2]);
   v.DetailLevel = a[3] == "C" ? ViewDetailLevel.Coarse : a[3] == "F" ? ViewDetailLevel.Fine : ViewDetailLevel.Medium;
   var dp = v.get_Parameter(BuiltInParameter.VIEW_DISCIPLINE); if (dp != null && !dp.IsReadOnly) dp.Set(disc[a[4]]);
   if (a[1] != "DR") foreach (var fn in a[5].Split(';').Where(x => x != "")) { ParameterFilterElement fe; if (!flt.TryGetValue(fn, out fe)) { r.Append("nofilter " + fn + "; "); continue; }
    v.AddFilter(fe.Id); var s = style[fn]; var c = s[1].Split(',').Select(int.Parse).ToArray(); var col = new Color((byte)c[0], (byte)c[1], (byte)c[2]); var o = new OverrideGraphicSettings();
    if (s[3] == "S") { o.SetSurfaceForegroundPatternId(solid); o.SetSurfaceForegroundPatternColor(col); o.SetCutForegroundPatternId(solid); o.SetCutForegroundPatternColor(col); }
    else { o.SetProjectionLineColor(col); o.SetCutLineColor(col); if (s[2] != "") { var lp = LinePatternElement.GetLinePatternElementByName(d, s[2]); if (lp != null) { o.SetProjectionLinePatternId(lp.Id); o.SetCutLinePatternId(lp.Id); } } }
    v.SetFilterOverrides(fe.Id, o); }
   var vt = v.CreateViewTemplate(); vt.Name = a[0]; made++;
  } catch (System.Exception e) { r.Append(a[0] + " FAIL " + e.Message.Split('.')[0] + "; "); }
  foreach (var id in tmp) { try { if (d.GetElement(id) != null) d.Delete(id); } catch {} }
 }
 t.Commit(); }
d.Save();
int total = new FilteredElementCollector(d).OfClass(typeof(View)).Cast<View>().Count(v => v.IsTemplate && v.Name.StartsWith("VT_"));
return "made " + made + " skipped " + skip + " | VT_ total " + total + " | " + r;
