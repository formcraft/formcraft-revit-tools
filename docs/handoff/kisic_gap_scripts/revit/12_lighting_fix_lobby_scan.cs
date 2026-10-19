// KISIC step 12 – lighting fix (person's layers, 19 Oct): lobby = 2 general (1 pendant over the counter + light kit at the fan in the centre),
// spots: 3 along the south wall (L6) + 3 along the north wall in the middle over the 3-seater (L8, replaces the pendants), strips: tray cove on the fascia tops (L4) + vertical corner run.
// Scan: raft lowered 2850 -> 2750, 4 downlights symmetric inside the raft, halo strip moved from the raft's underside edge to its top face (concealed up-light).
// transactionMode "none", parameters ["dry"|"real"].
bool dry=(string)parameters[0]=="dry"; var log=new StringBuilder(); var fails=new List<string>();
Func<double,double,double,XYZ> P=(x,y,z)=>FmcScript.PointMm(x*1000,-y*1000,z);
FamilySymbol Sym(string fam,string type){ var s=new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().FirstOrDefault(f=>f.FamilyName==fam&&(type==null||f.Name.StartsWith(type))); if(s!=null&&!s.IsActive) s.Activate(); return s; }
List<FamilyInstance> ByComment(string start)=>new FilteredElementCollector(document).OfCategory(BuiltInCategory.OST_LightingFixtures).WhereElementIsNotElementType().Cast<FamilyInstance>().Where(f=>(f.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString()??"").StartsWith(start)).ToList();
using(var t=new Transaction(document,"KISIC 12 lighting fix lobby + scan")){ var fo=t.GetFailureHandlingOptions(); fo.SetFailuresPreprocessor(new FmcFailures()); t.SetFailureHandlingOptions(fo); t.Start();
try{
 var ceilings=new FilteredElementCollector(document).OfClass(typeof(Ceiling)).Cast<Ceiling>().ToList();
 Reference Below(double x,double y,out double zmm){ zmm=0; Reference best=null; double bz=double.MaxValue; var pt=P(x,y,0);
  foreach(var c in ceilings) foreach(var r in HostObjectUtils.GetBottomFaces(c)){ var f=c.GetGeometryObjectFromReference(r) as PlanarFace; if(f==null) continue; var pr=f.Project(new XYZ(pt.X,pt.Y,f.Origin.Z)); if(pr==null||pr.Distance>FmcScript.Mm(1)) continue; if(f.Origin.Z<bz){bz=f.Origin.Z;best=r;} } zmm=FmcScript.ToMm(bz); return best; }
 int n=0;
 FamilyInstance OnC(FamilySymbol s,double x,double y,string note){ double z; var r=Below(x,y,out z); if(r==null){fails.Add(note+" no ceiling");return null;} var fi=document.Create.NewFamilyInstance(r,P(x,y,z),XYZ.BasisX,s); fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set(note); n++; return fi; }
 var DL150=Sym("FMC_E_LightFixture_Downlight_LED","150"); var DL200=Sym("FMC_E_LightFixture_Downlight_LED","200"); var PD=Sym("FMC_E_LightFixture_Pendant_Woven",null); var ST=Sym("FMC_E_LightFixture_StripLED","14Wpm");
 // --- remove what the layers no longer have
 var del=new List<ElementId>();
 del.AddRange(ByComment("L3 spot").Select(f=>f.Id)); del.AddRange(ByComment("L8 woven").Select(f=>f.Id)); del.AddRange(ByComment("L5 woven").Select(f=>f.Id));
 del.AddRange(ByComment("Strip 06 horizontal").Select(f=>f.Id)); del.AddRange(ByComment("S3 raft").Select(f=>f.Id)); del.AddRange(ByComment("S1 downlight").Select(f=>f.Id));
 log.Append("removed "+del.Count+"; "); document.Delete(del);
 // --- lobby general: one pendant centred over the counter (desk 5.00-5.76 x 3.79-5.54) + fan light kit at the fan hub (centre)
 OnC(PD,5.38,4.67,"L5 woven pendant over the counter (general 1)");
 var fan=new FilteredElementCollector(document).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>().First(f=>f.Symbol.FamilyName=="FMC_M_MechEq_CeilingFan"); var fp=((LocationPoint)fan.Location).Point;
 OnC(DL200,FmcScript.ToMm(fp.X)/1000,-FmcScript.ToMm(fp.Y)/1000,"L1 fan light kit, centre of the room (general 2)");
 // --- spots along the north wall, middle, over the 3-seater (sofa 6.50-8.70)
 foreach(var x in new[]{6.85,7.60,8.35}) OnC(DL150,x,2.75,"L8 spot along north wall over 3-seater");
 // --- tray cove: strip on the top face of every fascia (light washes up the 3050 field through the 50 mm slot)
 int nc=0; var opt=new Options{ComputeReferences=true};
 foreach(var w in new FilteredElementCollector(document).OfClass(typeof(Wall)).Cast<Wall>().Where(w=>(w.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString()??"").ToLower().Contains("fascia"))){
  var c=((LocationCurve)w.Location).Curve; var dir=(c.GetEndPoint(1)-c.GetEndPoint(0)).Normalize();
  PlanarFace top=null; foreach(var go in w.get_Geometry(opt)) if(go is Solid so) foreach(Face f in so.Faces) if(f is PlanarFace pf&&pf.FaceNormal.IsAlmostEqualTo(XYZ.BasisZ)) top=pf;
  if(top==null){fails.Add("fascia top "+w.Id); continue;}
  var a=c.GetEndPoint(0)+dir*FmcScript.Mm(30); var start=new XYZ(a.X,a.Y,top.Origin.Z);
  var fi=document.Create.NewFamilyInstance(top.Reference,start,dir,ST); fi.LookupParameter("Length").Set(c.Length-FmcScript.Mm(60)); fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("L4 tray cove strip"); nc++; n++; }
 log.Append("cove pieces "+nc+"; ");
 // --- Scan raft: lower to 2750, downlights symmetric inside, halo on the top face
 var raft=ceilings.First(c=>c.Name.Contains("raft")); raft.get_Parameter(BuiltInParameter.CEILING_HEIGHTABOVELEVEL_PARAM).Set(FmcScript.Mm(2750)); document.Regenerate();
 foreach(var x in new[]{6.75,7.75}) foreach(var y in new[]{0.85,1.45}) OnC(DL150,x,y,"S1 downlight (dimmer)");
 var tops=HostObjectUtils.GetTopFaces(raft); var tf=(PlanarFace)raft.GetGeometryObjectFromReference(tops[0]); double tz=FmcScript.ToMm(tf.Origin.Z);
 var pts=new[]{new[]{6.35,0.65},new[]{8.15,0.65},new[]{8.15,1.65},new[]{6.35,1.65}};
 for(int i=0;i<4;i++){ var a=P(pts[i][0],pts[i][1],tz); var b=P(pts[(i+1)%4][0],pts[(i+1)%4][1],tz); var fi=document.Create.NewFamilyInstance(tops[0],a,(b-a).Normalize(),ST); fi.LookupParameter("Length").Set(a.DistanceTo(b)); fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("S3 raft cove strip (top face, up-light)"); n++; }
 // --- plan notes
 var v=new FilteredElementCollector(document).OfClass(typeof(ViewPlan)).Cast<ViewPlan>().FirstOrDefault(x=>x.Name=="E-LP-01 Lighting Plan L00");
 if(v!=null) foreach(TextNote tn in new FilteredElementCollector(document,v.Id).OfClass(typeof(TextNote)).Cast<TextNote>().ToList()){ var tx=tn.Text.Trim();
  if(tx=="L3") document.Delete(tn.Id); else if(tx=="S: L3L8") tn.Text="S: L8"; else if(tx=="FAN 1320 + LIGHT KIT") tn.Text="FAN 1320 + LIGHT KIT (L1)"; }
 var sw=new FilteredElementCollector(document).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>().FirstOrDefault(f=>f.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString()=="SW-L3L8"); if(sw!=null){ sw.get_Parameter(BuiltInParameter.ALL_MODEL_MARK).Set("SW-L8"); sw.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("SW-L8 · circuit P1"); }
 log.Append("placed "+n+(fails.Count>0?"; fails "+string.Join(" | ",fails):""));
 if(dry){t.RollBack(); log.Insert(0,"DRY: ");} else log.Insert(0,"BUILT "+t.Commit()+": ");
}catch(Exception ex){ if(t.GetStatus()==TransactionStatus.Started) t.RollBack(); return "FAILED "+ex.GetType().Name+": "+ex.Message+" | "+log; }
}
return log.ToString();
