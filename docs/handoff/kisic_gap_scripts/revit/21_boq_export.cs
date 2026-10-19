// KISIC 21 - BOQ export: every electrical item in the model with type, mark, circuit, switch, position (m) and strip length, as JSON lines.
var sb=new StringBuilder(); string Cm(Element e)=>e.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString()??"";
string Esc(string s)=>(s??"").Replace("\\","/").Replace("\"","'").Replace("\r"," ").Replace("\n"," ");
var cats=new[]{BuiltInCategory.OST_LightingFixtures,BuiltInCategory.OST_LightingDevices,BuiltInCategory.OST_ElectricalFixtures,BuiltInCategory.OST_DataDevices,BuiltInCategory.OST_CommunicationDevices,BuiltInCategory.OST_ElectricalEquipment,BuiltInCategory.OST_MechanicalEquipment,BuiltInCategory.OST_PlumbingFixtures,BuiltInCategory.OST_SpecialityEquipment};
foreach(var c in cats) foreach(FamilyInstance f in new FilteredElementCollector(document).OfClass(typeof(FamilyInstance)).OfCategory(c).Cast<FamilyInstance>()){
 XYZ p=(f.Location as LocationPoint)?.Point??(f.Location as LocationCurve)?.Curve.Evaluate(0.5,true)??XYZ.Zero;
 var len=f.LookupParameter("Length"); double L=len!=null&&len.StorageType==StorageType.Double?FmcScript.ToMm(len.AsDouble())/1000:0;
 var s=f.Symbol; string tm=s.get_Parameter(BuiltInParameter.ALL_MODEL_TYPE_MARK)?.AsString(); string desc=s.get_Parameter(BuiltInParameter.ALL_MODEL_DESCRIPTION)?.AsString();
 string load=s.LookupParameter("Apparent Load")?.AsValueString()??f.LookupParameter("Apparent Load")?.AsValueString();
 sb.AppendLine("{"+$"\"cat\":\"{f.Category.Name}\",\"fam\":\"{s.FamilyName}\",\"type\":\"{Esc(s.Name)}\",\"tm\":\"{Esc(tm)}\",\"desc\":\"{Esc(desc)}\",\"mark\":\"{Esc(f.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString())}\",\"sw\":\"{Esc(f.LookupParameter("FMC Switch")?.AsString())}\",\"cm\":\"{Esc(Cm(f))}\",\"x\":{FmcScript.ToMm(p.X)/1000:0.000},\"y\":{-FmcScript.ToMm(p.Y)/1000:0.000},\"z\":{FmcScript.ToMm(p.Z)/1000:0.000},\"len\":{L:0.000},\"host\":{(f.Host!=null?"true":"false")},\"load\":\"{Esc(load)}\""+"}"); }
// annotation-only items on the power plan (isolators, E-stop, SEB, MET ...)
var pp=document.GetElement(new ElementId(1699165L)) as View;
foreach(var tn in new FilteredElementCollector(document,pp.Id).OfClass(typeof(TextNote)).Cast<TextNote>()) sb.AppendLine("{"+$"\"cat\":\"PlanNote\",\"text\":\"{Esc(tn.Text)}\",\"x\":{FmcScript.ToMm(tn.Coord.X)/1000:0.000},\"y\":{-FmcScript.ToMm(tn.Coord.Y)/1000:0.000}"+"}");
foreach(FamilyInstance a in new FilteredElementCollector(document,pp.Id).OfClass(typeof(FamilyInstance)).OfCategory(BuiltInCategory.OST_GenericAnnotation).Cast<FamilyInstance>()) sb.AppendLine("{"+$"\"cat\":\"PlanSymbol\",\"fam\":\"{a.Symbol.FamilyName}\",\"type\":\"{Esc(a.Symbol.Name)}\""+"}");
return sb.ToString();
