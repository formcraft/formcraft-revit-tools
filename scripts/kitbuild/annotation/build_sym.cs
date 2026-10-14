double TLIM = 40; int MLIM = 999;
var kit = @"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\04_Families\_Staging\";
var tpl = @"C:\ProgramData\Autodesk\RVT 2025\Family Templates\English\Annotations\Metric Generic Annotation.rft";
var app = document.Application; var sw = System.Diagnostics.Stopwatch.StartNew();
var ci = System.Globalization.CultureInfo.InvariantCulture;
System.EventHandler<Autodesk.Revit.DB.Events.FailuresProcessingEventArgs> fh = (s0, e0) => { var fa = e0.GetFailuresAccessor(); bool r = false; foreach (var m in fa.GetFailureMessages()) { if (m.GetSeverity() == FailureSeverity.Warning) fa.DeleteWarning(m); else if (m.HasResolutions()) { fa.ResolveFailure(m); r = true; } } if (r) e0.SetProcessingResult(FailureProcessingResult.ProceedWithCommit); };
app.FailuresProcessing += fh;
System.Func<string,double> D = s => double.Parse(s, ci) / 304.8;
var lines = System.IO.File.ReadAllLines(kit + @"_Build\FMC_SYM_build.txt");
var groups = new List<List<string[]>>(); foreach (var ln in lines) { if (ln.Length == 0) continue; var p = ln.Split('|'); if (p[0] == "S") groups.Add(new List<string[]>()); groups[groups.Count-1].Add(p); }
int made = 0, skip = 0, nf = 0; var errs = new System.Text.StringBuilder();
foreach (var g in groups) {
 if (sw.Elapsed.TotalSeconds > TLIM || made >= MLIM || nf >= 2) break;
 var role = g[0][1]; var fam = g[0][2]; var dir = kit + role + @"\"; var path = dir + fam + ".rfa";
 if (System.IO.File.Exists(path)) { skip++; continue; }
 Document fd = null;
 try {
  fd = app.NewFamilyDocument(tpl);
  var view = new FilteredElementCollector(fd).OfClass(typeof(View)).Cast<View>().First(v => !v.IsTemplate && (v.ViewType == ViewType.FloorPlan || v.ViewType == ViewType.DrawingSheet || v.ViewType == ViewType.Legend || v.ViewType == ViewType.DraftingView));
  using (var t = new Transaction(fd, "FMC symbol")) { t.Start();
   foreach (var id in new FilteredElementCollector(fd, view.Id).OfClass(typeof(TextNote)).ToElementIds().ToList()) fd.Delete(id);
   var cat = fd.OwnerFamily.FamilyCategory; var sc = new Dictionary<string, Category>();
   var lp = new LinePattern("FMC_Dash"); lp.SetSegments(new List<LinePatternSegment>{ new LinePatternSegment(LinePatternSegmentType.Dash, 1.5/304.8), new LinePatternSegment(LinePatternSegmentType.Space, 1.0/304.8)}); var lpe = LinePatternElement.Create(fd, lp);
   foreach (var kv in new[]{ new[]{"t","FMC_Sym_Thin","1"}, new[]{"m","FMC_Sym_Medium","2"}, new[]{"h","FMC_Sym_Heavy","4"}, new[]{"d","FMC_Sym_Dashed","1"} }) {
    var c = fd.Settings.Categories.NewSubcategory(cat, kv[1]); c.SetLineWeight(int.Parse(kv[2]), GraphicsStyleType.Projection); c.LineColor = new Color(0,0,0);
    if (kv[0] == "d") c.SetLinePatternId(lpe.Id, GraphicsStyleType.Projection); sc[kv[0]] = c; }
   var frt0 = new FilteredElementCollector(fd).OfClass(typeof(FilledRegionType)).Cast<FilledRegionType>().First();
   var frt = (FilledRegionType)frt0.Duplicate("FMC_Solid_Black");
   frt.ForegroundPatternId = FillPatternElement.GetFillPatternElementByName(fd, FillPatternTarget.Drafting, "<Solid fill>").Id; frt.ForegroundPatternColor = new Color(0,0,0); frt.IsMasking = true;
   var invis = new FilteredElementCollector(fd).OfClass(typeof(GraphicsStyle)).Cast<GraphicsStyle>().FirstOrDefault(x => x.Name == "<Invisible lines>");
   var tt0 = new FilteredElementCollector(fd).OfClass(typeof(TextNoteType)).Cast<TextNoteType>().First();
   var tt = new Dictionary<string, TextNoteType>();
   foreach (var b in new[]{"0","1"}) { var x = (TextNoteType)tt0.Duplicate(b == "1" ? "FMC_Arial_2.5_Bold" : "FMC_Arial_2.5");
    x.get_Parameter(BuiltInParameter.TEXT_FONT).Set("Arial"); x.get_Parameter(BuiltInParameter.TEXT_SIZE).Set(2.5/304.8); x.get_Parameter(BuiltInParameter.TEXT_WIDTH_SCALE).Set(0.85);
    x.get_Parameter(BuiltInParameter.TEXT_BACKGROUND).Set(1); x.get_Parameter(BuiltInParameter.TEXT_STYLE_BOLD).Set(b == "1" ? 1 : 0); x.get_Parameter(BuiltInParameter.LINE_COLOR).Set(0); tt[b] = x; }
   System.Func<string,string,XYZ> P = (a, b) => new XYZ(D(a), D(b), 0);
   System.Action<Curve,string> DC = (cv, k) => { var dc = fd.FamilyCreate.NewDetailCurve(view, cv); dc.LineStyle = sc[k].GetGraphicsStyle(GraphicsStyleType.Projection); };
   foreach (var p in g.Skip(1)) {
    try {
     if (p[0] == "L") DC(Line.CreateBound(P(p[1],p[2]), P(p[3],p[4])), p[5]);
     else if (p[0] == "A") DC(Arc.Create(P(p[1],p[2]), P(p[5],p[6]), P(p[3],p[4])), p[7]);
     else if (p[0] == "C") { var c = P(p[1],p[2]); var r = D(p[3]); DC(Arc.Create(c, r, 0, System.Math.PI, XYZ.BasisX, XYZ.BasisY), p[4]); DC(Arc.Create(c, r, System.Math.PI, 2*System.Math.PI, XYZ.BasisX, XYZ.BasisY), p[4]); }
     else if (p[0] == "F") { var loops = new List<CurveLoop>();
      foreach (var s in p.Skip(1)) { var pts = s.Split(';').Select(q => { var xy = q.Split(','); return P(xy[0], xy[1]); }).ToList(); var cl = new CurveLoop(); for (int i = 0; i < pts.Count; i++) cl.Append(Line.CreateBound(pts[i], pts[(i+1) % pts.Count])); loops.Add(cl); }
      FilledRegion fr; try { fr = FilledRegion.Create(fd, frt.Id, view.Id, loops); } catch { fr = null; foreach (var l in loops) { try { fr = FilledRegion.Create(fd, frt.Id, view.Id, new List<CurveLoop>{ l }); if (invis != null) fr.SetLineStyleId(invis.Id); } catch {} } }
      if (fr != null && invis != null) fr.SetLineStyleId(invis.Id); }
     else if (p[0] == "T") { var o = new TextNoteOptions(tt[p[5]].Id); o.HorizontalAlignment = p[4] == "c" ? HorizontalTextAlignment.Center : p[4] == "r" ? HorizontalTextAlignment.Right : HorizontalTextAlignment.Left; o.VerticalAlignment = VerticalTextAlignment.Bottom;
      TextNote.Create(fd, view.Id, P(p[1],p[2]) + new XYZ(0, -0.5/304.8, 0), p[6], o); }
    } catch (System.Exception ex) { errs.Append(fam + ":" + p[0] + " " + ex.Message.Split('.')[0] + "; "); }
   }
   t.Commit(); }
  System.IO.Directory.CreateDirectory(dir);
  var so = new SaveAsOptions(); so.MaximumBackups = 1; fd.SaveAs(path, so); made++;
 } catch (System.Exception ex) { errs.Append(fam + " FAIL " + ex.Message + "; "); nf++; }
 finally { if (fd != null) fd.Close(false); }
}
app.FailuresProcessing -= fh;
int left = groups.Count(gg => !System.IO.File.Exists(kit + gg[0][1] + @"\" + gg[0][2] + ".rfa"));
return "made " + made + " skip " + skip + " left " + left + " t=" + (int)sw.Elapsed.TotalSeconds + " | " + errs.ToString();
