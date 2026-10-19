// KISIC step 05 – furniture, joinery, wall features (L7). transactionMode "none", usings ["Autodesk.Revit.DB.Architecture"], parameters ["dry"|"real"].
bool dry=(string)parameters[0]=="dry"; var log=new StringBuilder(); var miss=new List<string>();
var L0=new FilteredElementCollector(document).OfClass(typeof(Level)).Cast<Level>().First(l=>l.Name=="L00 FFL");
Func<double,double,double,XYZ> P=(x,y,z)=>FmcScript.PointMm(x*1000,-y*1000,z);
FamilySymbol Sym(string fam,string type){ var s=new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().FirstOrDefault(f=>f.FamilyName==fam&&(type==null||f.Name==type)); if(s==null){miss.Add(fam+":"+type); return null;} if(!s.IsActive) s.Activate(); return s; }
var walls=new FilteredElementCollector(document).OfClass(typeof(Wall)).Cast<Wall>().Where(w=>(w.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).AsString()??"").StartsWith("W-")).ToDictionary(w=>w.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).AsString());
// face of wall `id` that faces point (x,y) (brief metres)
Reference FaceToward(string id,double x,double y,double zmm){ var w=walls[id]; var target=P(x,y,zmm);
 foreach(var side in new[]{ShellLayerType.Interior,ShellLayerType.Exterior}) foreach(var r in HostObjectUtils.GetSideFaces(w,side)){ var f=w.GetGeometryObjectFromReference(r) as PlanarFace; if(f==null) continue; if((target-f.Origin).DotProduct(f.FaceNormal)>0) return r; } return null; }
// point on wall `id` centreline at `along` m from its start, projected to the face toward (x,y), at height zmm
XYZ OnFace(string id,double along,double x,double y,double zmm){ var w=walls[id]; var c=((LocationCurve)w.Location).Curve; var p0=c.GetEndPoint(0); var dir=(c.GetEndPoint(1)-p0).Normalize();
 var pt=p0+dir*FmcScript.Mm(along*1000); var r=FaceToward(id,x,y,zmm); var f=(PlanarFace)w.GetGeometryObjectFromReference(r); var q=new XYZ(pt.X,pt.Y,FmcScript.Mm(zmm)); return q-f.FaceNormal*(q-f.Origin).DotProduct(f.FaceNormal); }
XYZ WallDir(string id){ var c=((LocationCurve)walls[id].Location).Curve; return (c.GetEndPoint(1)-c.GetEndPoint(0)).Normalize(); }
FamilyInstance Floor(string fam,string type,double x,double y,double rotDeg,string note){ var s=Sym(fam,type); if(s==null) return null;
 var fi=document.Create.NewFamilyInstance(P(x,y,0),s,L0,Autodesk.Revit.DB.Structure.StructuralType.NonStructural);
 if(Math.Abs(rotDeg)>0.01) ElementTransformUtils.RotateElement(document,fi.Id,Line.CreateBound(P(x,y,0),P(x,y,1000)),rotDeg*Math.PI/180);
 fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set(note); return fi; }
FamilyInstance OnWall(string fam,string type,string wid,double along,double towardX,double towardY,double zmm,string note,bool vertical=false){ var s=Sym(fam,type); if(s==null) return null;
 var r=FaceToward(wid,towardX,towardY,zmm); var pt=OnFace(wid,along,towardX,towardY,zmm);
 var nrm=((PlanarFace)walls[wid].GetGeometryObjectFromReference(r)).FaceNormal; var fi=document.Create.NewFamilyInstance(r,pt,vertical?XYZ.BasisZ:XYZ.BasisZ.CrossProduct(nrm).Normalize(),s); fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set(note); return fi; }
