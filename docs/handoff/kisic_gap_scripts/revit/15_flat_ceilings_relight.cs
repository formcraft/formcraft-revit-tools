bool dry=(string)parameters[0]=="dry"; var log=new StringBuilder(); var fails=new List<string>();
Func<double,double,double,XYZ> P=(x,y,z)=>FmcScript.PointMm(x*1000,-y*1000,z);
var L0=new FilteredElementCollector(document).OfClass(typeof(Level)).Cast<Level>().First(l=>l.Name=="L00 FFL");
using(var t=new Transaction(document,"KISIC 15 flat ceilings + relight lobby/scan")){ var fo=t.GetFailureHandlingOptions(); fo.SetFailuresPreprocessor(new FmcFailures()); t.SetFailureHandlingOptions(fo); t.Start();
try{
 var ceil=new FilteredElementCollector(document).OfClass(typeof(Ceiling)).Cast<Ceiling>().ToList();
 var flatType=ceil.First(c=>c.Name.Contains("flat")).GetTypeId();
 var kill=ceil.Where(c=>c.Name.Contains("bulkhead")||c.Name.Contains("raft")||(c.Name.Contains("flat")&&FmcScript.ToMm(c.get_BoundingBox(null).Min.Z)>3020)).Select(c=>c.Id).ToList();
 kill.AddRange(new FilteredElementCollector(document).OfClass(typeof(Wall)).Cast<Wall>().Where(w=>(w.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString()??"").ToLower().Contains("fascia")).Select(w=>w.Id));
 var hs=new HashSet<long>(kill.Select(i=>i.Value));
 // remember what hangs on them (except coves / raft items / scan downlights)
 var keep=new List<(ElementId sym,double x,double y,string note)>();
 foreach(var f in new FilteredElementCollector(document).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>().Where(f=>f.Host!=null&&hs.Contains(f.Host.Id.Value))){
  var c=f.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString()??""; if(c.StartsWith("L4 tray")||c.StartsWith("S3 raft")||c.StartsWith("S1 downlight")) continue;
  var p=((LocationPoint)f.Location).Point; keep.Add((f.Symbol.Id,FmcScript.ToMm(p.X)/1000,-FmcScript.ToMm(p.Y)/1000,c)); }
 document.Delete(kill); log.Append("removed ceilings/fascias "+kill.Count+", re-hang "+keep.Count+"; ");
 // lobby flat ceiling at 3000 on the room's finish boundary
 var room=new FilteredElementCollector(document).OfCategory(BuiltInCategory.OST_Rooms).Cast<SpatialElement>().First(r=>r.Name.StartsWith("Waiting"));
 var loop=new CurveLoop(); foreach(var s in room.GetBoundarySegments(new SpatialElementBoundaryOptions{SpatialElementBoundaryLocation=SpatialElementBoundaryLocation.Finish})[0]) loop.Append(s.GetCurve());
 var nc=Ceiling.Create(document,new List<CurveLoop>{loop},flatType,L0.Id); nc.get_Parameter(BuiltInParameter.CEILING_HEIGHTABOVELEVEL_PARAM).Set(FmcScript.Mm(3000));
 nc.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.Set("Lobby flat board ceiling 3000"); document.Regenerate();
 ceil=new FilteredElementCollector(document).OfClass(typeof(Ceiling)).Cast<Ceiling>().ToList();
 Reference Below(double x,double y,out double zmm){ zmm=0; Reference best=null; double bz=double.MaxValue; var pt=P(x,y,0);
  foreach(var c in ceil) foreach(var r in HostObjectUtils.GetBottomFaces(c)){ var f=c.GetGeometryObjectFromReference(r) as PlanarFace; if(f==null) continue; var pr=f.Project(new XYZ(pt.X,pt.Y,f.Origin.Z)); if(pr==null||pr.Distance>FmcScript.Mm(1)) continue; if(f.Origin.Z<bz){bz=f.Origin.Z;best=r;} } zmm=FmcScript.ToMm(bz); return best; }
 int n=0; FamilyInstance OnC(FamilySymbol s,double x,double y,string note){ double z; var r=Below(x,y,out z); if(r==null){fails.Add(note+" no ceiling");return null;} if(!s.IsActive) s.Activate(); var fi=document.Create.NewFamilyInstance(r,P(x,y,z),XYZ.BasisX,s); fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set(note); n++; return fi; }
 foreach(var k in keep) OnC((FamilySymbol)document.GetElement(k.sym),k.x,k.y,k.note);
 // Scan: one general light (panel 3000 K, dimmer) in the centre
 var pan=new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().First(s=>s.FamilyName=="FMC_E_LightFixture_Panel_LED"&&s.Name=="600x600_36W_3000K");
 OnC(pan,7.245,1.15,"S1 general panel 3000 K (dimmer)");
 // strips: Scan keeps the north + west walls (+ the NW vertical run); lobby gets wall strips at 2850 again
 var strips=new FilteredElementCollector(document).OfCategory(BuiltInCategory.OST_LightingFixtures).WhereElementIsNotElementType().Cast<FamilyInstance>().Where(f=>(f.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString()??"").StartsWith("Strip 03 horizontal")).ToList();
 var drop=new List<ElementId>(); foreach(var f in strips){ var p=((LocationPoint)f.Location).Point; double y=-FmcScript.ToMm(p.Y)/1000, x=FmcScript.ToMm(p.X)/1000; if(y>2.0||x>9.0) drop.Add(f.Id); }
 document.Delete(drop); log.Append("scan strips removed "+drop.Count+"; ");
 var sIn=new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().First(s=>s.FamilyName=="FMC_E_LightFixture_StripLED"&&s.Name.StartsWith("14"));
 var opt=new SpatialElementBoundaryOptions{SpatialElementBoundaryLocation=SpatialElementBoundaryLocation.Finish}; double zz=FmcScript.Mm(2850), inset=FmcScript.Mm(30); int ns=0;
 foreach(var bs in room.GetBoundarySegments(opt)[0]){ var w=document.GetElement(bs.ElementId) as Wall; var c=bs.GetCurve(); if(w==null||c.Length<FmcScript.Mm(300)) continue;
  var a=c.GetEndPoint(0); var b=c.GetEndPoint(1); var dir=(b-a).Normalize(); var mid=(new XYZ(a.X,a.Y,zz)+new XYZ(b.X,b.Y,zz))/2; Reference fr=null;
  foreach(var side in new[]{ShellLayerType.Interior,ShellLayerType.Exterior}) foreach(var r in HostObjectUtils.GetSideFaces(w,side)){ var f=w.GetGeometryObjectFromReference(r) as PlanarFace; if(f==null) continue; var pr=f.Project(mid); if(pr!=null&&pr.Distance<FmcScript.Mm(2)) fr=r; }
  if(fr==null){ fails.Add("lobby strip seg"); continue; }
  var fi=document.Create.NewFamilyInstance(fr,new XYZ(a.X,a.Y,zz)+dir*inset,dir,sIn); fi.LookupParameter("Length").Set(c.Length-2*inset); fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("Strip 06 horizontal (L4 wall strip)"); ns++; }
 var v06=new FilteredElementCollector(document).OfCategory(BuiltInCategory.OST_LightingFixtures).WhereElementIsNotElementType().Cast<FamilyInstance>().FirstOrDefault(f=>(f.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString()??"")=="Strip 06 vertical corner");
 if(v06!=null) v06.LookupParameter("Length").Set(FmcScript.Mm(2500));
 log.Append("lobby wall strips "+ns+"; ");
 // switch S3 + plan notes no longer valid
 foreach(var e in new FilteredElementCollector(document).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>().Where(f=>f.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString()=="SW-S3").ToList()) document.Delete(e.Id);
 foreach(TextNote tn in new FilteredElementCollector(document).OfClass(typeof(TextNote)).Cast<TextNote>().ToList()){ var tx=tn.Text.Trim(); if(tx=="S3"||tx=="S: S3") document.Delete(tn.Id); }
 log.Append("placed "+n+(fails.Count>0?"; fails "+string.Join(" | ",fails):""));
 if(dry){t.RollBack(); log.Insert(0,"DRY: ");} else log.Insert(0,"BUILT "+t.Commit()+": ");
}catch(Exception ex){ if(t.GetStatus()==TransactionStatus.Started) t.RollBack(); return "FAILED "+ex.GetType().Name+": "+ex.Message+" | "+log; }
}
return log.ToString();
