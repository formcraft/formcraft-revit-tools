var kit = @"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\04_Families\_Staging\";
var tpl = @"C:\ProgramData\Autodesk\RVT 2025\Family Templates\English\Annotations\Metric Generic Annotation.rft";
var app = document.Application; var ci = System.Globalization.CultureInfo.InvariantCulture;
System.EventHandler<Autodesk.Revit.DB.Events.FailuresProcessingEventArgs> fh = (s0, e0) => { var fa = e0.GetFailuresAccessor(); bool r = false; foreach (var m in fa.GetFailureMessages()) { if (m.GetSeverity() == FailureSeverity.Warning) fa.DeleteWarning(m); else if (m.HasResolutions()) { fa.ResolveFailure(m); r = true; } } if (r) e0.SetProcessingResult(FailureProcessingResult.ProceedWithCommit); };
app.FailuresProcessing += fh;
System.Func<string,double> D = s => double.Parse(s, ci) / 304.8;
var fams = new List<List<string[]>>(); foreach (var ln in System.IO.File.ReadAllLines(kit + @"_Build\FMC_SYMK_build.txt")) { if (ln.Length == 0) continue; var p = ln.Split('|'); if (p[0] == "K") fams.Add(new List<string[]>()); fams[fams.Count-1].Add(p); }
var log = new System.Text.StringBuilder();
foreach (var g in fams) {
 var fam = g[0][1]; var path = kit + g[0][2] + @"\" + fam + ".rfa"; if (System.IO.File.Exists(path)) { log.Append(fam + " exists; "); continue; }
 Document fd = null;
 try {
  fd = app.NewFamilyDocument(tpl);
  var view = new FilteredElementCollector(fd).OfClass(typeof(View)).Cast<View>().First(v => !v.IsTemplate && v.ViewType == ViewType.DrawingSheet);
  var fm = fd.FamilyManager; var types = g.Where(p => p[0] == "Y").ToList();
  using (var t = new Transaction(fd, "FMC typed symbol")) { t.Start();
   foreach (var id in new FilteredElementCollector(fd, view.Id).OfClass(typeof(TextNote)).ToElementIds().ToList()) fd.Delete(id);
   var cat = fd.OwnerFamily.FamilyCategory; var sc = new Dictionary<string, Category>();
   var lp = new LinePattern("FMC_Dash"); lp.SetSegments(new List<LinePatternSegment>{ new LinePatternSegment(LinePatternSegmentType.Dash, 1.5/304.8), new LinePatternSegment(LinePatternSegmentType.Space, 1.0/304.8)}); var lpe = LinePatternElement.Create(fd, lp);
   foreach (var kv in new[]{ new[]{"t","FMC_Sym_Thin","1"}, new[]{"m","FMC_Sym_Medium","2"}, new[]{"h","FMC_Sym_Heavy","4"}, new[]{"d","FMC_Sym_Dashed","1"} }) {
    var c = fd.Settings.Categories.NewSubcategory(cat, kv[1]); c.SetLineWeight(int.Parse(kv[2]), GraphicsStyleType.Projection); c.LineColor = new Color(0,0,0);
    if (kv[0] == "d") c.SetLinePatternId(lpe.Id, GraphicsStyleType.Projection); sc[kv[0]] = c; }
   var frt = (FilledRegionType)new FilteredElementCollector(fd).OfClass(typeof(FilledRegionType)).Cast<FilledRegionType>().First().Duplicate("FMC_Solid_Black");
   frt.ForegroundPatternId = FillPatternElement.GetFillPatternElementByName(fd, FillPatternTarget.Drafting, "<Solid fill>").Id; frt.ForegroundPatternColor = new Color(0,0,0); frt.IsMasking = true;
   var invis = new FilteredElementCollector(fd).OfClass(typeof(GraphicsStyle)).Cast<GraphicsStyle>().FirstOrDefault(x => x.Name == "<Invisible lines>");
   var tt0 = new FilteredElementCollector(fd).OfClass(typeof(TextNoteType)).Cast<TextNoteType>().First();
   var x25 = (TextNoteType)tt0.Duplicate("FMC_Arial_2.5"); x25.get_Parameter(BuiltInParameter.TEXT_FONT).Set("Arial"); x25.get_Parameter(BuiltInParameter.TEXT_SIZE).Set(2.5/304.8); x25.get_Parameter(BuiltInParameter.TEXT_WIDTH_SCALE).Set(0.85); x25.get_Parameter(BuiltInParameter.TEXT_BACKGROUND).Set(1);
   var pText = fm.AddParameter("Symbol_Text", GroupTypeId.Text, SpecTypeId.String.Text, false);
   var show = new Dictionary<string, FamilyParameter>(); foreach (var y in types) show[y[1]] = fm.AddParameter("Show_" + y[1], GroupTypeId.Graphics, SpecTypeId.Boolean.YesNo, false);
   System.Func<string,string,XYZ> P = (a, b) => new XYZ(D(a), D(b), 0);
   FamilyParameter cur = null; int n = 0;
   System.Action<Element> V = e => { var vp = e.get_Parameter(BuiltInParameter.IS_VISIBLE_PARAM); if (vp != null) fm.AssociateElementParameterToFamilyParameter(vp, cur); };
   System.Action<Curve,string> DC = (cv, k) => { var dc = fd.FamilyCreate.NewDetailCurve(view, cv); dc.LineStyle = sc[k].GetGraphicsStyle(GraphicsStyleType.Projection); V(dc); n++; };
   foreach (var p in g.Skip(1)) {
    if (p[0] == "Y") { cur = show[p[1]]; continue; }
    try {
     if (p[0] == "L") DC(Line.CreateBound(P(p[1],p[2]), P(p[3],p[4])), p[5]);
     else if (p[0] == "A") DC(Arc.Create(P(p[1],p[2]), P(p[5],p[6]), P(p[3],p[4])), p[7]);
     else if (p[0] == "C") { var c = P(p[1],p[2]); var r = D(p[3]); DC(Arc.Create(c, r, 0, System.Math.PI, XYZ.BasisX, XYZ.BasisY), p[4]); DC(Arc.Create(c, r, System.Math.PI, 2*System.Math.PI, XYZ.BasisX, XYZ.BasisY), p[4]); }
     else if (p[0] == "F") { var loops = new List<CurveLoop>();
      foreach (var s in p.Skip(1)) { var pts = s.Split(';').Select(q => { var xy = q.Split(','); return P(xy[0], xy[1]); }).ToList(); var cl = new CurveLoop(); for (int i = 0; i < pts.Count; i++) cl.Append(Line.CreateBound(pts[i], pts[(i+1) % pts.Count])); loops.Add(cl); }
      var made = new List<FilledRegion>(); try { made.Add(FilledRegion.Create(fd, frt.Id, view.Id, loops)); } catch { foreach (var l in loops) { try { made.Add(FilledRegion.Create(fd, frt.Id, view.Id, new List<CurveLoop>{ l })); } catch {} } }
      foreach (var fr in made) { if (invis != null) fr.SetLineStyleId(invis.Id); V(fr); n++; } }
    } catch (System.Exception ex) { log.Append(fam + ":" + p[0] + " " + ex.Message.Split('.')[0] + "; "); }
   }
   if (g[0][3] != "") { var o = new TextNoteOptions(x25.Id); o.HorizontalAlignment = HorizontalTextAlignment.Center; TextNote.Create(fd, view.Id, P(g[0][3], g[0][4]), "<Symbol_Text label here>", o); }
   t.Commit();
   using (var t2 = new Transaction(fd, "types")) { t2.Start();
    for (int i = 0; i < types.Count; i++) { var y = types[i];
     if (i == 0) { if (fm.CurrentType == null) fm.NewType(y[1]); else fm.RenameCurrentType(y[1]); } else fm.NewType(y[1]);
     foreach (var kv in show) fm.Set(kv.Value, kv.Key == y[1] ? 1 : 0); fm.Set(pText, y.Length > 2 ? y[2] : ""); }
    t2.Commit(); }
   log.Append(fam + " " + n + " elems " + types.Count + " types; "); }
  var so = new SaveAsOptions(); so.MaximumBackups = 1; fd.SaveAs(path, so);
 } catch (System.Exception ex) { log.Append(fam + " FAIL " + ex.Message + "; "); }
 finally { if (fd != null) fd.Close(false); }
}
app.FailuresProcessing -= fh;
return log.ToString();
