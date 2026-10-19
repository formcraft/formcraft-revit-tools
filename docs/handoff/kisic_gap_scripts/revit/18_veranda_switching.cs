// KISIC 18 - veranda strips (south + east) + IP65 recessed soffit lights + SIGN-1, reception feature-board wash,
// task lights (Control C3, Lab B3), re-host the Lab corner strip, layered switching (Switch ID on every fitting and plate).
var log=new StringBuilder(); var fails=new List<string>();
Func<double,double,double,XYZ> P=(x,y,z)=>FmcScript.PointMm(x*1000,-y*1000,z);
double M(double mm)=>FmcScript.Mm(mm);
FamilySymbol Sym(string fam,string type){ var s=new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().First(x=>x.FamilyName==fam&&x.Name==type); if(!s.IsActive) s.Activate(); return s; }
string Cm(Element e)=>e.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString()??"";
var fixtures=new FilteredElementCollector(document).OfCategory(BuiltInCategory.OST_LightingFixtures).WhereElementIsNotElementType().Cast<FamilyInstance>().ToList();
using(var t=new Transaction(document,"KISIC 18 veranda + layered switching")){ var fo=t.GetFailureHandlingOptions(); fo.SetFailuresPreprocessor(new FmcFailures()); t.SetFailureHandlingOptions(fo); t.Start();
try{
 var strip14=Sym("FMC_E_LightFixture_StripLED","14Wpm_24V_3000K"); var strip65=Sym("FMC_E_LightFixture_StripLED","10Wpm_24V_3000K_IP65");
 var dl150=Sym("FMC_E_LightFixture_Downlight_LED","150_Downlight"); var lin1200=Sym("FMC_E_LightFixture_Linear_LED","1200_18W_4000K");
 // wall side face nearest a probe point
 (Reference r,XYZ q) Face(Wall w,XYZ probe){ Reference best=null; XYZ bq=null; double bd=double.MaxValue;
  foreach(var side in new[]{ShellLayerType.Interior,ShellLayerType.Exterior}) foreach(var rf in HostObjectUtils.GetSideFaces(w,side)){ var f=w.GetGeometryObjectFromReference(rf) as PlanarFace; if(f==null) continue; var pr=f.Project(probe); if(pr==null) continue; if(pr.Distance<bd){bd=pr.Distance;best=rf;bq=pr.XYZPoint;} } return (best,bq); }
 FamilyInstance OnWall(long wallId,FamilySymbol s,XYZ probe,XYZ dir,double lenMm,string note,string sw){ var w=(Wall)document.GetElement(new ElementId(wallId)); var (rf,q)=Face(w,probe); if(rf==null){fails.Add(note);return null;}
  var fi=document.Create.NewFamilyInstance(rf,q,dir,s); if(lenMm>0) fi.LookupParameter("Length")?.Set(M(lenMm)); fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set(note); fi.LookupParameter("FMC Switch")?.Set(sw); return fi; }
 var ceil=new FilteredElementCollector(document).OfClass(typeof(Ceiling)).Cast<Ceiling>().ToList();
 FamilyInstance OnCeil(FamilySymbol s,double x,double y,XYZ dir,string note,string sw){ var pt=P(x,y,0); Reference best=null; double bz=double.MaxValue;
  foreach(var c in ceil) foreach(var rf in HostObjectUtils.GetBottomFaces(c)){ var f=c.GetGeometryObjectFromReference(rf) as PlanarFace; if(f==null) continue; var pr=f.Project(new XYZ(pt.X,pt.Y,f.Origin.Z)); if(pr==null||pr.Distance>M(1)) continue; if(f.Origin.Z<bz){bz=f.Origin.Z;best=rf;} }
  if(best==null){fails.Add(note+" no ceiling");return null;} var fi=document.Create.NewFamilyInstance(best,new XYZ(pt.X,pt.Y,bz),dir,s); fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set(note); fi.LookupParameter("FMC Switch")?.Set(sw); return fi; }
 var made=new List<FamilyInstance>();

 // 1 Veranda strip V1: south run exists (9650 on W-S outside face); add the east facade run (outside face, 2600), same switch as SIGN-1
 { var a=P(9.68,6.78,2600); var b=P(8.82,-0.08,2600); var d=(b-a).Normalize(); var w=(Wall)document.GetElement(new ElementId(1658757L));
   var len=FmcScript.ToMm(a.DistanceTo(b)); var probe=a+d*M(120)+new XYZ(M(300),0,0);
   var fi=OnWall(1658757,strip65,probe,d,len-200,"V1 veranda strip, east facade (entrance wedge) IP65 - same switch as SIGN-1","V1"); if(fi!=null) made.Add(fi); }
 foreach(var f in fixtures.Where(g=>Cm(g).StartsWith("V1"))){ f.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("V1 veranda strip, south (W-S outside face) IP65 - same switch as SIGN-1"); f.LookupParameter("FMC Switch")?.Set("V1"); }

 // 2 Veranda recessed IP65 downlights in the bamboo soffit (2700), centre line y 7.55, 1.5 m spacing
 var dl65=new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().FirstOrDefault(x=>x.FamilyName=="FMC_E_LightFixture_Downlight_LED"&&x.Name=="150_Downlight_IP65_3000K") ?? (FamilySymbol)dl150.Duplicate("150_Downlight_IP65_3000K");
 if(!dl65.IsActive) dl65.Activate(); dl65.get_Parameter(BuiltInParameter.ALL_MODEL_TYPE_COMMENTS)?.Set("Recessed LED downlight 150, 9 W, 3000 K, IP65 (outdoor soffit)");
 int i=0; foreach(var vx in new[]{0.60,2.10,3.60,5.10,6.60,8.10,9.50}){ i++; var fi=OnCeil(dl65,vx,7.55,XYZ.BasisX,"V2 veranda recessed IP65 downlight "+i,"V2"); if(fi!=null) made.Add(fi); }
 foreach(var f in fixtures.Where(g=>Cm(g).StartsWith("V2 wall"))) f.LookupParameter("FMC Switch")?.Set("V2");

 // 3 SIGN-1 3D illuminated business sign, placeholder on the canopy front edge (sits on the canopy slab top 2850)
 foreach(var old in new FilteredElementCollector(document).OfClass(typeof(DirectShape)).Where(e=>Cm(e).StartsWith("SIGN-1")).Select(e=>e.Id).ToList()) document.Delete(old);
 { var lp=new CurveLoop(); var c0=P(3.70,8.25,2850); var c1=P(6.10,8.25,2850); var c2=P(6.10,8.12,2850); var c3=P(3.70,8.12,2850);
   lp.Append(Line.CreateBound(c0,c1)); lp.Append(Line.CreateBound(c1,c2)); lp.Append(Line.CreateBound(c2,c3)); lp.Append(Line.CreateBound(c3,c0));
   var sol=GeometryCreationUtilities.CreateExtrusionGeometry(new List<CurveLoop>{lp},XYZ.BasisZ,M(600));
   var ds=DirectShape.CreateElement(document,new ElementId(BuiltInCategory.OST_GenericModel)); ds.SetShape(new GeometryObject[]{sol}); ds.Name="SIGN-1 3D illuminated sign";
   ds.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("SIGN-1 3D illuminated business sign 2400x600 on the canopy edge (placeholder: size, face and artwork TBC) - LED, switched with V1 via 3 A fused spur IP66");
   ds.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.Set("SIGN-1"); ds.LookupParameter("FMC Switch")?.Set("V1"); log.Append("sign "+ds.Id.Value+"; "); }

 // 4 Reception feature board (Mvule slat wall, x 4.23, y 3.70-5.60, top 2700): grazing wash strip above the slats
 { var fi=OnWall(1658764,strip14,P(4.30,3.75,2720),new XYZ(0,-1,0),1850,"L5 feature board wash strip above the Mvule slat wall (reception)","L5"); if(fi!=null) made.Add(fi); }

 // 5 Task: Control C3 linear over the console; Lab B3 linear under the wall units (underside 1450)
 { var fi=OnCeil(lin1200,5.00,0.75,new XYZ(0,-1,0),"C3 task linear over the control console","C3"); if(fi!=null) made.Add(fi); }
 var v3d=new FilteredElementCollector(document).OfClass(typeof(View3D)).Cast<View3D>().First(v=>!v.IsTemplate);
 foreach(var old in new FilteredElementCollector(document).OfClass(typeof(ReferencePlane)).Cast<ReferencePlane>().Where(r=>r.Name=="KISIC B3 under wall units 1450").Select(r=>r.Id).ToList()) document.Delete(old);
 var rp=document.Create.NewReferencePlane(P(1,5,1450),P(0,5,1450),new XYZ(0,1,0),v3d); if(rp.Normal.Z>0){ document.Delete(rp.Id); rp=document.Create.NewReferencePlane(P(0,5,1450),P(1,5,1450),new XYZ(0,1,0),v3d); }
 rp.Name="KISIC B3 under wall units 1450"; log.Append("rp normal "+rp.Normal.Z.ToString("0")+"; ");
 foreach(var (px,py,pd,pn) in new[]{(0.24,4.75,new XYZ(0,-1,0),"1 west run"),(0.24,5.95,new XYZ(0,-1,0),"2 west run"),(1.24,3.88,XYZ.BasisX,"3 north run")}){
  var fi=document.Create.NewFamilyInstance(rp.GetReference(),P(px,py,1450),pd,lin1200); fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("B3 under-cabinet task linear "+pn+" (fixed to the wall-unit underside)"); fi.LookupParameter("FMC Switch")?.Set("B3"); made.Add(fi); }

 // 6 Lab vertical corner strip had lost its host: rebuild on W-LAB-E west face
 foreach(var f in fixtures.Where(g=>Cm(g)=="Strip 05 vertical corner"&&g.Host==null).ToList()) document.Delete(f.Id);
 { var fi=OnWall(1658764,strip14,P(4.00,6.64,300),XYZ.BasisZ,2500,"Strip 05 vertical corner","B2"); if(fi!=null) made.Add(fi); }

 // 7 Switch ID on every existing fitting (layer = own switch)
 string Sw(string c){ if(c.StartsWith("L5 woven")||c.StartsWith("L1 fan")) return "L1"; if(c.StartsWith("L6")||c.StartsWith("L8")) return "L3"; if(c.StartsWith("Strip 06")) return "L4";
  if(c.StartsWith("X1")) return "X1"; if(c.StartsWith("Strip 01")) return "X2"; if(c.StartsWith("XW")) return "XR interlock"; if(c.StartsWith("C1")) return "C1"; if(c.StartsWith("Strip 02")) return "C2";
  if(c.StartsWith("T1")) return "T1"; if(c.StartsWith("Strip 04")) return "T2"; if(c.StartsWith("S1")) return "S1"; if(c.StartsWith("Strip 03")) return "S2"; if(c.StartsWith("B1")) return "B1"; if(c.StartsWith("Strip 05")) return "B2"; return null; }
 int ns=0; foreach(var f in fixtures){ if(!f.IsValidObject) continue; var s=Sw(Cm(f)); if(s!=null){ f.LookupParameter("FMC Switch")?.Set(s); ns++; } }
 log.Append("switch ids "+ns+"; new fittings "+made.Count+"; ");

 // 8 Switch plates
 var swt=new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().Where(x=>x.FamilyName=="FMC_E_ElecFixture_Switch_Light").ToDictionary(x=>x.Name);
 void Plate(long id,string type,string mark,string ids,string note){ var f=(FamilyInstance)document.GetElement(new ElementId(id)); if(type!=null&&f.Symbol.Name!=type){ if(!swt[type].IsActive) swt[type].Activate(); f.Symbol=swt[type]; }
  f.get_Parameter(BuiltInParameter.ALL_MODEL_MARK).Set(mark); f.LookupParameter("FMC Switch")?.Set(ids); f.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set(note); }
 Plate(1696553,"3Gang","SW-L1L3L4","L1/L3/L4","SW-L1L3L4 · entrance D08 · L1 general (counter pendant + fan light, 2-way) · L3 all spots · L4 wall strips · circuit P1");
 Plate(1696555,null,"SW-L2","L2","SW-L2 · fan speed regulator (fan motor only, separate from the fan light) · circuit P1");
 Plate(1696559,"2Gang","SW-L5L1","L5/L1","SW-L5L1 · reception · L5 feature board wash · L1 general (2-way with entrance) · circuit P1");
 Plate(1696561,"2Gang","SW-V1V2","V1/V2","SW-V1V2 · by D07 · V1 veranda strips south+east + SIGN-1 (photocell/timer optional) · V2 veranda recessed + wall lights · circuit P4 RCD 30 mA");
 Plate(1696563,"2Gang","SW-X1X2","X1/X2","SW-X1X2 · X-ray · X1 general panels · X2 wall strips · circuit P2 (XW warning light on the generator interlock, no switch)");
 Plate(1696565,"2Gang","SW-T1T2","T1/T2","SW-T1T2 · X-ray/Control lobby · T1 downlight · T2 wall strips · circuit P2");
 Plate(1696567,"3Gang","SW-C1C2C3","C1/C2/C3","SW-C1C2C3 · Control · C1 general · C2 wall strips · C3 console task linear · circuit P2");
 Plate(1696569,null,"SW-S1","S1","SW-S1 · Scan · S1 general panel, dimmer · circuit P2");
 Plate(1696571,null,"SW-S2","S2","SW-S2 · Scan · S2 wall strips, dimmer (task = examination lamp on the trolley, from a socket) · circuit P2");
 Plate(1696575,"3Gang","SW-B1B2B3","B1/B2/B3","SW-B1B2B3 · Lab · B1 general panels · B2 wall strips · B3 under-cabinet task · circuit P3");
 var l8=document.GetElement(new ElementId(1696557L)); if(l8!=null) document.Delete(l8.Id);

 // 9 Switching schedule (lighting fixtures grouped by Switch ID)
 var oldS=new FilteredElementCollector(document).OfClass(typeof(ViewSchedule)).Cast<ViewSchedule>().FirstOrDefault(v=>v.Name=="E-SCH-04 Lighting by switch"); if(oldS!=null) document.Delete(oldS.Id);
 var vs=ViewSchedule.CreateSchedule(document,new ElementId(BuiltInCategory.OST_LightingFixtures)); vs.Name="E-SCH-04 Lighting by switch"; var def=vs.Definition;
 SchedulableField SF(BuiltInParameter bip)=>def.GetSchedulableFields().First(f=>f.ParameterId==new ElementId(bip));
 var fSw=def.AddField(def.GetSchedulableFields().First(f=>f.GetName(document)=="FMC Switch")); fSw.ColumnHeading="Switch";
 var fFt=def.AddField(SF(BuiltInParameter.ELEM_FAMILY_AND_TYPE_PARAM)); fFt.ColumnHeading="Fitting";
 var fCt=def.AddField(def.GetSchedulableFields().First(f=>f.FieldType==ScheduleFieldType.Count)); fCt.ColumnHeading="No.";
 var lenF=def.GetSchedulableFields().FirstOrDefault(f=>f.GetName(document)=="Length"); if(lenF!=null){ var fl=def.AddField(lenF); fl.ColumnHeading="Strip m"; try{ fl.DisplayType=ScheduleFieldDisplayType.Totals; }catch{} }
 def.AddSortGroupField(new ScheduleSortGroupField(fSw.FieldId){ShowHeader=false}); def.AddSortGroupField(new ScheduleSortGroupField(fFt.FieldId)); def.IsItemized=false;
 log.Append("schedule "+vs.Id.Value+"; ");
 t.Commit();
 }catch(Exception e){ if(t.GetStatus()==TransactionStatus.Started) t.RollBack(); return "FAILED "+e.GetType().Name+" "+e.Message+" | "+log+" | "+string.Join(";",fails); } }
// report placed bounding boxes for checking
var sb=new StringBuilder(log.ToString()); sb.AppendLine(" fails: "+string.Join(";",fails));
foreach(var f in new FilteredElementCollector(document).OfCategory(BuiltInCategory.OST_LightingFixtures).WhereElementIsNotElementType().Cast<FamilyInstance>().Where(g=>{var c=Cm(g); return c.StartsWith("V1")||c.StartsWith("V2 veranda rec")||c.StartsWith("L5 feature")||c.StartsWith("C3")||c.StartsWith("B3")||c=="Strip 05 vertical corner";})){
 var b=f.get_BoundingBox(null); sb.AppendLine($"{Cm(f).Substring(0,Math.Min(30,Cm(f).Length))} host:{f.Host?.Name} x{FmcScript.ToMm(b.Min.X)/1000:0.00}..{FmcScript.ToMm(b.Max.X)/1000:0.00} y{-FmcScript.ToMm(b.Max.Y)/1000:0.00}..{-FmcScript.ToMm(b.Min.Y)/1000:0.00} z{FmcScript.ToMm(b.Min.Z):0}..{FmcScript.ToMm(b.Max.Z):0}"); }
return sb.ToString();