void SetL(FamilyInstance fi,string p,double mm){ var q=fi?.LookupParameter(p); if(q!=null&&!q.IsReadOnly) q.Set(FmcScript.Mm(mm)); }
using(var t=new Transaction(document,"KISIC 05 furniture")){
var fo=t.GetFailureHandlingOptions(); fo.SetFailuresPreprocessor(new FmcFailures()); t.SetFailureHandlingOptions(fo); t.Start();
try{
 int n=0;
 // Waiting / Reception (06)
 // desk: family origin at Desk Left / Desk Back (0,0); front at -650 (Revit -Y = brief +y). Rotate so the slat front faces east (+x): front (-Y local) -> +X world => rotate +90.
 var desk=Floor("FMC_I_Casework_ReceptionDesk","1750x650_Mvule",5.00,5.50,90,"Reception desk"); if(desk!=null) n++;
 var slat=OnWall("FMC_I_Furniture_WallPanel_Slat",null,"W-LAB-E",2.025,6.0,4.5,0,"Mvule slat feature wall"); SetL(slat,"Panel Width",1900); SetL(slat,"Panel Height",2700); if(slat!=null){ var sc=slat.LookupParameter("Slat Count"); if(sc!=null&&!sc.IsReadOnly) sc.Set(31); n++; }
 var s3=Floor("FMC_I_Furniture_Sofa","2200x0850_3Seat",7.60,2.895,0,"3-seater, back to terracotta wall"); if(s3!=null) n++;
 var s2=Floor("FMC_I_Furniture_Sofa","1600x0850_2Seat",8.50,6.275,180,"2-seater, back to W-S"); if(s2!=null) n++;
 foreach(var a in new[]{0.95,2.05}){ var bc=OnWall("FMC_I_Furniture_WallPanel_BarkCloth","1200x0900","W-SCN-S",a+0.675,7.0,4.0,1550,"Bark-cloth art panel"); if(bc!=null) n++; }
 foreach(var p in new[]{new[]{6.15,2.95},new[]{7.35,6.30},new[]{9.05,4.70}}){ if(Floor("FMC_I_Furniture_Stool","380x450_Drum",p[0],p[1],0,"Drum stool / side table")!=null) n++; }
 if(Floor("FMC_I_Furniture_Planter","0600_Round_Palm",8.80,3.65,0,"Areca palm")!=null) n++;
 if(Floor("FMC_I_Furniture_Planter","0600_Round_Palm",4.60,6.30,0,"Areca palm by lab door")!=null) n++;
 if(Floor("FMC_I_Furniture_Planter","0400_Round",9.25,5.55,0,"Snake plant")!=null) n++;
 if(OnWall("FMC_E_ICT_TV_WallArm","43in_FlexArm","W-S",4.99,6.0,5.0,2450,"TV on flexible arm")!=null) n++;
 // Scan (03)
 if(Floor("FMC_I_MedEq_Couch_Examination",null,7.675,0.50,180,"Exam couch, head west")!=null) n++;
 if(Floor("FMC_I_Furniture_Chair_Patient_Arm",null,8.30,1.70,180,"Companion chair")!=null) n++;
 // X-ray (01)
 if(Floor("FMC_I_Furniture_Chair_Patient_Arm",null,3.40,3.00,90,"Patient chair")!=null) n++;
 // Veranda benches (on the veranda floor, against W-S south face; local back at y=0 -> rotate 180 so the seat faces south)
 foreach(var b in new[]{new[]{-0.075,0.95},new[]{3.25,5.35},new[]{8.50,9.60}}){ var bi=Floor("FMC_I_Furniture_Bench_Veranda",null,b[0],6.85,0,"Veranda bench"); SetL(bi,"Bench Length",(b[1]-b[0])*1000); if(bi!=null) n++; }
 foreach(var x in new[]{0.5,2.6,4.7,6.8,8.9}){ if(Floor("FMC_I_Furniture_Planter","0600_Round_Palm",x,7.95,0,"Veranda planter")!=null) n++; }
 log.Append("placed "+n+(miss.Count>0?"; missing "+string.Join(", ",miss.Distinct()):""));
 if(dry){t.RollBack(); log.Insert(0,"DRY: ");} else log.Insert(0,"BUILT "+t.Commit()+": ");
}catch(Exception ex){ if(t.GetStatus()==TransactionStatus.Started) t.RollBack(); return "FAILED "+ex.GetType().Name+": "+ex.Message+" | "+log; }
}
return log.ToString();
