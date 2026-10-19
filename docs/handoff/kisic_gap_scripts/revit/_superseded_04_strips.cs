// KISIC step 04 – LED strips. transactionMode "none", usings ["Autodesk.Revit.DB.Architecture"], parameters ["dry"]/["real"].
// SAFE version: no appearance-asset editing (that is step 04b, run alone). Loads the family in its own transaction first.
bool dry=(string)parameters[0]=="dry";
var log=new StringBuilder();
string fp=@"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\04_Families\_Staging\E\FMC_E_LightFixture_StripLED.rfa";
// 1) load family + plain materials (committed even on dry: loading a family is harmless and keeps the dry run honest)
FmcScript.Run(document,"KISIC 04 load strip family + materials",()=>{
 Family famL; if(!document.LoadFamily(fp,out famL)) famL=null;
 Material M(string name, Color col){ var m=new FilteredElementCollector(document).OfClass(typeof(Material)).Cast<Material>().FirstOrDefault(x=>x.Name==name); if(m==null) m=(Material)document.GetElement(Material.Create(document,name)); m.Color=col; return m; }
 var mDiff=M("FMC_LED_Diffuser_Opal_3000K",new Color(255,236,205)); var mAlu=M("FMC_Aluminium_Anodised_Silver",new Color(196,198,200));
 var fam=new FilteredElementCollector(document).OfClass(typeof(Family)).Cast<Family>().First(f=>f.Name=="FMC_E_LightFixture_StripLED");
 foreach(var id in fam.GetFamilySymbolIds()){ var s=(FamilySymbol)document.GetElement(id); if(!s.IsActive) s.Activate(); s.LookupParameter("Diffuser Material")?.Set(mDiff.Id); s.LookupParameter("Body Material")?.Set(mAlu.Id);} });
var famS=new FilteredElementCollector(document).OfClass(typeof(Family)).Cast<Family>().First(f=>f.Name=="FMC_E_LightFixture_StripLED");
var syms=famS.GetFamilySymbolIds().Select(i=>(FamilySymbol)document.GetElement(i)).ToList();
var sIn=syms.First(s=>s.Name=="14Wpm_24V"); var sOut=syms.First(s=>s.Name=="10Wpm_24V-IP65");
// 2) place
using(var t=new Transaction(document,"KISIC 04 strips")){
var fo=t.GetFailureHandlingOptions(); fo.SetFailuresPreprocessor(new FmcFailures()); t.SetFailureHandlingOptions(fo); t.Start();
try{
double zH=FmcScript.Mm(2850), inset=FmcScript.Mm(30);
var opt=new SpatialElementBoundaryOptions{SpatialElementBoundaryLocation=SpatialElementBoundaryLocation.Finish};
Reference FaceRef(Wall w, XYZ p){ foreach(var side in new[]{ShellLayerType.Interior,ShellLayerType.Exterior}) foreach(var r in HostObjectUtils.GetSideFaces(w,side)){ var f=w.GetGeometryObjectFromReference(r) as PlanarFace; if(f==null) continue; var pr=f.Project(p); if(pr!=null && pr.Distance<FmcScript.Mm(2)) return r;} return null; }
int n=0; double total=0; var fails=new List<string>();
var vertSeg=new Dictionary<string,int>{{"01",2},{"02",0},{"03",1},{"05",2},{"06",1}};
foreach(Room r in new FilteredElementCollector(document).OfCategory(BuiltInCategory.OST_Rooms)){
 var loops=r.GetBoundarySegments(opt); if(loops==null||loops.Count==0) continue; var segs=loops[0]; int k=-1; int roomN=0;
 foreach(var bs in segs){ k++; var w=document.GetElement(bs.ElementId) as Wall; var c=bs.GetCurve();
  if(w==null||c.Length<FmcScript.Mm(300)) continue;
  var a=c.GetEndPoint(0); var b=c.GetEndPoint(1); var dir=(b-a).Normalize();
  var mid=(new XYZ(a.X,a.Y,zH)+new XYZ(b.X,b.Y,zH))/2;
  var fr=FaceRef(w,mid); if(fr==null){fails.Add(r.Number+" seg"+k); continue;}
  var fi=document.Create.NewFamilyInstance(fr,new XYZ(a.X,a.Y,zH)+dir*inset,dir,sIn);
  fi.LookupParameter("Length").Set(c.Length-2*inset); fi.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("Strip "+r.Number+" horizontal"); n++; total+=c.Length-2*inset; roomN++;
  if(vertSeg.ContainsKey(r.Number)&&vertSeg[r.Number]==k){
   var vf=document.Create.NewFamilyInstance(fr,new XYZ(a.X,a.Y,FmcScript.Mm(300))+dir*inset,XYZ.BasisZ,sIn);
   vf.LookupParameter("Length").Set(FmcScript.Mm(2500)); vf.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("Strip "+r.Number+" vertical corner"); n++; total+=FmcScript.Mm(2500);} }
 log.Append(r.Number+":"+roomN+" "); }
var ws=new FilteredElementCollector(document).OfClass(typeof(Wall)).Cast<Wall>().First(w=>w.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).AsString()=="W-S");
var vfr=FaceRef(ws,FmcScript.PointMm(4800,-6850,2600));
if(vfr!=null){ var v=document.Create.NewFamilyInstance(vfr,FmcScript.PointMm(0,-6850,2600),XYZ.BasisX,sOut); v.LookupParameter("Length").Set(FmcScript.Mm(9500)); v.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("Strip veranda V1"); n++; total+=FmcScript.Mm(9500);} else fails.Add("veranda");
log.AppendLine("\nstrips "+n+", total "+Math.Round(FmcScript.ToMm(total)/1000,1)+" m; face misses: "+(fails.Count==0?"none":string.Join(",",fails)));
if(dry){t.RollBack(); log.Insert(0,"DRY (placement rolled back; family + materials loaded): ");} else {log.Insert(0,"BUILT "+t.Commit()+": ");}
}catch(Exception ex){ if(t.GetStatus()==TransactionStatus.Started) t.RollBack(); return "FAILED "+ex.GetType().Name+": "+ex.Message+" | "+log; }
}
return log.ToString();
