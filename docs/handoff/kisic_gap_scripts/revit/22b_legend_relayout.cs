// KISIC 22b - legend relayout: each component shows its best face (ceiling plan for ceiling fittings, the largest elevation for wall/floor items),
// rows sized from the measured symbol, two height-balanced columns, text beside each symbol; viewports re-placed top-left on E-1201.
var log=new StringBuilder(); double M(double mm)=>FmcScript.Mm(mm); double MM(double ft)=>FmcScript.ToMm(ft);
var sh=(ViewSheet)document.GetElement(new ElementId(1708021L));
var tts=new FilteredElementCollector(document).OfClass(typeof(TextNoteType)).Cast<TextNoteType>().ToList();
var tB=tts.First(x=>x.Name=="FMC 2.5 Bold"); var tN=tts.FirstOrDefault(x=>x.Name.Contains("2.5")&&!x.Name.Contains("Bold"))??tB; var tH=tts.FirstOrDefault(x=>x.Name=="FMC 5 Bold")??tB;
string TM(FamilySymbol s)=>s.get_Parameter(BuiltInParameter.ALL_MODEL_TYPE_MARK)?.AsString()??"";
string Desc(FamilySymbol s){ var d=s.get_Parameter(BuiltInParameter.ALL_MODEL_DESCRIPTION)?.AsString(); if(string.IsNullOrWhiteSpace(d)) d=s.get_Parameter(BuiltInParameter.ALL_MODEL_TYPE_COMMENTS)?.AsString(); return string.IsNullOrWhiteSpace(d)?"":d; }
// visible extents of an element in a view (honours hidden subcategories, unlike get_BoundingBox)
(XYZ mn,XYZ mx) Ext(Element e,View v){ double x0=1e9,y0=1e9,x1=-1e9,y1=-1e9; void Add(XYZ p){ x0=Math.Min(x0,p.X); y0=Math.Min(y0,p.Y); x1=Math.Max(x1,p.X); y1=Math.Max(y1,p.Y); }
 void Walk(GeometryElement ge){ foreach(var g in ge){ if(g is GeometryInstance gi) Walk(gi.GetInstanceGeometry()); else if(g is Solid so&&so.Faces.Size>0){ foreach(Edge ed in so.Edges) foreach(var p in ed.Tessellate()) Add(p); } else if(g is Curve cu) foreach(var p in cu.Tessellate()) Add(p); else if(g is PolyLine pl) foreach(var p in pl.GetCoordinates()) Add(p); } }
 var geo=e.get_Geometry(new Options{View=v}); if(geo!=null) Walk(geo); if(x0>x1){ var b=e.get_BoundingBox(v); return (b.Min,b.Max); } return (new XYZ(x0,y0,0),new XYZ(x1,y1,0)); }
