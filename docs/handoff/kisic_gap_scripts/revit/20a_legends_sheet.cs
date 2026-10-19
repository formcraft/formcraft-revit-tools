// KISIC 20a - legend views with real legend components (seed copied from the kit template's LG_Seed_Component), one row per type used in the model,
// + sheet E-1201 "Schedules & legends" on FMC_TB_A0 with the luminaire, switching and power & data schedules.
var log=new StringBuilder(); double M(double mm)=>FmcScript.Mm(mm);
var app=document.Application; var tpl=@"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\06_Templates\_Staging\FMC_E_Template_v2.2.rte";
string TM(FamilySymbol s)=>s.get_Parameter(BuiltInParameter.ALL_MODEL_TYPE_MARK)?.AsString()??"";
string Desc(FamilySymbol s){ var d=s.get_Parameter(BuiltInParameter.ALL_MODEL_DESCRIPTION)?.AsString(); if(string.IsNullOrWhiteSpace(d)) d=s.get_Parameter(BuiltInParameter.ALL_MODEL_TYPE_COMMENTS)?.AsString(); return string.IsNullOrWhiteSpace(d)?s.FamilyName.Replace("FMC_","").Replace("_"," "):d; }
List<FamilySymbol> Used(params BuiltInCategory[] cats){ var ids=new HashSet<long>(); foreach(var c in cats) foreach(FamilyInstance f in new FilteredElementCollector(document).OfCategory(c).WhereElementIsNotElementType().Cast<FamilyInstance>()) ids.Add(f.Symbol.Id.Value);
 return ids.Select(i=>(FamilySymbol)document.GetElement(new ElementId(i))).OrderBy(s=>s.Category.Name).ThenBy(s=>TM(s)).ThenBy(s=>s.FamilyName).ThenBy(s=>s.Name).ToList(); }
