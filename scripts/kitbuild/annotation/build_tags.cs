var kit = @"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\04_Families\_Staging\";
var troot = @"C:\ProgramData\Autodesk\RVT 2025\Family Templates\English\";
var app = document.Application; var ci = System.Globalization.CultureInfo.InvariantCulture; var sw = System.Diagnostics.Stopwatch.StartNew();
System.EventHandler<Autodesk.Revit.DB.Events.FailuresProcessingEventArgs> fh = (s0, e0) => { var fa = e0.GetFailuresAccessor(); bool r = false; foreach (var m in fa.GetFailureMessages()) { if (m.GetSeverity() == FailureSeverity.Warning) fa.DeleteWarning(m); else if (m.HasResolutions()) { fa.ResolveFailure(m); r = true; } } if (r) e0.SetProcessingResult(FailureProcessingResult.ProceedWithCommit); };
app.FailuresProcessing += fh;
System.Func<string,double> D = s => double.Parse(s, ci) / 304.8;
var spf = app.OpenSharedParameterFile(); var sdefs = spf.Groups.SelectMany(g => g.Definitions.Cast<Definition>()).OfType<ExternalDefinition>().ToDictionary(d => d.Name, d => d);
var fams = new List<List<string[]>>(); foreach (var ln in System.IO.File.ReadAllLines(kit + @"_Build\FMC_TAG_build.txt")) { if (ln.Length == 0) continue; var p = ln.Split('|'); if (p[0] == "N") fams.Add(new List<string[]>()); fams[fams.Count-1].Add(p); }
var log = new System.Text.StringBuilder(); int made = 0;
foreach (var g in fams) {
 if (sw.Elapsed.TotalSeconds > 38) break;
 var name = g[0][1]; var path = kit + g[0][3] + @"\" + name + ".rfa"; if (System.IO.File.Exists(path)) continue;
 Document fd = null;
 try {
  fd = app.NewFamilyDocument(troot + g[0][2]);
  var view = new FilteredElementCollector(fd).OfClass(typeof(View)).Cast<View>().First(v => !v.IsTemplate && (v.ViewType == ViewType.FloorPlan || v.ViewType == ViewType.DrawingSheet || v.ViewType == ViewType.Legend || v.ViewType == ViewType.DraftingView || v.ViewType == ViewType.Elevation || v.ViewType == ViewType.Section || v.ViewType == ViewType.Detail));
  var fm = fd.FamilyManager; var types = g.First(p => p[0] == "Y")[1].Split(',');
  var yn = new Dictionary<string, FamilyParameter>(); var ynv = new Dictionary<string, string[]>(); var tp = new Dictionary<string, FamilyParameter>(); var tpv = new Dictionary<string, string[]>();
  using (var t = new Transaction(fd, "FMC tag")) { t.Start();
   if (g[0][4] != "") fd.OwnerFamily.FamilyCategory = Category.GetCategory(fd, (BuiltInCategory)System.Enum.Parse(typeof(BuiltInCategory), g[0][4]));
   var old = new FilteredElementCollector(fd, view.Id).WhereElementIsNotElementType().ToElements().Where(e => e is TextElement || (e is CurveElement && !(e is ReferencePlane))).Select(e => e.Id).ToList(); foreach (var id in old) { try { fd.Delete(id); } catch {} }
   var cat = fd.OwnerFamily.FamilyCategory; var sc = new Dictionary<string, GraphicsStyle>();
   foreach (var kv in new[]{ new[]{"t","FMC_Thin","1"}, new[]{"m","FMC_Medium","2"}, new[]{"h","FMC_Heavy","4"} }) { var c = cat.SubCategories.Contains(kv[1]) ? cat.SubCategories.get_Item(kv[1]) : fd.Settings.Categories.NewSubcategory(cat, kv[1]); c.SetLineWeight(int.Parse(kv[2]), GraphicsStyleType.Projection); c.LineColor = new Color(0,0,0); sc[kv[0]] = c.GetGraphicsStyle(GraphicsStyleType.Projection); }
   var frt0 = new FilteredElementCollector(fd).OfClass(typeof(FilledRegionType)).Cast<FilledRegionType>().FirstOrDefault(); FilledRegionType frt = null;
   if (frt0 != null) { frt = (FilledRegionType)frt0.Duplicate("FMC_Solid_Black"); frt.ForegroundPatternId = FillPatternElement.GetFillPatternElementByName(fd, FillPatternTarget.Drafting, "<Solid fill>").Id; frt.ForegroundPatternColor = new Color(0,0,0); frt.IsMasking = true; }
   var invis = new FilteredElementCollector(fd).OfClass(typeof(GraphicsStyle)).Cast<GraphicsStyle>().FirstOrDefault(x => x.Name == "<Invisible lines>");
   var tt0 = new FilteredElementCollector(fd).OfClass(typeof(TextNoteType)).Cast<TextNoteType>().First(); var tts = new Dictionary<string, TextNoteType>();
   System.Func<string, TextNoteType> TT = sz => { TextNoteType x; if (tts.TryGetValue(sz, out x)) return x; x = (TextNoteType)tt0.Duplicate("FMC_Arial_" + sz); x.get_Parameter(BuiltInParameter.TEXT_FONT).Set("Arial"); x.get_Parameter(BuiltInParameter.TEXT_SIZE).Set(D(sz)); x.get_Parameter(BuiltInParameter.TEXT_WIDTH_SCALE).Set(0.9); x.get_Parameter(BuiltInParameter.TEXT_BACKGROUND).Set(1); tts[sz] = x; return x; };
   foreach (var p in g.Where(p => p[0] == "B")) foreach (var it in p[1].Split(';')) { var kv = it.Split(':'); bool inst = kv[1] == "";
    FamilyParameter fp = fm.get_Parameter(kv[0]); if (fp == null) fp = kv[0].StartsWith("FMC_") && sdefs.ContainsKey(kv[0]) ? fm.AddParameter(sdefs[kv[0]], GroupTypeId.Graphics, inst) : fm.AddParameter(kv[0], GroupTypeId.Graphics, SpecTypeId.Boolean.YesNo, inst);
    yn[kv[0]] = fp; if (!inst) ynv[kv[0]] = kv[1].Split(','); }
   foreach (var p in g.Where(p => p[0] == "S")) { if (p[1] == "#inst") { foreach (var n in p[2].Split(',')) tp[n] = fm.AddParameter(n, GroupTypeId.Text, SpecTypeId.String.Text, true); } else { tp[p[1]] = fm.AddParameter(p[1], GroupTypeId.Text, SpecTypeId.String.Text, false); tpv[p[1]] = p[2].Split(','); } }
   System.Func<string,string,XYZ> P = (a, b) => new XYZ(D(a), D(b), 0);
   System.Action<Element,string> V = (e, vis) => { if (string.IsNullOrEmpty(vis) || !yn.ContainsKey(vis)) return; var vp = e.get_Parameter(BuiltInParameter.IS_VISIBLE_PARAM); if (vp != null) fm.AssociateElementParameterToFamilyParameter(vp, yn[vis]); };
   foreach (var p in g) {
    try {
     if (p[0] == "L") { var dc = fd.FamilyCreate.NewDetailCurve(view, Line.CreateBound(P(p[1],p[2]), P(p[3],p[4]))); dc.LineStyle = sc[p[5]]; V(dc, p.Length > 6 ? p[6] : ""); }
     else if (p[0] == "C") { var c = P(p[1],p[2]); var r = D(p[3]); foreach (var a in new[]{0.0, System.Math.PI}) { var dc = fd.FamilyCreate.NewDetailCurve(view, Arc.Create(c, r, a, a + System.Math.PI, XYZ.BasisX, XYZ.BasisY)); dc.LineStyle = sc[p[4]]; V(dc, p.Length > 5 ? p[5] : ""); } }
     else if (p[0] == "F" && frt != null) { var pts = p[1].Split(';').Select(q => { var xy = q.Split(','); return P(xy[0], xy[1]); }).ToList(); var cl = new CurveLoop(); for (int i = 0; i < pts.Count; i++) cl.Append(Line.CreateBound(pts[i], pts[(i+1) % pts.Count]));
      var fr = FilledRegion.Create(fd, frt.Id, view.Id, new List<CurveLoop>{ cl }); if (invis != null) fr.SetLineStyleId(invis.Id); V(fr, p.Length > 2 ? p[2].Replace("vis=", "") : ""); }
     else if (p[0] == "T" || p[0] == "P") { var isP = p[0] == "P"; var sz = p[4]; var al = p[5]; var o = new TextNoteOptions(TT(sz).Id); o.HorizontalAlignment = al == "c" ? HorizontalTextAlignment.Center : al == "r" ? HorizontalTextAlignment.Right : HorizontalTextAlignment.Left; o.VerticalAlignment = VerticalTextAlignment.Middle;
      TextNote.Create(fd, view.Id, P(p[2], p[3]), isP ? "<<" + p[1] + ";" + p[6] + ";" + p[7] + ";" + al + ";" + sz + ">>" : p[1], o); }
    } catch (System.Exception ex) { log.Append(name + ":" + p[0] + " " + ex.Message.Split('.')[0] + "; "); }
   }
   t.Commit(); }
  using (var t2 = new Transaction(fd, "types")) { t2.Start();
   for (int i = 0; i < types.Length; i++) { if (i == 0 && fm.CurrentType != null) fm.RenameCurrentType(types[i]); else fm.NewType(types[i]);
    foreach (var kv in ynv) fm.Set(yn[kv.Key], int.Parse(kv.Value[i])); foreach (var kv in tpv) fm.Set(tp[kv.Key], kv.Value[i]); }
   t2.Commit(); }
  System.IO.Directory.CreateDirectory(kit + g[0][3]);
  var so = new SaveAsOptions(); so.MaximumBackups = 1; fd.SaveAs(path, so); made++;
 } catch (System.Exception ex) { log.Append(name + " FAIL " + ex.Message + "; "); }
 finally { if (fd != null) fd.Close(false); }
}
app.FailuresProcessing -= fh;
int left = fams.Count(gg => !System.IO.File.Exists(kit + gg[0][3] + @"\" + gg[0][1] + ".rfa"));
return "made " + made + " left " + left + " | " + log.ToString();
