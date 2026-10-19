// KISIC step 08 – 3D pipework: refrigerant (AC option A), condensate, cold water from the roof tank, waste to gullies; roof tank + gullies as DirectShapes. transactionMode "none", usings ["Autodesk.Revit.DB.Plumbing"], parameters ["dry"|"real"].
bool dry=(string)parameters[0]=="dry"; var log=new StringBuilder(); var fails=new List<string>(); int np=0, nel=0;
var L0=new FilteredElementCollector(document).OfClass(typeof(Level)).Cast<Level>().First(l=>l.Name=="L00 FFL");
Func<double,double,double,XYZ> P=(x,y,z)=>FmcScript.PointMm(x*1000,-y*1000,z);
var sys=new FilteredElementCollector(document).OfClass(typeof(PipingSystemType)).Cast<PipingSystemType>().ToDictionary(s=>s.Name);
var ptypes=new FilteredElementCollector(document).OfClass(typeof(PipeType)).Cast<PipeType>().ToList();
PipeType PT(string n)=>ptypes.FirstOrDefault(p=>p.Name==n)??ptypes.First();
void Route(string tag,string sysName,string typeName,double diaMm,double[][] pts){
 try{ var st=sys[sysName]; var pt=PT(typeName); Pipe prev=null;
  for(int i=0;i<pts.Length-1;i++){ var a=P(pts[i][0],pts[i][1],pts[i][2]); var b=P(pts[i+1][0],pts[i+1][1],pts[i+1][2]); if(a.DistanceTo(b)<FmcScript.Mm(5)) continue;
   var p=Pipe.Create(document,st.Id,pt.Id,L0.Id,a,b); p.get_Parameter(BuiltInParameter.RBS_PIPE_DIAMETER_PARAM).Set(FmcScript.Mm(diaMm)); p.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set(tag); np++;
   if(prev!=null){ try{ Connector c1=null,c2=null; foreach(Connector c in prev.ConnectorManager.Connectors) if(c.Origin.DistanceTo(a)<FmcScript.Mm(2)) c1=c; foreach(Connector c in p.ConnectorManager.Connectors) if(c.Origin.DistanceTo(a)<FmcScript.Mm(2)) c2=c;
     if(c1!=null&&c2!=null){ document.Create.NewElbowFitting(c1,c2); nel++; } }catch(Exception ex){ fails.Add(tag+" elbow "+i+": "+ex.Message.Split('\n')[0]); } }
   prev=p; } }
 catch(Exception ex){ fails.Add(tag+": "+ex.Message.Split('\n')[0]); } }
