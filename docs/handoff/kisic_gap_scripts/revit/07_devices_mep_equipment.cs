// KISIC step 07 – switches, DB, sockets, data, AC option A (indoor + roof), extract fans, basins, heaters, sanitisers (L3/L4/L5/L6). transactionMode "none", parameters ["dry"|"real"].
bool dry=(string)parameters[0]=="dry"; var log=new StringBuilder(); var fails=new List<string>(); int n=0;
var levels=new FilteredElementCollector(document).OfClass(typeof(Level)).Cast<Level>().ToDictionary(l=>l.Name);
Func<double,double,double,XYZ> P=(x,y,z)=>FmcScript.PointMm(x*1000,-y*1000,z);
FamilySymbol Sym(string fam,string type){ var s=new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().FirstOrDefault(f=>f.FamilyName==fam&&(type==null||f.Name==type)); if(s!=null&&!s.IsActive) s.Activate(); return s; }
var walls=new FilteredElementCollector(document).OfClass(typeof(Wall)).Cast<Wall>().Where(w=>(w.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).AsString()??"").StartsWith("W-")).ToDictionary(w=>w.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).AsString());
Reference FaceToward(string id,double x,double y,double zmm){ var w=walls[id]; var target=P(x,y,zmm);
 foreach(var side in new[]{ShellLayerType.Interior,ShellLayerType.Exterior}) foreach(var r in HostObjectUtils.GetSideFaces(w,side)){ var f=w.GetGeometryObjectFromReference(r) as PlanarFace; if(f==null) continue; if((target-f.Origin).DotProduct(f.FaceNormal)>0) return r; } return null; }
void W(string tag,string fam,string type,string wid,double along,double tx,double ty,double zmm,string circuit){
 try{ var s=Sym(fam,type); if(s==null){fails.Add(tag+": no "+fam+":"+type); return;}
  var w=walls[wid]; var c=((LocationCurve)w.Location).Curve; var p0=c.GetEndPoint(0); var dir=(c.GetEndPoint(1)-p0).Normalize();
  var r=FaceToward(wid,tx,ty,zmm); var f=(PlanarFace)w.GetGeometryObjectFromReference(r);
  var pt=p0+dir*FmcScript.Mm(along*1000); var q=new XYZ(pt.X,pt.Y,FmcScript.Mm(zmm)); q=q-f.FaceNormal*(q-f.Origin).DotProduct(f.FaceNormal);
  var fi=document.Create.NewFamilyInstance(r,q,XYZ.BasisZ.CrossProduct(f.FaceNormal).Normalize(),s);
  fi.get_Parameter(BuiltInParameter.ALL_MODEL_MARK).Set(tag); fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set(tag+(circuit!=""?" · circuit "+circuit:"")); n++; }
 catch(Exception ex){ fails.Add(tag+": "+ex.Message); } }
void Roof(string tag,string fam,string type,double x,double y,double rot){
 try{ var s=Sym(fam,type); if(s==null){fails.Add(tag+": no family");return;} var L1=levels["L00 Roof Slab"];
  var fi=document.Create.NewFamilyInstance(P(x,y,0),s,L1,Autodesk.Revit.DB.Structure.StructuralType.NonStructural);
  fi.get_Parameter(BuiltInParameter.INSTANCE_FREE_HOST_OFFSET_PARAM)?.Set(FmcScript.Mm(150+300));
  if(rot!=0) ElementTransformUtils.RotateElement(document,fi.Id,Line.CreateBound(P(x,y,0),P(x,y,1000)),rot*Math.PI/180);
  fi.get_Parameter(BuiltInParameter.ALL_MODEL_MARK).Set(tag); fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set(tag+" outdoor unit on 300 frame"); n++; }
 catch(Exception ex){ fails.Add(tag+": "+ex.Message); } }
