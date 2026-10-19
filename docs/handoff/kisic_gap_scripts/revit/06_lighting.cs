// KISIC step 06 – lighting (L3): ceiling fittings, strips, pendants, wall lights, warning light. transactionMode "none", usings ["Autodesk.Revit.DB.Architecture"], parameters ["dry"|"real"].
bool dry=(string)parameters[0]=="dry"; var log=new StringBuilder(); var miss=new List<string>(); var fails=new List<string>();
var L0=new FilteredElementCollector(document).OfClass(typeof(Level)).Cast<Level>().First(l=>l.Name=="L00 FFL");
Func<double,double,double,XYZ> P=(x,y,z)=>FmcScript.PointMm(x*1000,-y*1000,z);
FamilySymbol Sym(string fam,string type){ var s=new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().FirstOrDefault(f=>f.FamilyName==fam&&(type==null||f.Name==type)); if(s==null){miss.Add(fam+":"+type); return null;} if(!s.IsActive) s.Activate(); return s; }
var ceilings=new FilteredElementCollector(document).OfClass(typeof(Ceiling)).Cast<Ceiling>().ToList();
// bottom face of the ceiling directly above (x,y)
Reference CeilingFaceAbove(double x,double y,out double zmm){ zmm=0; Reference best=null; double bestZ=double.MaxValue; var pt=P(x,y,0);
 foreach(var c in ceilings) foreach(var r in HostObjectUtils.GetBottomFaces(c)){ var f=c.GetGeometryObjectFromReference(r) as PlanarFace; if(f==null) continue; var pr=f.Project(new XYZ(pt.X,pt.Y,f.Origin.Z)); if(pr==null||pr.Distance>FmcScript.Mm(1)) continue; if(f.Origin.Z<bestZ){bestZ=f.Origin.Z; best=r;} }
 zmm=FmcScript.ToMm(bestZ); return best; }
FamilyInstance OnCeiling(string fam,string type,double x,double y,string note){ var s=Sym(fam,type); if(s==null) return null; double z; var r=CeilingFaceAbove(x,y,out z); if(r==null){fails.Add(note+" no ceiling"); return null;}
 var fi=document.Create.NewFamilyInstance(r,P(x,y,z),XYZ.BasisX,s); fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set(note); return fi; }
var walls=new FilteredElementCollector(document).OfClass(typeof(Wall)).Cast<Wall>().Where(w=>(w.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).AsString()??"").StartsWith("W-")).ToDictionary(w=>w.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).AsString());
Reference FaceAt(Wall w, XYZ p){ foreach(var side in new[]{ShellLayerType.Interior,ShellLayerType.Exterior}) foreach(var r in HostObjectUtils.GetSideFaces(w,side)){ var f=w.GetGeometryObjectFromReference(r) as PlanarFace; if(f==null) continue; var pr=f.Project(p); if(pr!=null && pr.Distance<FmcScript.Mm(2)) return r;} return null; }
Reference FaceToward(string id,double x,double y,double zmm){ var w=walls[id]; var target=P(x,y,zmm);
 foreach(var side in new[]{ShellLayerType.Interior,ShellLayerType.Exterior}) foreach(var r in HostObjectUtils.GetSideFaces(w,side)){ var f=w.GetGeometryObjectFromReference(r) as PlanarFace; if(f==null) continue; if((target-f.Origin).DotProduct(f.FaceNormal)>0) return r; } return null; }
XYZ OnFace(string id,double along,double x,double y,double zmm){ var w=walls[id]; var c=((LocationCurve)w.Location).Curve; var p0=c.GetEndPoint(0); var dir=(c.GetEndPoint(1)-p0).Normalize();
 var pt=p0+dir*FmcScript.Mm(along*1000); var f=(PlanarFace)w.GetGeometryObjectFromReference(FaceToward(id,x,y,zmm)); var q=new XYZ(pt.X,pt.Y,FmcScript.Mm(zmm)); return q-f.FaceNormal*(q-f.Origin).DotProduct(f.FaceNormal); }