double[] Q(double x,double y,double z)=>new[]{x,y,z};
using(var t=new Transaction(document,"KISIC 08 pipework 3D")){ var fo=t.GetFailureHandlingOptions(); fo.SetFailuresPreprocessor(new FmcFailures()); t.SetFailureHandlingOptions(fo); t.Start();
try{
 string RF="Other", CW="Domestic Cold Water", SN="Sanitary";
 Route("REF AC-1 → ACO-1",RF,"Standard",16,new[]{Q(0.15,1.75,2700),Q(0.15,1.75,3700),Q(0.8,1.75,3700)});
 Route("REF AC-2 → ACO-2",RF,"Standard",16,new[]{Q(5.55,1.15,2700),Q(5.55,1.15,3700),Q(6.2,1.15,3700)});
 Route("REF AC-3 → ACO-3",RF,"Standard",16,new[]{Q(0.15,5.20,2700),Q(0.15,5.20,3700),Q(0.8,5.20,3700)});
 Route("REF AC-4 → ACO-4",RF,"Standard",16,new[]{Q(7.60,2.55,2700),Q(7.60,2.55,3700),Q(7.60,1.60,3700)});
 Route("COND AC-1 → G1",SN,"PVC - DWV",20,new[]{Q(0.15,1.75,2320),Q(-0.30,1.75,2320),Q(-0.30,1.75,150)});
 Route("COND AC-3 → G2",SN,"PVC - DWV",20,new[]{Q(0.15,5.20,2320),Q(-0.30,5.20,2320),Q(-0.30,5.20,150)});
 Route("COND AC-2 → G3",SN,"PVC - DWV",20,new[]{Q(5.55,1.15,2320),Q(5.55,-0.30,2320),Q(5.55,-0.30,150)});
 Route("COND AC-4 → G4",SN,"PVC - DWV",20,new[]{Q(7.60,2.55,2320),Q(7.60,2.55,2900),Q(9.45,2.55,2900),Q(9.45,2.55,150)});
 Route("CW main tank → void",CW,"Standard",25,new[]{Q(4.70,1.20,4300),Q(4.70,1.20,3200),Q(4.70,6.55,3200),Q(0.30,6.55,3200),Q(0.30,5.90,3200),Q(0.30,5.90,950)});
 Route("CW → HWB-1",CW,"Standard",20,new[]{Q(4.70,1.20,3200),Q(3.55,1.20,3200),Q(3.55,0.15,3200),Q(3.55,0.15,700)});
 Route("CW → HWB-3",CW,"Standard",20,new[]{Q(4.70,1.20,3200),Q(5.55,1.20,3200),Q(5.55,1.725,3200),Q(5.55,1.725,700)});
 Route("CW → HWB-2",CW,"Standard",20,new[]{Q(3.60,6.55,3200),Q(3.60,6.55,700)});
 Route("W HWB-1 → G1b",SN,"PVC - DWV",40,new[]{Q(3.55,0.15,600),Q(3.55,-0.30,600),Q(3.55,-0.30,150)});
 Route("W HWB-3 → G3",SN,"PVC - DWV",40,new[]{Q(5.55,1.725,600),Q(5.55,-0.30,600),Q(5.55,-0.30,150)});
 Route("W HWB-2 → G5",SN,"PVC - DWV",40,new[]{Q(3.60,6.60,600),Q(3.60,7.00,600),Q(3.60,7.00,-250),Q(3.60,8.35,-250)});
 Route("W lab sink → G2",SN,"PVC - DWV",50,new[]{Q(0.30,5.90,600),Q(-0.30,5.90,600),Q(-0.30,5.90,150)});
 Material Mt(string n,Color c){ var m=new FilteredElementCollector(document).OfClass(typeof(Material)).Cast<Material>().FirstOrDefault(x=>x.Name==n); if(m==null){ m=(Material)document.GetElement(Material.Create(document,n)); m.Color=c;} return m; }
 var tankM=Mt("FMC_Plastic_WaterTank_Black",new Color(30,30,30)); var conc=Mt("FMC_Concrete_C20",new Color(184,182,174));
 var circ=new CurveLoop(); var cen=P(4.70,1.20,4400); circ.Append(Arc.Create(cen,FmcScript.Mm(600),0,Math.PI,XYZ.BasisX,XYZ.BasisY)); circ.Append(Arc.Create(cen,FmcScript.Mm(600),Math.PI,2*Math.PI,XYZ.BasisX,XYZ.BasisY));
 var tank=GeometryCreationUtilities.CreateExtrusionGeometry(new List<CurveLoop>{circ},XYZ.BasisZ,FmcScript.Mm(1500),new SolidOptions(tankM.Id,ElementId.InvalidElementId));
 var stand=new CurveLoop(); var s0=new[]{P(4.05,0.55,3550),P(5.35,0.55,3550),P(5.35,1.85,3550),P(4.05,1.85,3550)}; for(int i=0;i<4;i++) stand.Append(Line.CreateBound(s0[i],s0[(i+1)%4]));
 var st=GeometryCreationUtilities.CreateExtrusionGeometry(new List<CurveLoop>{stand},XYZ.BasisZ,FmcScript.Mm(850),new SolidOptions(conc.Id,ElementId.InvalidElementId));
 var dsT=DirectShape.CreateElement(document,new ElementId(BuiltInCategory.OST_PlumbingEquipment)); dsT.SetShape(new List<GeometryObject>{tank,st}); dsT.Name="Roof tank 1500 L on stand (structural check)"; dsT.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.Set("TANK-1");
 foreach(var g in new (string n,double x,double y)[]{("G1",-0.30,1.75),("G2",-0.30,5.55),("G3",5.55,-0.30),("G4",9.45,2.55),("G5",3.60,8.35),("G1b",3.55,-0.30)}){
  var lp=new CurveLoop(); var c0=new[]{P(g.x-0.15,g.y-0.15,-300),P(g.x+0.15,g.y-0.15,-300),P(g.x+0.15,g.y+0.15,-300),P(g.x-0.15,g.y+0.15,-300)}; for(int i=0;i<4;i++) lp.Append(Line.CreateBound(c0[i],c0[(i+1)%4]));
  var sg=GeometryCreationUtilities.CreateExtrusionGeometry(new List<CurveLoop>{lp},XYZ.BasisZ,FmcScript.Mm(300),new SolidOptions(conc.Id,ElementId.InvalidElementId));
  var dg=DirectShape.CreateElement(document,new ElementId(BuiltInCategory.OST_PlumbingFixtures)); dg.SetShape(new List<GeometryObject>{sg}); dg.Name="Gully "+g.n; dg.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.Set(g.n); }
 log.Append("pipes "+np+", elbows "+nel+(fails.Count>0?"; fails "+string.Join(" | ",fails.Take(8)):""));
 if(dry){t.RollBack(); log.Insert(0,"DRY: ");} else log.Insert(0,"BUILT "+t.Commit()+": ");
}catch(Exception ex){ if(t.GetStatus()==TransactionStatus.Started) t.RollBack(); return "FAILED "+ex.GetType().Name+": "+ex.Message+" | "+log; }
}
return log.ToString();
