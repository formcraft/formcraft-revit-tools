// KISIC step 03b – ceilings per L2 (fmc_ceiling-checked designs). transactionMode "none", usings ["Autodesk.Revit.DB.Architecture"], parameters ["dry"|"real"].
// After the real run: fmc_material assign Ceilings rule "Gypsum 9" -> FMC_Paint_Plascon_VinylSilk; rule "Bamboo" -> FMC_Vernacular_Bamboo_Ceiling; Walls rule "Soffit" -> FMC_Paint_Plascon_VinylSilk.
bool dry=(string)parameters[0]=="dry"; var log=new StringBuilder();
var L0=new FilteredElementCollector(document).OfClass(typeof(Level)).Cast<Level>().First(l=>l.Name=="L00 FFL");
Func<double,double,XYZ> P=(x,y)=>FmcScript.PointMm(x*1000,-y*1000,0);
using(var t=new Transaction(document,"KISIC 03 ceilings")){
var fo=t.GetFailureHandlingOptions(); fo.SetFailuresPreprocessor(new FmcFailures()); t.SetFailureHandlingOptions(fo); t.Start();
try{
 var baseCt=new FilteredElementCollector(document).OfClass(typeof(CeilingType)).Cast<CeilingType>().First(c=>c.Name=="16mm GWB on Metal Stud");
 CeilingType CT(string n){ var c=new FilteredElementCollector(document).OfClass(typeof(CeilingType)).Cast<CeilingType>().FirstOrDefault(x=>x.Name==n); return c??(CeilingType)baseCt.Duplicate(n);}
 var ctFlat=CT("FMC Gypsum 9 on furring - flat"); var ctBulk=CT("FMC Gypsum 9 on furring - bulkhead"); var ctRaft=CT("FMC Gypsum 9 on furring - raft"); var ctBamboo=CT("FMC Bamboo soffit lining");
 var opt=new SpatialElementBoundaryOptions{SpatialElementBoundaryLocation=SpatialElementBoundaryLocation.Finish};
 CurveLoop RoomLoop(Room r){ var cl=new CurveLoop(); foreach(var bs in r.GetBoundarySegments(opt)[0]) cl.Append(bs.GetCurve()); return cl; }
 Ceiling C(IList<CurveLoop> loops, CeilingType ct, double hmm, string note){ var c=Ceiling.Create(document,loops,ct.Id,L0.Id); c.get_Parameter(BuiltInParameter.CEILING_HEIGHTABOVELEVEL_PARAM).Set(FmcScript.Mm(hmm)); c.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set(note); return c; }
 var rooms=new FilteredElementCollector(document).OfCategory(BuiltInCategory.OST_Rooms).Cast<Room>().ToDictionary(r=>r.Number);
 foreach(var n in new[]{"01","02","04","05","03"}){ C(new List<CurveLoop>{RoomLoop(rooms[n])},ctFlat,3000,"Ceiling "+n+" flat 3000"); log.Append(n+" flat; "); }
 double rx=5.45+1.8, ry=1.15;
 var raft=new CurveLoop(); var a=P(rx-1.0,ry-0.6); var b=P(rx+1.0,ry-0.6); var c2=P(rx+1.0,ry+0.6); var d=P(rx-1.0,ry+0.6);
 raft.Append(Line.CreateBound(a,b)); raft.Append(Line.CreateBound(b,c2)); raft.Append(Line.CreateBound(c2,d)); raft.Append(Line.CreateBound(d,a));
 C(new List<CurveLoop>{raft},ctRaft,2850,"Scan raft 2000x1200 at 2850, cove S3");
 var outer=RoomLoop(rooms["06"]);
 var inner=CurveLoop.CreateViaOffset(outer,FmcScript.Mm(600),XYZ.BasisZ);
 if(inner.GetExactLength()>outer.GetExactLength()) inner=CurveLoop.CreateViaOffset(outer,-FmcScript.Mm(600),XYZ.BasisZ);
 C(new List<CurveLoop>{outer,inner},ctBulk,2750,"Lobby bulkhead 600 wide at 2750");
 C(new List<CurveLoop>{inner},ctFlat,3050,"Lobby tray field 3050");
 var wtF=new FilteredElementCollector(document).OfClass(typeof(WallType)).Cast<WallType>().First(w=>w.Name.StartsWith("Soffit - 12mm GWB"));
 int nf=0; foreach(Curve cv in inner){ var w=Wall.Create(document,cv,wtF.Id,L0.Id,FmcScript.Mm(250),FmcScript.Mm(2750),false,false); w.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("Lobby tray fascia (cove lip)"); w.get_Parameter(BuiltInParameter.WALL_ATTR_ROOM_BOUNDING)?.Set(0); nf++; }
 var ver=new CurveLoop(); var v=new[]{new[]{-0.13,6.85},new[]{9.75,6.85},new[]{9.90,8.23},new[]{-0.13,8.23}}; for(int i=0;i<4;i++) ver.Append(Line.CreateBound(P(v[i][0],v[i][1]),P(v[(i+1)%4][0],v[(i+1)%4][1])));
 C(new List<CurveLoop>{ver},ctBamboo,2700,"Veranda bamboo soffit 2700");
 log.Append("06 tray + "+nf+" fascia; 03 raft; veranda soffit");
 if(dry){t.RollBack(); log.Insert(0,"DRY: ");} else log.Insert(0,"BUILT "+t.Commit()+": ");
}catch(Exception ex){ if(t.GetStatus()==TransactionStatus.Started) t.RollBack(); return "FAILED "+ex.GetType().Name+": "+ex.Message+" | "+log; }
}
return log.ToString();