var lights=Used(BuiltInCategory.OST_LightingFixtures);
var fan=new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().First(s=>s.FamilyName=="FMC_M_MechEq_CeilingFan"&&s.Name=="1400_3Blade"); lights.Add(fan);
var devices=Used(BuiltInCategory.OST_LightingDevices,BuiltInCategory.OST_ElectricalFixtures,BuiltInCategory.OST_DataDevices,BuiltInCategory.OST_CommunicationDevices,BuiltInCategory.OST_ElectricalEquipment,BuiltInCategory.OST_MechanicalEquipment);
devices=devices.Where(s=>s.FamilyName!="FMC_M_MechEq_CeilingFan").ToList();
log.Append($"types: lights {lights.Count}, devices {devices.Count}; ");
// 1 copy the seed legend component from the kit template
var td=app.OpenDocumentFile(tpl); ElementId seedId=ElementId.InvalidElementId; View src=null; ICollection<ElementId> copied=null;
var legSrc=new FilteredElementCollector(document).OfClass(typeof(View)).Cast<View>().First(v=>v.ViewType==ViewType.Legend&&!v.IsTemplate&&v.Name=="Symbols");
using(var t=new Transaction(document,"KISIC 20a legends + E-1201")){ var fo=t.GetFailureHandlingOptions(); fo.SetFailuresPreprocessor(new FmcFailures()); t.SetFailureHandlingOptions(fo); t.Start();
try{
 src=new FilteredElementCollector(td).OfClass(typeof(View)).Cast<View>().First(v=>v.ViewType==ViewType.Legend&&v.Name=="LG_Seed_Component");
 var seed=new FilteredElementCollector(td,src.Id).OfCategory(BuiltInCategory.OST_LegendComponents).First();
 var tts=new FilteredElementCollector(document).OfClass(typeof(TextNoteType)).Cast<TextNoteType>().ToList();
 var tB=tts.First(x=>x.Name=="FMC 2.5 Bold"); var tN=tts.FirstOrDefault(x=>x.Name.Contains("2.5")&&!x.Name.Contains("Bold"))??tB; var tH=tts.FirstOrDefault(x=>x.Name=="FMC 5 Bold")??tB;
 View MakeLegend(string name,string title,List<FamilySymbol> types,int perCol){
  foreach(var old in new FilteredElementCollector(document).OfClass(typeof(View)).Cast<View>().Where(v=>v.Name==name).Select(v=>v.Id).ToList()) document.Delete(old);
  var lv=(View)document.GetElement(legSrc.Duplicate(ViewDuplicateOption.Duplicate)); lv.Name=name; lv.Scale=25;
  var cp=ElementTransformUtils.CopyElements(src,new List<ElementId>{seed.Id},lv,Transform.Identity,new CopyPasteOptions()); var proto=document.GetElement(cp.First());
  double sc=25; double rowP=M(34*sc), colP=M(185*sc), txtX=M(40*sc); int ok=0; var fails=new List<string>();
  TextNote.Create(document,lv.Id,new XYZ(0,M(12*sc),0),title,tH.Id);
  TextNote.Create(document,lv.Id,new XYZ(0,M(5*sc),0),"Symbol",tB.Id); TextNote.Create(document,lv.Id,new XYZ(txtX,M(5*sc),0),"Mark · type · description",tB.Id);
  for(int i=0;i<types.Count;i++){ var s=types[i]; int col=i/perCol, row=i%perCol; var at=new XYZ(col*colP+M(15*sc),-row*rowP-M(12*sc),0);
   var pb=proto.get_BoundingBox(lv); var pc=pb==null?XYZ.Zero:new XYZ((pb.Min.X+pb.Max.X)/2,(pb.Min.Y+pb.Max.Y)/2,0); ElementId nid=ElementTransformUtils.CopyElement(document,proto.Id,at-pc).First(); var lc=document.GetElement(nid);
   try{ lc.get_Parameter(BuiltInParameter.LEGEND_COMPONENT).Set(s.Id); document.Regenerate(); var b2=lc.get_BoundingBox(lv); if(b2!=null){ var c2=new XYZ((b2.Min.X+b2.Max.X)/2,(b2.Min.Y+b2.Max.Y)/2,0); ElementTransformUtils.MoveElement(document,nid,at-c2); } ok++; }catch(Exception ex){ document.Delete(nid); fails.Add(s.Name+":"+ex.Message); }
   var tn=TextNote.Create(document,lv.Id,new XYZ(col*colP+txtX,-row*rowP-M(4*sc),0),$"{(TM(s)==""?"-":TM(s))}  {s.FamilyName.Replace("FMC_","")} : {s.Name}\r{Desc(s)}",tN.Id); tn.Width=M(135); }
  document.Delete(proto.Id);
  log.Append($"{name}: {ok}/{types.Count} components{(fails.Count>0?" fails "+string.Join("|",fails):"")}; "); return lv; }
 var lA=MakeLegend("E-LEG-02 Lighting fittings legend","LIGHTING FITTINGS & CEILING FAN",lights,(lights.Count+1)/2);
 var lB=MakeLegend("E-LEG-03 Switches, outlets & equipment legend","SWITCHES, OUTLETS & EQUIPMENT",devices,(devices.Count+1)/2);
 // 2 sheet E-1201
 foreach(var old in new FilteredElementCollector(document).OfClass(typeof(ViewSheet)).Cast<ViewSheet>().Where(s=>s.SheetNumber=="E-1201").Select(s=>s.Id).ToList()) document.Delete(old);
 var tb=new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).OfCategory(BuiltInCategory.OST_TitleBlocks).Cast<FamilySymbol>().First(x=>x.FamilyName=="FMC_TB_A0");
 var sh=ViewSheet.Create(document,tb.Id); sh.SheetNumber="E-1201"; sh.Name="Schedules & legends";
 var ti=new FilteredElementCollector(document,sh.Id).OfCategory(BuiltInCategory.OST_TitleBlocks).Cast<FamilyInstance>().First();
 foreach(var (nm,val) in new[]{("Drawn By","Formcraft"),("Designed By","Formcraft"),("Checked By",""),("Approved By",""),("Sheet Issue Date","19.10.2026")}){ var p=ti.LookupParameter(nm)??sh.LookupParameter(nm); if(p!=null&&!p.IsReadOnly) p.Set(val); }
 document.Regenerate();
 Viewport Put(View v,double left,double top){ var vp=Viewport.Create(document,sh.Id,v.Id,new XYZ(M(500),M(400),0)); document.Regenerate(); var o=vp.GetBoxOutline(); var c=vp.GetBoxCenter();
  vp.SetBoxCenter(c+new XYZ(M(left)-o.MinimumPoint.X,M(top)-o.MaximumPoint.Y,0)); return vp; }
 Put(lA,40,815); Put(lB,40,520);
 ViewSchedule VS(string n)=>new FilteredElementCollector(document).OfClass(typeof(ViewSchedule)).Cast<ViewSchedule>().First(v=>v.Name==n);
 ScheduleSheetInstance.Create(document,sh.Id,VS("E-SCH-01 Luminaire schedule").Id,new XYZ(M(560),M(815),0));
 ScheduleSheetInstance.Create(document,sh.Id,VS("E-SCH-02 Switching schedule").Id,new XYZ(M(560),M(560),0));
 ScheduleSheetInstance.Create(document,sh.Id,VS("E-SCH-03 Power & data schedule").Id,new XYZ(M(780),M(815),0));
 log.Append("sheet "+sh.Id.Value+"; ");
 t.Commit();
}catch(Exception e){ if(t.GetStatus()==TransactionStatus.Started) t.RollBack(); log.Append("FAILED "+e.GetType().Name+" "+e.Message); }
finally{ td.Close(false); } }
return log.ToString();
