// KISIC step 01 – existing shell. send_code_to_revit, transactionMode "none", parameters ["dry"] or ["real"].
// Replays the checked version: centreline walls (20/20 ends joined), existing openings + doors, slabs, ceiling.
bool dry = parameters!=null && parameters.Length>0 && (string)parameters[0]=="dry";
var log=new StringBuilder();
Func<double,double,XYZ> P=(x,y)=>FmcScript.PointMm(x*1000,-y*1000,0);
using(var t=new Transaction(document,"KISIC 01 existing shell")){
var fo=t.GetFailureHandlingOptions(); fo.SetFailuresPreprocessor(new FmcFailures()); t.SetFailureHandlingOptions(fo);
t.Start();
try{
var lv=new FilteredElementCollector(document).OfClass(typeof(Level)).Cast<Level>().OrderBy(l=>l.Elevation).ToList();
Level L0=lv[0], L1=lv[1];
L0.Name="L00 FFL"; L1.Name="L00 Roof Slab"; L1.Elevation=FmcScript.Mm(3400);
var existing=document.Phases.Cast<Phase>().First(p=>p.Name=="Existing");
Action<Element> SetEx=(e)=>{var p=e.get_Parameter(BuiltInParameter.PHASE_CREATED); if(p!=null&&!p.IsReadOnly) p.Set(existing.Id);};
var wt=new FilteredElementCollector(document).OfClass(typeof(WallType)).Cast<WallType>().First(w=>w.Name=="Generic - 150mm Masonry");
var walls=new Dictionary<string,Wall>();
Action<string,double,double,double,double> W=(id,x1,y1,x2,y2)=>{
 var w=Wall.Create(document,Line.CreateBound(P(x1,y1),P(x2,y2)),wt.Id,L0.Id,FmcScript.Mm(3400),0,false,false);
 w.get_Parameter(BuiltInParameter.WALL_KEY_REF_PARAM).Set(0);
 w.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set(id);
 SetEx(w); walls[id]=w;};
double fxAt(double y)=>8.815+0.86*(y+0.075)/6.85;
W("W-N",-0.075,-0.075,8.815,-0.075);
W("W-W",-0.075,-0.075,-0.075,6.775);
W("W-E-facade",8.815,-0.075,9.675,6.775);
W("W-S",-0.075,6.775,9.675,6.775);
W("W-XR-E",4.075,-0.075,4.075,3.575);
W("W-XR-S",-0.075,3.575,5.375,3.575);
W("W-CTL-E",5.375,-0.075,5.375,3.575);
W("W-CTL-S",4.075,2.275,5.375,2.275);
W("W-SCN-S",5.375,2.375,fxAt(2.375)+0.010,2.375);   // 10 mm into the façade so the T-join forms
W("W-LAB-E",4.15,3.575,4.15,6.775);
document.Regenerate();
foreach(var w in walls.Values){WallUtils.AllowWallJoinAtEnd(w,0);WallUtils.AllowWallJoinAtEnd(w,1);}
document.Regenerate();
// existing openings (sliders + entrance; slider families come later)
Action<string,double,double,double,double,double> O=(id,x1,y1,x2,y2,head)=>document.Create.NewOpening(walls[id],P(x1,y1),P(x2,y2)+new XYZ(0,0,FmcScript.Mm(head)));
O("W-S",1.05,6.775,3.15,6.775,2400);
O("W-S",5.45,6.775,8.40,6.775,2400);
double fx1=8.815+0.86*0.45, fy1=-0.075+6.85*0.45, fx2=8.815+0.86*0.80, fy2=-0.075+6.85*0.80;
O("W-E-facade",fx1,fy1,fx2,fy2,2400);
// existing single doors
var baseSym=new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().First(s=>s.FamilyName=="M_Door-Passage-Single-Flush");
Func<int,FamilySymbol> Sym=(w)=>{string n=w+" x 2100mm"; var s=new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().FirstOrDefault(f=>f.FamilyName==baseSym.FamilyName&&f.Name==n);
 if(s==null){s=(FamilySymbol)baseSym.Duplicate(n); s.LookupParameter("Width").Set(FmcScript.Mm(w)); s.LookupParameter("Height").Set(FmcScript.Mm(2100));} if(!s.IsActive) s.Activate(); return s;};
Action<string,string,double,double,int,bool> D=(tag,id,x,y,w,flip)=>{var fi=document.Create.NewFamilyInstance(P(x,y),Sym(w),walls[id],L0,Autodesk.Revit.DB.Structure.StructuralType.NonStructural);
 fi.get_Parameter(BuiltInParameter.ALL_MODEL_MARK).Set(tag); SetEx(fi); if(flip){document.Regenerate(); fi.flipFacing();}};
// flip flags: checked on the first build – without the flip D01 swung into the vestibule and D05 into the lobby
D("D01 X-ray (shielded)","W-XR-E",4.075,2.93,1000,true);
D("D02 Control","W-CTL-S",4.875,2.275,750,false);
D("D03 Scan","W-SCN-S",5.90,2.375,800,false);
D("D04 Shared X-ray/Control","W-CTL-E",5.375,2.95,1000,false);
D("D05 Lab","W-LAB-E",4.15,6.20,900,true);
// slabs + ceiling
var ft=new FilteredElementCollector(document).OfClass(typeof(FloorType)).Cast<FloorType>().First(f=>f.Name=="Concrete 150mm");
Func<double[][],CurveLoop> Loop=(pts)=>{var cl=new CurveLoop(); for(int i=0;i<pts.Length;i++){var a=pts[i];var b=pts[(i+1)%pts.Length]; cl.Append(Line.CreateBound(P(a[0],a[1]),P(b[0],b[1])));} return cl;};
var bld=new[]{new[]{-0.15,-0.15},new[]{8.89,-0.15},new[]{9.75,6.85},new[]{-0.15,6.85}};
var ver=new[]{new[]{-0.15,6.85},new[]{9.75,6.85},new[]{9.92,8.25},new[]{-0.15,8.25}};
Action<double[][],Level,double,string> F=(pts,lvl,off,name)=>{var f=Floor.Create(document,new List<CurveLoop>{Loop(pts)},ft.Id,lvl.Id); SetEx(f); f.get_Parameter(BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM).Set(FmcScript.Mm(off)); f.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set(name);};
F(bld,L0,0,"Building floor slab");
F(ver,L0,-50,"Veranda floor, 50 mm step down");
F(bld,L1,150,"Roof slab, existing");
F(ver,L0,2850,"Veranda canopy slab, soffit 2700");
// ceilings are step 03b (per room, from L2)
document.Regenerate();
// QA: every wall end joined
if(dry){t.RollBack(); log.Insert(0,"DRY RUN (rolled back; wall joins only form on commit, so the join QA runs after the real run): ");} else {log.Insert(0,"BUILT ("+t.Commit()+"): ");
 // join QA after commit (Revit auto-joins at commit)
 int ends=0, joined=0; var free=new List<string>();
 foreach(var kv in walls){var lc=(LocationCurve)kv.Value.Location; for(int i=0;i<2;i++){ends++; bool j=false; foreach(Element e in lc.get_ElementsAtJoin(i)) if(e.Id!=kv.Value.Id) j=true; if(j) joined++; else free.Add(kv.Key+(i==0?" start":" end"));}}
 log.AppendLine("walls "+walls.Count+", ends joined "+joined+"/"+ends+(free.Count>0?" FREE: "+string.Join(", ",free)+" – fix before step 02":""));}
}catch(Exception ex){ if(t.GetStatus()==TransactionStatus.Started) t.RollBack(); return "FAILED "+ex.GetType().Name+": "+ex.Message; }
}
return log.ToString();