string SW="FMC_E_ElecFixture_Switch_Light", SO="FMC_E_ElecFixture_Socket_13A_Twin", DO="M_Data Outlet";
using(var t=new Transaction(document,"KISIC 07 devices + MEP equipment")){
var fo=t.GetFailureHandlingOptions(); fo.SetFailuresPreprocessor(new FmcFailures()); t.SetFailureHandlingOptions(fo); t.Start();
try{
 W("SW-L1L4L6L7",SW,"4Gang","W-E-facade",5.72,8.0,5.0,1200,"P1"); W("SW-L2",SW,"FanRegulator","W-E-facade",5.86,8.0,5.0,1200,"P1"); W("SW-L3L8",SW,"2Gang","W-E-facade",5.98,8.0,5.0,1200,"P1");
 W("SW-L5L9",SW,"2Gang","W-LAB-E",2.08,6.0,5.5,1200,"P1");
 W("SW-V1V2",SW,"2Gang","W-S",8.65,8.6,6.0,1200,"P4");
 W("SW-X1X2",SW,"2Gang","W-XR-E",2.33,3.5,2.0,1200,"P2");
 W("SW-T1",SW,"1Gang","W-CTL-E",2.35,4.7,2.9,1200,"P2");
 W("SW-C1C2C3",SW,"3Gang","W-CTL-S",0.30,4.7,1.5,1200,"P2");
 W("SW-S1",SW,"Dimmer_1Gang","W-SCN-S",1.10,6.5,1.2,1200,"P2"); W("SW-S2",SW,"Dimmer_1Gang","W-SCN-S",1.20,6.5,1.2,1200,"P2"); W("SW-S3",SW,"Dimmer_1Gang","W-SCN-S",1.30,6.5,1.2,1200,"P2");
 W("SW-B1B2B3",SW,"3Gang","W-LAB-E",2.00,3.0,5.5,1200,"P3");
 W("DB-1","FMC_E_EQ_DB_Final_TPN",null,"W-LAB-E",0.60,6.0,4.5,1100,"main");
 W("S06-1",SO,null,"W-LAB-E",0.40,6.0,4.5,300,"P5"); W("S06-2",SO,null,"W-LAB-E",1.40,6.0,4.5,300,"P12");
 W("D06-1",DO,null,"W-LAB-E",0.55,6.0,4.5,300,"data"); W("D06-2",DO,null,"W-LAB-E",1.55,6.0,4.5,300,"data");
 W("S06-TV",SO,null,"W-S",4.75,6.0,5.0,2300,"P5"); W("D06-TV",DO,null,"W-S",5.10,6.0,5.0,2300,"data");
 W("S06-3",SO,null,"W-E-facade",6.22,8.5,6.0,300,"P5"); W("S06-4",SO,null,"W-SCN-S",1.10,7.0,4.0,300,"P5");
 W("S01-1",SO,null,"W-XR-S",3.90,3.0,3.0,300,"P5");
 W("S02-1",SO,null,"W-CTL-E",0.50,4.7,1.0,900,"P12"); W("S02-2",SO,null,"W-CTL-E",1.30,4.7,1.0,900,"P12"); W("D02-1",DO,null,"W-CTL-E",0.90,4.7,1.0,900,"data");
 W("S03-1",SO,null,"W-N",6.175,6.2,1.0,300,"P9"); W("D03-1",DO,null,"W-N",6.50,6.2,1.0,300,"data"); W("S03-2",SO,null,"W-SCN-S",1.60,6.5,1.5,300,"P5");
 W("S05-1",SO,null,"W-W",3.925,1.0,5.0,1100,"P6"); W("S05-2",SO,null,"W-W",4.925,1.0,5.0,1100,"P10");
 W("S05-3",SO,null,"W-XR-S",0.60,1.0,5.0,1100,"P6"); W("S05-4",SO,null,"W-XR-S",1.50,1.0,5.0,1100,"P6"); W("D05-1",DO,null,"W-XR-S",1.80,1.0,5.0,1100,"data");
 W("S05-F",SO,null,"W-XR-S",2.525,1.0,5.0,300,"P11");
 W("S07-1",SO,null,"W-S",4.375,4.3,7.5,600,"P7");
 string AC="FMC_M_MechEq_AC_Split_WallHigh";
 W("AC-1",AC,"5.3kW_18kBTU","W-W",1.825,2.0,1.7,2350,"P13"); W("AC-2",AC,"2.6kW_9kBTU","W-CTL-E",1.225,7.0,1.2,2350,"P14");
 W("AC-3",AC,"3.5kW_12kBTU","W-W",5.275,2.0,5.2,2350,"P15"); W("AC-4",AC,"7.0kW_24kBTU","W-SCN-S",2.225,7.0,4.0,2350,"P16");
 Roof("ACO-1","FMC_M_MechEq_AC_Split_Outdoor",null,0.8,1.8,90); Roof("ACO-2","FMC_M_MechEq_AC_Split_Outdoor",null,6.2,0.8,0);
 Roof("ACO-3","FMC_M_MechEq_AC_Split_Outdoor",null,0.8,5.2,90); Roof("ACO-4","FMC_M_MechEq_AC_Split_Outdoor",null,7.8,1.6,0);
 W("EF-SCAN","FMC_M_MechEq_ExtractFan_Wall","150_Wall","W-N",7.50,7.0,1.0,2700,"P2"); W("EF-LAB","FMC_M_MechEq_ExtractFan_Wall","150_Wall","W-W",6.20,1.0,6.0,2700,"P3");
 string BS="FMC_P_PlumbingFixture_Basin_ClinicalHandwash", WH="FMC_P_PlumbingEq_WaterHeater_Instant", SN="FMC_A_SpecEq_Dispenser_Sanitiser_Auto";
 W("HWB-1",BS,null,"W-N",3.625,3.5,1.0,850,"water"); W("WH-1",WH,null,"W-N",3.625,3.5,1.0,350,"P17");
 W("HWB-2",BS,null,"W-S",3.675,3.0,6.0,850,"water"); W("WH-2",WH,null,"W-S",3.675,3.0,6.0,350,"P17");
 W("HWB-3",BS,null,"W-CTL-E",1.80,6.5,1.5,850,"water"); W("WH-3",WH,null,"W-CTL-E",1.80,6.5,1.5,350,"P17");
 W("SAN-1",SN,null,"W-LAB-E",3.20,6.0,6.0,1200,""); W("SAN-2",SN,null,"W-CTL-E",2.40,6.0,3.0,1200,""); W("SAN-3",SN,null,"W-E-facade",2.90,8.0,3.5,1200,""); W("SAN-4",SN,null,"W-XR-E",2.33,4.7,2.5,1200,"");
 log.Append("placed "+n+(fails.Count>0?"; fails: "+string.Join(" | ",fails):""));
 if(dry){t.RollBack(); log.Insert(0,"DRY: ");} else log.Insert(0,"BUILT "+t.Commit()+": ");
}catch(Exception ex){ if(t.GetStatus()==TransactionStatus.Started) t.RollBack(); return "FAILED "+ex.GetType().Name+": "+ex.Message+" | "+log; }
}
return log.ToString();
