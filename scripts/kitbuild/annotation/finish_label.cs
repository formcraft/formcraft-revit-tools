var doc = document; var v = doc.ActiveView; var r = doc.Title + ": ";
var lab = new FilteredElementCollector(doc, v.Id).OfClass(typeof(TextElement)).Cast<TextElement>().FirstOrDefault(x => !(x is TextNote));
var ph = new FilteredElementCollector(doc, v.Id).OfClass(typeof(TextNote)).Cast<TextNote>().FirstOrDefault(x => x.Text.Contains("Symbol_Text label"));
if (lab != null && ph != null) {
 using (var t = new Transaction(doc, "FMC symbol label")) { t.Start();
  var lt = doc.GetElement(lab.GetTypeId()) as ElementType; var nt = new FilteredElementCollector(doc).OfClass(lt.GetType()).Cast<ElementType>().FirstOrDefault(x => x.Name == "FMC_Label_2.5");
  if (nt == null) { nt = lt.Duplicate("FMC_Label_2.5"); nt.get_Parameter(BuiltInParameter.TEXT_SIZE).Set(2.5/304.8); nt.get_Parameter(BuiltInParameter.TEXT_FONT).Set("Arial"); nt.get_Parameter(BuiltInParameter.TEXT_WIDTH_SCALE).Set(0.85); nt.get_Parameter(BuiltInParameter.TEXT_BACKGROUND).Set(1); }
  lab.ChangeTypeId(nt.Id); lab.HorizontalAlignment = HorizontalTextAlignment.Center; lab.Width = 12/304.8; doc.Regenerate();
  var c = ph.Coord; var lb = lab.get_BoundingBox(v); var lc = (lb.Min + lb.Max) / 2;
  ElementTransformUtils.MoveElement(doc, lab.Id, new XYZ(c.X - lc.X, c.Y - lb.Max.Y + 0.5/304.8, 0));
  doc.Delete(ph.Id); t.Commit(); }
 doc.Save(); r += "label placed; ";
} else r += "lab " + (lab != null) + " ph " + (ph != null) + "; ";
if (NEXT != "") { var u = new Autodesk.Revit.UI.UIApplication(doc.Application).OpenAndActivateDocument(NEXT); r += "opened " + u.Document.Title;
 var me = doc; if (!me.IsModified) me.Close(false); }
return r;
