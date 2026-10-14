var doc = document; var v = doc.ActiveView; var fm = doc.FamilyManager; var r = doc.Title + ": ";
var labs = new FilteredElementCollector(doc, v.Id).OfClass(typeof(TextElement)).Cast<TextElement>().Where(x => !(x is TextNote)).OrderBy(x => x.Id.Value).ToList();
var phs = new FilteredElementCollector(doc, v.Id).OfClass(typeof(TextNote)).Cast<TextNote>().Where(x => x.Text.StartsWith("<<")).OrderBy(x => x.Id.Value).ToList();
if (labs.Count != phs.Count) return "count mismatch labels " + labs.Count + " placeholders " + phs.Count;
int k = 0;
using (var t = new Transaction(doc, "FMC place labels")) { t.Start();
 foreach (var ph in phs) {
  var s = ph.Text.Trim().Trim('<', '>').Split(';'); var nm = s[0];
  var lab = labs[k++];
  var lt = doc.GetElement(lab.GetTypeId()) as ElementType; var tn = "FMC_Label_" + s[4];
  var nt = new FilteredElementCollector(doc).OfClass(lt.GetType()).Cast<ElementType>().FirstOrDefault(x => x.Name == tn);
  if (nt == null) { nt = lt.Duplicate(tn); nt.get_Parameter(BuiltInParameter.TEXT_SIZE).Set(double.Parse(s[4], System.Globalization.CultureInfo.InvariantCulture) / 304.8); nt.get_Parameter(BuiltInParameter.TEXT_FONT).Set("Arial"); nt.get_Parameter(BuiltInParameter.TEXT_WIDTH_SCALE).Set(0.9); nt.get_Parameter(BuiltInParameter.TEXT_BACKGROUND).Set(1); }
  lab.ChangeTypeId(nt.Id); lab.HorizontalAlignment = s[3] == "c" ? HorizontalTextAlignment.Center : s[3] == "r" ? HorizontalTextAlignment.Right : HorizontalTextAlignment.Left;
  try { lab.Width = double.Parse(s[2]) / 304.8; } catch {}
  doc.Regenerate(); var pb = ph.get_BoundingBox(v); var lb = lab.get_BoundingBox(v);
  double tx = s[3] == "c" ? (pb.Min.X + pb.Max.X) / 2 - (lb.Min.X + lb.Max.X) / 2 : s[3] == "r" ? pb.Max.X - lb.Max.X : pb.Min.X - lb.Min.X;
  ElementTransformUtils.MoveElement(doc, lab.Id, new XYZ(tx, (pb.Min.Y + pb.Max.Y) / 2 - (lb.Min.Y + lb.Max.Y) / 2, 0));
  if (s[1] != "") { var fp = fm.get_Parameter(s[1]); var vp = lab.get_Parameter(BuiltInParameter.IS_VISIBLE_PARAM); if (fp != null && vp != null) fm.AssociateElementParameterToFamilyParameter(vp, fp); else r += "novis " + nm + "; "; }
  doc.Delete(ph.Id); r += "ok " + nm + "; ";
 }
 t.Commit(); }
doc.Save();
if (NEXT != "") { var me = doc; var u = new Autodesk.Revit.UI.UIApplication(doc.Application).OpenAndActivateDocument(NEXT); if (!me.IsModified) me.Close(false); r += "| opened " + u.Document.Title; }
return r;