using(var t=new Transaction(document,"KISIC 06 lighting")){
var fo=t.GetFailureHandlingOptions(); fo.SetFailuresPreprocessor(new FmcFailures()); t.SetFailureHandlingOptions(fo); t.Start();
try{
 int n=0; string DL="FMC_E_LightFixture_Downlight_LED", PN="FMC_E_LightFixture_Panel_LED";
 string dl150=new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().Where(s=>s.FamilyName==DL).Select(s=>s.Name).FirstOrDefault(s=>s.StartsWith("150"));
 string dl200=new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().Where(s=>s.FamilyName==DL).Select(s=>s.Name).FirstOrDefault(s=>s.StartsWith("200"));
 // room 06 frame origin: NW inside corner of Waiting = (5.45, 2.45) (brief m); room frame mm -> brief m
 Func<double,double,double[]> R6=(xm,ym)=>new[]{4.225+xm/1000.0,2.45+ym/1000.0};
 void C6(string fam,string type,double xm,double ym,string note){ var p=R6(xm,ym); if(OnCeiling(fam,type,p[0],p[1],note)!=null) n++; }
 foreach(var p in new double[][]{new double[]{575.0,3950},new double[]{1575,3950},new double[]{2575,3950}}) C6(DL,dl150,p[0],p[1],"L6 spot along south wall");
 foreach(var p in new double[][]{new double[]{3830.0,3950},new double[]{4480,3950}}) C6(DL,dl150,p[0],p[1],"L3 spot over 2-seater");
 foreach(var p in new double[][]{new double[]{1525.0,300},new double[]{1525,800}}) C6(DL,dl150,p[0],p[1],"L7 downlight at D04");
 foreach(var p in new double[][]{new double[]{1050.0,1900},new double[]{1050,2700}}) C6("FMC_E_LightFixture_Pendant_Woven",null,p[0],p[1],"L5 woven pendant over reception");
 foreach(var p in new double[][]{new double[]{2700.0,500},new double[]{3700,500}}) C6("FMC_E_LightFixture_Pendant_Woven",null,p[0],p[1],"L8 woven pendant over 3-seater");
 { var p=R6(2475,2125); var s=Sym("FMC_M_MechEq_CeilingFan",null); double z; var r=CeilingFaceAbove(p[0],p[1],out z); if(s!=null&&r!=null){ var fi=document.Create.NewFamilyInstance(r,P(p[0],p[1],z),XYZ.BasisX,s); fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("L1/L2 ceiling fan (light kit: kit request)"); n++; } }
 // X-ray panels (room 01 frame origin (0,0))
 foreach(var x in new[]{1.0,2.0,3.0}) if(OnCeiling(PN,"600x600_36W_4000K",x,1.75,"X1 panel")!=null) n++;
 // Control downlight, vestibule
 if(OnCeiling(DL,dl200,4.70,1.10,"C1 downlight")!=null) n++;
 if(OnCeiling(DL,dl150,4.725,2.925,"T1 downlight vestibule")!=null) n++;
 // Scan downlights (room frame origin (5.45,0))
 foreach(var p in new double[][]{new double[]{850.0,800},new double[]{2150,800},new double[]{850,1600},new double[]{2150,1600}}) if(OnCeiling(DL,dl150,5.45+p[0]/1000,p[1]/1000,"S1 downlight (dimmer)")!=null) n++;
 // Lab panels (room frame origin (0,3.65))
 foreach(var p in new double[][]{new double[]{1000.0,1000},new double[]{3000,1000},new double[]{1000,2100},new double[]{3000,2100}}) if(OnCeiling(PN,"600x600_36W_4000K",p[0]/1000,3.65+p[1]/1000,"B1 panel")!=null) n++;
 // Strips: horizontal round every room at 2850 (lobby: at 2700 under the bulkhead lip? -> on walls at 2700), vertical corner run per room
 var sIn=Sym("FMC_E_LightFixture_StripLED","14Wpm_24V_3000K"); var sOut=Sym("FMC_E_LightFixture_StripLED","10Wpm_24V_3000K_IP65");
 var opt=new SpatialElementBoundaryOptions{SpatialElementBoundaryLocation=SpatialElementBoundaryLocation.Finish};
 var vertSeg=new Dictionary<string,int>{{"01",2},{"02",0},{"03",1},{"05",2},{"06",1}};
 var stripZ=new Dictionary<string,double>{{"06",2650}}; double inset=FmcScript.Mm(30); int ns=0;
 foreach(Room r in new FilteredElementCollector(document).OfCategory(BuiltInCategory.OST_Rooms)){
  double zz=FmcScript.Mm(stripZ.ContainsKey(r.Number)?stripZ[r.Number]:2850);
  var segs=r.GetBoundarySegments(opt)[0]; int k=-1;
  foreach(var bs in segs){ k++; var w=document.GetElement(bs.ElementId) as Wall; var c=bs.GetCurve(); if(w==null||c.Length<FmcScript.Mm(300)) continue;
   var a=c.GetEndPoint(0); var b=c.GetEndPoint(1); var dir=(b-a).Normalize(); var mid=(new XYZ(a.X,a.Y,zz)+new XYZ(b.X,b.Y,zz))/2;
   var fr=FaceAt(w,mid); if(fr==null){fails.Add("strip "+r.Number+" seg"+k); continue;}
   var fi=document.Create.NewFamilyInstance(fr,new XYZ(a.X,a.Y,zz)+dir*inset,dir,sIn); fi.LookupParameter("Length").Set(c.Length-2*inset); fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("Strip "+r.Number+" horizontal"); ns++;
   if(vertSeg.ContainsKey(r.Number)&&vertSeg[r.Number]==k){ var vf=document.Create.NewFamilyInstance(fr,new XYZ(a.X,a.Y,FmcScript.Mm(300))+dir*inset,XYZ.BasisZ,sIn); vf.LookupParameter("Length").Set(zz-FmcScript.Mm(350)); vf.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("Strip "+r.Number+" vertical corner"); ns++; } } }
 // Scan raft cove: strips on the raft's top face edge are not hostable on a ceiling top easily -> place along raft perimeter on the raft underside edge? use the raft bottom face, 30 mm in from the edge, facing up is not possible; place on raft bottom face as a halo
 { double rx=5.45+1.8, ry=1.15; double z; var rr=CeilingFaceAbove(rx,ry,out z); if(rr!=null){ var pts=new[]{new[]{rx-0.97,ry-0.57},new[]{rx+0.97,ry-0.57},new[]{rx+0.97,ry+0.57},new[]{rx-0.97,ry+0.57}};
   for(int i=0;i<4;i++){ var a=P(pts[i][0],pts[i][1],z); var b=P(pts[(i+1)%4][0],pts[(i+1)%4][1],z); var fi=document.Create.NewFamilyInstance(rr,a,(b-a).Normalize(),sIn); fi.LookupParameter("Length").Set(a.DistanceTo(b)); fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("S3 raft halo strip"); ns++; } } }
 // Veranda strip V1 on W-S south face at 2600
 { var w=walls["W-S"]; var fr=FaceAt(w,P(4.8,6.85,2600)); if(fr!=null){ var fi=document.Create.NewFamilyInstance(fr,P(-0.07,6.85,2600),XYZ.BasisX,sOut); fi.LookupParameter("Length").Set(FmcScript.Mm(9650)); fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("V1 veranda strip"); ns++; } else fails.Add("V1"); }
 n+=ns;
 // Veranda wall lights V2
 var wl=Sym("FMC_E_LightFixture_WallLight",null); if(wl!=null) foreach(var al in new[]{0.675,4.675,9.075}){ var fr=FaceToward("W-S",4.8,7.5,2200); var fi=document.Create.NewFamilyInstance(fr,OnFace("W-S",al,4.8,7.5,2200),XYZ.BasisX,wl); fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("V2 wall light"); n++; }
 // X-ray warning light over D01 on the vestibule side (W-XR-E east face) at 2300
 var xw=Sym("FMC_E_LightFixture_Xray_Warning",null); if(xw!=null){ var fr=FaceToward("W-XR-E",4.7,2.9,2300); var fi=document.Create.NewFamilyInstance(fr,OnFace("W-XR-E",3.005,4.7,2.9,2300),XYZ.BasisY.Negate(),xw); fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("XW X-ray in-use light"); n++; }
 log.Append("placed "+n+" (strips "+ns+")"+(miss.Count>0?"; missing "+string.Join(", ",miss.Distinct()):"")+(fails.Count>0?"; fails "+string.Join(", ",fails):""));
 if(dry){t.RollBack(); log.Insert(0,"DRY: ");} else log.Insert(0,"BUILT "+t.Commit()+": ");
}catch(Exception ex){ if(t.GetStatus()==TransactionStatus.Started) t.RollBack(); return "FAILED "+ex.GetType().Name+": "+ex.Message+" | "+log; }
}
return log.ToString();