var res=new List<(View v,double wmm,double hmm)>();
using(var t=new Transaction(document,"KISIC 22b legend relayout")){ var fo=t.GetFailureHandlingOptions(); fo.SetFailuresPreprocessor(new FmcFailures()); t.SetFailureHandlingOptions(fo); t.Start();
try{
 var lsCat=Category.GetCategory(document,BuiltInCategory.OST_LightingFixtureSource);
 foreach(var v in new FilteredElementCollector(document).OfClass(typeof(View)).Cast<View>().Where(q=>!q.IsTemplate&&q.ViewType!=ViewType.DrawingSheet&&q.ViewType!=ViewType.Schedule)){ var tv=v.ViewTemplateId!=ElementId.InvalidElementId?(View)document.GetElement(v.ViewTemplateId):v; try{ if(lsCat!=null&&tv.CanCategoryBeHidden(lsCat.Id)) tv.SetCategoryHidden(lsCat.Id,true); }catch{} }
 document.Regenerate();
 foreach(var (vn,title,desc) in new[]{("E-LEG-02 Lighting fittings legend","LIGHTING FITTINGS & CEILING FAN","Lighting fittings legend"),("E-LEG-03 Switches, outlets & equipment legend","SWITCHES, OUTLETS & EQUIPMENT","Switches, outlets & equipment legend")}){
  var lv=new FilteredElementCollector(document).OfClass(typeof(View)).Cast<View>().First(v=>v.Name==vn); lv.Scale=10; lv.DetailLevel=ViewDetailLevel.Fine; lv.get_Parameter(BuiltInParameter.VIEW_DESCRIPTION)?.Set(desc); double sc=10;
  foreach(var id in new FilteredElementCollector(document,lv.Id).OfClass(typeof(TextNote)).ToElementIds().ToList()) document.Delete(id);
  var comps=new FilteredElementCollector(document,lv.Id).OfCategory(BuiltInCategory.OST_LegendComponents).ToList();
  var rows=new List<(Element e,FamilySymbol s,double w,double h)>();
  foreach(var lc in comps){ var s=document.GetElement(lc.get_Parameter(BuiltInParameter.LEGEND_COMPONENT).AsElementId()) as FamilySymbol; if(s==null) continue; var pv=lc.get_Parameter(BuiltInParameter.LEGEND_COMPONENT_VIEW);
   bool ceilingFit=s.Category.Id.Value==(long)BuiltInCategory.OST_LightingFixtures && !s.FamilyName.Contains("Strip") && !s.FamilyName.Contains("WallLight") && !s.FamilyName.Contains("Xray") && !s.Name.Contains("FanLightKit");
   int best=-7; double bestA=-1;
   foreach(var vv in ceilingFit? new[]{-4} : new[]{-7,-6,-9,-10}){ pv.Set(vv); document.Regenerate(); var b=Ext(lc,lv); var a=(b.mx.X-b.mn.X)*(b.mx.Y-b.mn.Y); if(a>bestA){bestA=a;best=vv;} }
   if(s.FamilyName.Contains("CeilingFan")) best=-7; pv.Set(best); document.Regenerate(); var bb=Ext(lc,lv);
   rows.Add((lc,s,MM(bb.mx.X-bb.mn.X)/sc,MM(bb.mx.Y-bb.mn.Y)/sc)); }
  rows=rows.OrderBy(r=>r.s.Category.Name).ThenBy(r=>TM(r.s)).ThenBy(r=>r.s.FamilyName).ThenBy(r=>r.s.Name).ToList();
  double total=rows.Sum(r=>Math.Max(r.h,10)+7); double colW=255, symW=Math.Min(110,rows.Max(r=>r.w)+6), half=total/2;
  TextNote.Create(document,lv.Id,new XYZ(0,M(16*sc),0),title,tH.Id);
  for(int c=0;c<2;c++){ TextNote.Create(document,lv.Id,new XYZ(M(c*colW*sc),M(7*sc),0),"Symbol",tB.Id); TextNote.Create(document,lv.Id,new XYZ(M((c*colW+symW+4)*sc),M(7*sc),0),"Mark · family : type · description",tB.Id); }
  double y=0; int col=0; double maxH=0;
  foreach(var r in rows){ double rh=Math.Max(r.h,10)+7; if(col==0&&y>0&&y+rh/2>half){ maxH=Math.Max(maxH,y); col=1; y=0; }
   double cx=col*colW+symW/2, cy=-(y+rh/2); var bb=Ext(r.e,lv); var cur=new XYZ((bb.mn.X+bb.mx.X)/2,(bb.mn.Y+bb.mx.Y)/2,0);
   ElementTransformUtils.MoveElement(document,r.e.Id,new XYZ(M(cx*sc),M(cy*sc),0)-cur);
   var tn=TextNote.Create(document,lv.Id,new XYZ(M((col*colW+symW+4)*sc),M((cy+4.5)*sc),0),$"{(TM(r.s)==""?"-":TM(r.s))}   {r.s.FamilyName.Replace("FMC_","")} : {r.s.Name}\r{Desc(r.s)}",tN.Id); tn.Width=M((colW-symW-12)*sc);
   y+=rh; }
  maxH=Math.Max(maxH,y); res.Add((lv,colW*2,maxH+20)); log.Append($"{vn}: {rows.Count} rows, symW {symW:0}, height {maxH:0} mm; "); }
 // re-place the viewports on E-1201: lighting legend top-left, devices legend under it
 foreach(var vpid in sh.GetAllViewports().ToList()){ var vp=(Viewport)document.GetElement(vpid); if(((View)document.GetElement(vp.ViewId)).Name.StartsWith("E-LEG")) document.Delete(vpid); }
 document.Regenerate(); double top=815;
 foreach(var (lv,w,h) in res){ var vp=Viewport.Create(document,sh.Id,lv.Id,new XYZ(M(300),M(400),0)); document.Regenerate(); var o=vp.GetBoxOutline();
  vp.SetBoxCenter(vp.GetBoxCenter()+new XYZ(M(35)-o.MinimumPoint.X,M(top)-o.MaximumPoint.Y,0)); document.Regenerate(); var o2=vp.GetBoxOutline();
  log.Append($"vp {lv.Name.Substring(0,9)} x{MM(o2.MinimumPoint.X):0}..{MM(o2.MaximumPoint.X):0} y{MM(o2.MinimumPoint.Y):0}..{MM(o2.MaximumPoint.Y):0}; "); top=MM(o2.MinimumPoint.Y)-25; }
 t.Commit();
}catch(Exception e){ if(t.GetStatus()==TransactionStatus.Started) t.RollBack(); log.Append("FAILED "+e.GetType().Name+" "+e.Message+" "+e.StackTrace?.Split('\n').FirstOrDefault()); } }
return log.ToString();
