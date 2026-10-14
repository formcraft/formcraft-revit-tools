// Step 4: pipe and duct system types (Discipline_Settings). P_Storm and P_RWH classification is a stand-in (kit change request item 19).
var app = document.Application; var p = @"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\06_Templates\_Staging\FMC_Base_Template_v2.2.rte";
var d = app.Documents.Cast<Document>().FirstOrDefault(x => x.PathName == p) ?? app.OpenDocumentFile(p); var r = new System.Text.StringBuilder();
using (var t = new Transaction(d, "FMC base: system types")) { t.Start();
 var pst = new FilteredElementCollector(d).OfClass(typeof(Autodesk.Revit.DB.Plumbing.PipingSystemType)).Cast<Autodesk.Revit.DB.Plumbing.PipingSystemType>().ToList();
 foreach (var s in new[]{ new[]{"M_Refrigerant","OtherPipe"}, new[]{"M_Condensate","Sanitary"}, new[]{"P_Storm","OtherPipe"}, new[]{"P_RWH","OtherPipe"}, new[]{"L_Irrigation","OtherPipe"}, new[]{"FP_Wet","FireProtectWet"} }) {
  if (pst.Any(x => x.Name == s[0])) { r.Append("had " + s[0] + " "); continue; } var cls = (MEPSystemClassification)System.Enum.Parse(typeof(MEPSystemClassification), s[1]);
  var src = pst.FirstOrDefault(x => x.SystemClassification == cls); if (src == null) { r.Append("no source " + s[0] + "; "); continue; }
  src.Duplicate(s[0]); r.Append("+" + s[0] + " "); }
 var dst = new FilteredElementCollector(d).OfClass(typeof(Autodesk.Revit.DB.Mechanical.MechanicalSystemType)).Cast<Autodesk.Revit.DB.Mechanical.MechanicalSystemType>().ToList();
 if (!dst.Any(x => x.Name == "Outdoor Air")) { var sa = dst.FirstOrDefault(x => x.SystemClassification == MEPSystemClassification.SupplyAir); if (sa != null) { sa.Duplicate("Outdoor Air"); r.Append("+Outdoor Air"); } }
 t.Commit(); }
d.Save(); return r.ToString();
