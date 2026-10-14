var kit = @"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\04_Families\_Staging\";
var tpl = @"C:\ProgramData\Autodesk\RVT 2025\Family Templates\English\Metric Detail Item.rft";
var app = document.Application; var ci = System.Globalization.CultureInfo.InvariantCulture; const double S = 50.0; // drawn for SLD/schematic drafting views at 1:50
System.Func<string,double> D = s => double.Parse(s, ci) * S / 304.8;
var spf = app.OpenSharedParameterFile(); var sdefs = spf.Groups.SelectMany(g => g.Definitions.Cast<Definition>()).OfType<ExternalDefinition>().ToDictionary(d => d.Name, d => d);
// FAM|name|role|sharedInst,..|sharedType,..|famText,..|famInt,..   then TYPE|name  then L|x1|y1|x2|y2|w  C|x|y|r|w  R|x1|y1|x2|y2|w  (common geometry before first TYPE)
var spec = SPEC.Split('\n').Select(x => x.Trim()).Where(x => x.Length > 0).Select(x => x.Split('|')).ToList();
var log = new System.Text.StringBuilder();
var fams = new List<List<string[]>>(); foreach (var p in spec) { if (p[0] == "FAM") fams.Add(new List<string[]>()); fams[fams.Count-1].Add(p); }
foreach (var g in fams) {
 var name = g[0][1]; var path = kit + g[0][2] + @"\" + name + ".rfa"; if (System.IO.File.Exists(path)) { log.Append(name + " exists; "); continue; }
 Document fd = null;
 try {
  fd = app.NewFamilyDocument(tpl);
  var view = new FilteredElementCollector(fd).OfClass(typeof(View)).Cast<View>().First(v => !v.IsTemplate && v.ViewType == ViewType.FloorPlan);
  var fm = fd.FamilyManager; var types = g.Where(p => p[0] == "TYPE").Select(p => p[1]).ToList(); var show = new Dictionary<string, FamilyParameter>();
  using (var t = new Transaction(fd, "FMC detail item")) { t.Start();
   foreach (var id in new FilteredElementCollector(fd, view.Id).OfClass(typeof(TextNote)).ToElementIds().ToList()) fd.Delete(id);
   var cat = fd.OwnerFamily.FamilyCategory; var sc = new Dictionary<string, GraphicsStyle>();
   foreach (var kv in new[]{ new[]{"t","FMC_DI_Thin","1"}, new[]{"m","FMC_DI_Medium","3"}, new[]{"h","FMC_DI_Heavy","5"} }) { var c = cat.SubCategories.Contains(kv[1]) ? cat.SubCategories.get_Item(kv[1]) : fd.Settings.Categories.NewSubcategory(cat, kv[1]); c.SetLineWeight(int.Parse(kv[2]), GraphicsStyleType.Projection); c.LineColor = new Color(0,0,0); sc[kv[0]] = c.GetGraphicsStyle(GraphicsStyleType.Projection); }
   foreach (var n in g[0][3].Split(',').Where(x => x != "")) { if (sdefs.ContainsKey(n)) fm.AddParameter(sdefs[n], GroupTypeId.IdentityData, true); else log.Append("missing shared " + n + "; "); }
   foreach (var n in g[0][4].Split(',').Where(x => x != "")) { if (sdefs.ContainsKey(n)) fm.AddParameter(sdefs[n], GroupTypeId.IdentityData, false); else log.Append("missing shared " + n + "; "); }
   foreach (var n in g[0][5].Split(',').Where(x => x != "")) fm.AddParameter(n, GroupTypeId.IdentityData, SpecTypeId.String.Text, true);
   foreach (var n in g[0][6].Split(',').Where(x => x != "")) fm.AddParameter(n, GroupTypeId.IdentityData, SpecTypeId.Int.Integer, false);
   foreach (var ty in types) show[ty] = fm.AddParameter("Show_" + ty, GroupTypeId.Graphics, SpecTypeId.Boolean.YesNo, false);
   System.Func<string,string,XYZ> P = (a, b) => new XYZ(D(a), D(b), 0); FamilyParameter cur = null; int n2 = 0;
   System.Action<Curve,string> DC = (cv, k) => { var dc = fd.FamilyCreate.NewDetailCurve(view, cv); dc.LineStyle = sc[k]; if (cur != null) { var vp = dc.get_Parameter(BuiltInParameter.IS_VISIBLE_PARAM); if (vp != null) fm.AssociateElementParameterToFamilyParameter(vp, cur); } n2++; };
   foreach (var p in g.Skip(1)) {
    try {
     if (p[0] == "TYPE") cur = show[p[1]];
     else if (p[0] == "L") DC(Line.CreateBound(P(p[1],p[2]), P(p[3],p[4])), p[5]);
     else if (p[0] == "R") { var a = P(p[1],p[2]); var b = P(p[3],p[4]); var q = new[]{ a, new XYZ(b.X,a.Y,0), b, new XYZ(a.X,b.Y,0) }; for (int i = 0; i < 4; i++) DC(Line.CreateBound(q[i], q[(i+1)%4]), p[5]); }
     else if (p[0] == "C") { var c = P(p[1],p[2]); var r = D(p[3]); DC(Arc.Create(c, r, 0, System.Math.PI, XYZ.BasisX, XYZ.BasisY), p[4]); DC(Arc.Create(c, r, System.Math.PI, 2*System.Math.PI, XYZ.BasisX, XYZ.BasisY), p[4]); }
    } catch (System.Exception ex) { log.Append(name + ":" + string.Join(",", p) + " " + ex.Message.Split('.')[0] + "; "); }
   }
   t.Commit(); log.Append(name + " " + n2 + " curves; "); }
  using (var t2 = new Transaction(fd, "types")) { t2.Start();
   for (int i = 0; i < types.Count; i++) { if (i == 0 && fm.CurrentType != null) fm.RenameCurrentType(types[i]); else fm.NewType(types[i]);
    foreach (var kv in show) fm.Set(kv.Value, kv.Key == types[i] ? 1 : 0); }
   t2.Commit(); }
  System.IO.Directory.CreateDirectory(kit + g[0][2]);
  var so = new SaveAsOptions(); so.MaximumBackups = 1; fd.SaveAs(path, so);
 } catch (System.Exception ex) { log.Append(name + " FAIL " + ex.Message + "; "); }
 finally { if (fd != null) fd.Close(false); }
}
return log.ToString();
