// KISIC 20c - east canopy over the entrance wedge (slab 2700-2850 + bamboo soffit, tied into the south canopy),
// re-host the 3 east recessed lights on it, add a continuous IP65 edge glow strip under both canopy edges (V1, same switch as the strips + SIGN-1).
var log=new StringBuilder(); double M(double mm)=>FmcScript.Mm(mm); Func<double,double,double,XYZ> P=(x,y,z)=>FmcScript.PointMm(x*1000,-y*1000,z);
string Cm(Element e)=>e.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString()??"";
var L0=new FilteredElementCollector(document).OfClass(typeof(Level)).Cast<Level>().First(l=>l.Name=="L00 FFL");
var lp=(View)document.GetElement(new ElementId(1697159L));
using(var t=new Transaction(document,"KISIC 20c east canopy + edge glow")){ var fo=t.GetFailureHandlingOptions(); fo.SetFailuresPreprocessor(new FmcFailures()); t.SetFailureHandlingOptions(fo); t.Start();
try{
 foreach(var old in new FilteredElementCollector(document).WhereElementIsNotElementType().Where(e=>Cm(e).StartsWith("East canopy")).Select(e=>e.Id).ToList()) document.Delete(old);
 // polygon in brief metres (x east, y south): facade outer face -> 1.2 m out (inside the boundary) -> SE corner tied to the south canopy
 var pts=new[]{(8.90,-0.08),(10.09,-0.23),(10.95,6.63),(11.10,8.25),(9.92,8.25),(9.92,6.85),(9.77,6.85)};
 CurveLoop Loop(double z,double inset){ var cl=new CurveLoop(); for(int i=0;i<pts.Length;i++){ var a=pts[i]; var b=pts[(i+1)%pts.Length]; cl.Append(Line.CreateBound(P(a.Item1,a.Item2,z),P(b.Item1,b.Item2,z))); } return cl; }
 var slabT=document.GetElement(new ElementId(1658805L)).GetTypeId(); var soffT=document.GetElement(new ElementId(1658908L)).GetTypeId();
 var slab=Floor.Create(document,new List<CurveLoop>{Loop(0,0)},slabT,L0.Id); slab.get_Parameter(BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM).Set(M(2850)); slab.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("East canopy slab over the entrance wedge, soffit 2700 (ties into the south canopy)");
 var soff=Ceiling.Create(document,new List<CurveLoop>{Loop(0,0)},soffT,L0.Id); soff.get_Parameter(BuiltInParameter.CEILING_HEIGHTABOVELEVEL_PARAM).Set(M(2700)); soff.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("East canopy bamboo soffit 2700");
 document.Regenerate();
 var ceils=new List<Ceiling>{soff,(Ceiling)document.GetElement(new ElementId(1658908L))};
 (Reference r,double z) Under(double x,double y){ var pt=P(x,y,0); foreach(var c in ceils) foreach(var rf in HostObjectUtils.GetBottomFaces(c)){ var f=c.GetGeometryObjectFromReference(rf) as PlanarFace; if(f==null) continue; var pr=f.Project(new XYZ(pt.X,pt.Y,f.Origin.Z)); if(pr!=null&&pr.Distance<M(1)) return (rf,f.Origin.Z); } return (null,0); }
 // re-host the east recessed lights
 int rh=0; var orange=lp.GetElementOverrides(new ElementId(1696156L));
 foreach(var f in new FilteredElementCollector(document).OfCategory(BuiltInCategory.OST_LightingFixtures).WhereElementIsNotElementType().Cast<FamilyInstance>().Where(g=>Cm(g).StartsWith("V2")&&g.Host==null).ToList()){
  var p=((LocationPoint)f.Location).Point; var x=FmcScript.ToMm(p.X)/1000; var y=-FmcScript.ToMm(p.Y)/1000; var (rf,z)=Under(x,y); if(rf==null){ log.Append($"no soffit at {x:0.00},{y:0.00}; "); continue; }
  var sym=f.Symbol; document.Delete(f.Id); var n=document.Create.NewFamilyInstance(rf,new XYZ(p.X,p.Y,z),XYZ.BasisX,sym);
  n.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("V2 recessed IP65 downlight, east canopy soffit"); n.LookupParameter("FMC Switch")?.Set("V2"); lp.SetElementOverrides(n.Id,orange); rh++; }
 // edge glow: IP65 strip on the soffit 100 mm in from the canopy edges (south edge, SE corner, east edge)
 var s65=new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().First(s=>s.FamilyName=="FMC_E_LightFixture_StripLED"&&s.Name=="10Wpm_24V_3000K_IP65");
 int ns=0; foreach(var (a,b) in new[]{((-0.05,8.15),(9.90,8.15)),((9.95,8.15),(11.00,8.15)),((10.86,6.63),(10.01,-0.13))}){
  var pa=P(a.Item1,a.Item2,0); var pb=P(b.Item1,b.Item2,0); var mid=(pa+pb)/2; var (rf,z)=Under(-0+FmcScript.ToMm(mid.X)/1000,-FmcScript.ToMm(mid.Y)/1000); if(rf==null){ log.Append("edge strip no soffit; "); continue; }
  var d=(pb-pa).Normalize(); var fi=document.Create.NewFamilyInstance(rf,new XYZ(pa.X,pa.Y,z),d,s65); fi.LookupParameter("Length")?.Set(pa.DistanceTo(pb)-M(40));
  fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("V1 canopy edge glow strip IP65 under the bamboo soffit - same switch as the veranda strips + SIGN-1"); fi.LookupParameter("FMC Switch")?.Set("V1"); lp.SetElementOverrides(fi.Id,orange); ns++; }
 log.Append($"canopy slab {slab.Id.Value}, soffit {soff.Id.Value}, re-hosted {rh}, edge strips {ns}; ");
 t.Commit();
}catch(Exception e){ if(t.GetStatus()==TransactionStatus.Started) t.RollBack(); log.Append("FAILED "+e.GetType().Name+" "+e.Message); } }
return log.ToString();
