bool dry=(string)parameters[0]=="dry"; var log=new StringBuilder();
Func<double,double,double,XYZ> P=(x,y,z)=>FmcScript.PointMm(x*1000,-y*1000,z);
double M(double mm)=>FmcScript.Mm(mm);
using(var t=new Transaction(document,"KISIC 17 power plan E-PP-01")){ var fo=t.GetFailureHandlingOptions(); fo.SetFailuresPreprocessor(new FmcFailures()); t.SetFailureHandlingOptions(fo); t.Start();
try{
 var L0=new FilteredElementCollector(document).OfClass(typeof(Level)).Cast<Level>().First(l=>l.Name=="L00 FFL");
 var old=new FilteredElementCollector(document).OfClass(typeof(ViewPlan)).Cast<ViewPlan>().FirstOrDefault(v=>!v.IsTemplate&&v.Name=="E-PP-01 Power Plan L00"); if(old!=null) document.Delete(old.Id);
 var vft=new FilteredElementCollector(document).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().First(x=>x.ViewFamily==ViewFamily.FloorPlan);
 var v=ViewPlan.Create(document,vft.Id,L0.Id); v.Name="E-PP-01 Power Plan L00"; v.ViewTemplateId=ElementId.InvalidElementId; v.Scale=25; v.DetailLevel=ViewDetailLevel.Medium;
 v.get_Parameter(BuiltInParameter.VIEW_DISCIPLINE)?.Set(8);
 var vr=v.GetViewRange(); vr.SetOffset(PlanViewPlane.TopClipPlane,M(3000)); vr.SetOffset(PlanViewPlane.CutPlane,M(2600)); vr.SetOffset(PlanViewPlane.BottomClipPlane,0); vr.SetOffset(PlanViewPlane.ViewDepthPlane,0); v.SetViewRange(vr);
 var lp=new FilteredElementCollector(document).OfClass(typeof(ViewPlan)).Cast<ViewPlan>().First(x=>x.Name=="E-LP-01 Lighting Plan L00");
 v.CropBoxActive=true; v.CropBox=lp.CropBox; v.CropBoxVisible=false; v.get_Parameter(BuiltInParameter.VIEWER_ANNOTATION_CROP_ACTIVE)?.Set(1);
 void Hide(BuiltInCategory c){ var cat=Category.GetCategory(document,c); if(cat!=null&&v.CanCategoryBeHidden(cat.Id)) v.SetCategoryHidden(cat.Id,true); }
 foreach(var c in new[]{BuiltInCategory.OST_LightingFixtures,BuiltInCategory.OST_LightingDevices,BuiltInCategory.OST_Ceilings,BuiltInCategory.OST_PipeCurves,BuiltInCategory.OST_PipeFitting,BuiltInCategory.OST_SpecialityEquipment,BuiltInCategory.OST_Cameras,BuiltInCategory.OST_Elev,BuiltInCategory.OST_Sections,BuiltInCategory.OST_CLines}) Hide(c);
 var half=new OverrideGraphicSettings(); half.SetHalftone(true);
 foreach(var c in new[]{BuiltInCategory.OST_Furniture,BuiltInCategory.OST_Casework,BuiltInCategory.OST_PlumbingFixtures,BuiltInCategory.OST_MedicalEquipment,BuiltInCategory.OST_Walls,BuiltInCategory.OST_Doors,BuiltInCategory.OST_Floors}){ var cat=Category.GetCategory(document,c); if(cat!=null) v.SetCategoryOverrides(cat.Id,half); }
 foreach(var sc in Category.GetCategory(document,BuiltInCategory.OST_Furniture).SubCategories.Cast<Category>()) if(sc.Name.ToLower().Contains("plant")) v.SetCategoryHidden(sc.Id,true);
 foreach(var cc in new[]{BuiltInCategory.OST_MechanicalEquipment,BuiltInCategory.OST_ElectricalFixtures,BuiltInCategory.OST_ElectricalEquipment,BuiltInCategory.OST_DataDevices,BuiltInCategory.OST_PlumbingEquipment,BuiltInCategory.OST_CommunicationDevices,BuiltInCategory.OST_Furniture,BuiltInCategory.OST_LightingFixtures})
  foreach(var sc in Category.GetCategory(document,cc).SubCategories.Cast<Category>()) if(sc.Name.StartsWith("Clearance")) v.SetCategoryHidden(sc.Id,true);
 document.Regenerate();
 // ---- devices by circuit
 var col=new Dictionary<string,Color>{{"P5",new Color(0,140,140)},{"P6",new Color(20,150,60)},{"P7",new Color(240,130,0)},{"P9",new Color(200,0,160)},{"P10",new Color(150,60,200)},{"P11",new Color(90,60,160)},{"P12",new Color(0,90,200)},
  {"P13",new Color(0,170,230)},{"P14",new Color(0,170,230)},{"P15",new Color(0,170,230)},{"P17",new Color(210,30,40)},{"P18",new Color(210,30,40)},{"P19",new Color(210,30,40)},{"P2",new Color(120,120,120)},{"P3",new Color(120,120,120)},{"data",new Color(90,90,90)},{"main",new Color(0,0,0)}};
 var solid=new FilteredElementCollector(document).OfClass(typeof(FillPatternElement)).Cast<FillPatternElement>().First(p=>p.GetFillPattern().IsSolidFill);
 var dash=new FilteredElementCollector(document).OfClass(typeof(LinePatternElement)).Cast<LinePatternElement>().FirstOrDefault(p=>p.Name.ToLower().StartsWith("dash"));
 var cats=new List<BuiltInCategory>{BuiltInCategory.OST_ElectricalFixtures,BuiltInCategory.OST_ElectricalEquipment,BuiltInCategory.OST_DataDevices,BuiltInCategory.OST_MechanicalEquipment,BuiltInCategory.OST_PlumbingEquipment,BuiltInCategory.OST_CommunicationDevices};
 var devs=new FilteredElementCollector(document).WherePasses(new ElementMulticategoryFilter(cats)).WhereElementIsNotElementType().OfType<FamilyInstance>().Where(f=>!(f.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString()??"").StartsWith("ACO")).ToList();
 string Circ(FamilyInstance f){ var c=f.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString()??""; int i=c.IndexOf("circuit "); if(i>=0) return c.Substring(i+8).Split(' ')[0]; var m=f.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString()??""; if(m=="DB-1") return "main"; if(m.StartsWith("TV")) return "P5"; return "?"; }
 var tts=new FilteredElementCollector(document).OfClass(typeof(TextNoteType)).Cast<TextNoteType>().ToList(); var tB=tts.First(x=>x.Name=="FMC 2.5 Bold"); var tN=tts.FirstOrDefault(x=>x.Name.Contains("2.5")&&x.Id!=tB.Id&&!x.Name.Contains("Bold"))??tts.First(x=>x.Id!=tB.Id&&x.Name!="FMC 5 Bold");
 // label: inward from the wall, leader back to the device; stagger devices that sit close together
 var placed=new List<XYZ>(); int nl=0;
 XYZ Inward(XYZ p){ foreach(var d in new[]{XYZ.BasisX,-XYZ.BasisX,XYZ.BasisY,-XYZ.BasisY}){ var q=p+d*M(350); if(document.GetRoomAtPoint(new XYZ(q.X,q.Y,M(1000)))!=null&&document.GetRoomAtPoint(new XYZ((p-d*M(350)).X,(p-d*M(350)).Y,M(1000)))==null) return d; } foreach(var d in new[]{XYZ.BasisX,-XYZ.BasisX,XYZ.BasisY,-XYZ.BasisY}){ var q=p+d*M(350); if(document.GetRoomAtPoint(new XYZ(q.X,q.Y,M(1000)))!=null) return d; } return XYZ.BasisY; }
 foreach(var f in devs){ var c=Circ(f); var cc=col.ContainsKey(c)?col[c]:new Color(0,0,0);
  var o=new OverrideGraphicSettings(); o.SetProjectionLineColor(cc); o.SetSurfaceForegroundPatternId(solid.Id); o.SetSurfaceForegroundPatternColor(cc); o.SetProjectionLineWeight(4); v.SetElementOverrides(f.Id,o);
  var p=((LocationPoint)f.Location).Point; var h=Math.Round(FmcScript.ToMm(p.Z)); var mk=f.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString()??"";
  var d=Inward(new XYZ(p.X,p.Y,0)); var along=new XYZ(-d.Y,d.X,0); int crowd=placed.Count(q=>q.DistanceTo(new XYZ(p.X,p.Y,0))<M(700));
  var at=new XYZ(p.X,p.Y,0)+d*M(650+ (crowd%2)*350)+along*M((crowd/2)*450*(crowd%4<2?1:-1)); placed.Add(new XYZ(p.X,p.Y,0));
  string txt=mk+" · "+(c=="main"?"DB":c)+(h>50&&c!="main"?" · "+h:""); if(f.Category.Id.Value==(long)BuiltInCategory.OST_PlumbingEquipment) txt+=" · DP isol."; if(mk.StartsWith("AC-")) txt+=" · isol.";
  var tn=TextNote.Create(document,v.Id,at,txt,c=="main"?tB.Id:tN.Id); var ld=tn.AddLeader(TextNoteLeaderTypes.TNLT_STRAIGHT_L); ld.End=new XYZ(p.X,p.Y,0); nl++; }
 // ---- home runs: chain each circuit's devices (arcs), arrow + label from the nearest device towards DB-1
 var db=devs.First(f=>Circ(f)=="main"); var dbp=((LocationPoint)db.Location).Point; dbp=new XYZ(dbp.X,dbp.Y,0);
 int na=0;
 foreach(var g in devs.Where(f=>Circ(f)!="main"&&Circ(f)!="?").GroupBy(f=>Circ(f))){
  var pts=g.Select(f=>{ var q=((LocationPoint)f.Location).Point; return new XYZ(q.X,q.Y,0); }).ToList();
  var chain=new List<XYZ>(); var cur=pts.OrderBy(q=>q.DistanceTo(dbp)).First(); chain.Add(cur); pts.Remove(cur);
  while(pts.Count>0){ var nx=pts.OrderBy(q=>q.DistanceTo(cur)).First(); chain.Add(nx); pts.Remove(nx); cur=nx; }
  var cc=col.ContainsKey(g.Key)?col[g.Key]:new Color(0,0,0); var lo=new OverrideGraphicSettings(); lo.SetProjectionLineColor(cc); lo.SetProjectionLineWeight(g.Key=="data"?2:3); if(g.Key=="data"&&dash!=null) lo.SetProjectionLinePatternId(dash.Id);
  void Curve(XYZ a,XYZ b){ if(a.DistanceTo(b)<M(150)) return; var mid=(a+b)/2; var n=new XYZ(-(b-a).Normalize().Y,(b-a).Normalize().X,0); var bulge=Math.Min(M(400),a.DistanceTo(b)*0.18); var dc=document.Create.NewDetailCurve(v,Arc.Create(a,b,mid+n*bulge)); v.SetElementOverrides(dc.Id,lo); na++; }
  for(int i=0;i<chain.Count-1;i++) Curve(chain[i],chain[i+1]);
  // home run arrow 600 long from the first device towards DB
  var a0=chain[0]; var dir=(dbp-a0); if(dir.GetLength()>M(800)){ dir=dir.Normalize(); var tip=a0+dir*M(600); var l1=document.Create.NewDetailCurve(v,Line.CreateBound(a0,tip)); v.SetElementOverrides(l1.Id,lo);
   var side=new XYZ(-dir.Y,dir.X,0); foreach(var s in new[]{1,-1}){ var w=document.Create.NewDetailCurve(v,Line.CreateBound(tip,tip-dir*M(130)+side*M(70)*s)); v.SetElementOverrides(w.Id,lo); }
   TextNote.Create(document,v.Id,tip+dir*M(120),g.Key=="data"?"to rack":"DB-1/"+g.Key,tB.Id); }
 }
 // room tags
 var rtt=new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).OfCategory(BuiltInCategory.OST_RoomTags).FirstElementId();
 foreach(var r in new FilteredElementCollector(document).OfCategory(BuiltInCategory.OST_Rooms).Cast<SpatialElement>()){ var lpnt=(r.Location as LocationPoint)?.Point; if(lpnt!=null) document.Create.NewRoomTag(new LinkElementId(r.Id),new UV(lpnt.X,lpnt.Y),v.Id); }
 log.Append("view "+v.Id+", devices "+devs.Count+", labels "+nl+", home-run curves "+na);
 if(dry){t.RollBack(); log.Insert(0,"DRY: ");} else log.Insert(0,"BUILT "+t.Commit()+": ");
}catch(Exception ex){ if(t.GetStatus()==TransactionStatus.Started) t.RollBack(); return "FAILED "+ex.GetType().Name+": "+ex.Message+" | "+log; }
}
return log.ToString();
