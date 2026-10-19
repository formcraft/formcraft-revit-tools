// KISIC 20b - lobby general light = ceiling fan FAN-1 with LED light kit FL1 (replaces the centre pendant), colour-swatch circuit keys on E-1101 / E-1001.
var log=new StringBuilder(); double M(double mm)=>FmcScript.Mm(mm); Func<double,double,double,XYZ> P=(x,y,z)=>FmcScript.PointMm(x*1000,-y*1000,z);
string Cm(Element e)=>e.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString()??"";
var lp=(View)document.GetElement(new ElementId(1697159L));
using(var t=new Transaction(document,"KISIC 20b fan + circuit keys")){ var fo=t.GetFailureHandlingOptions(); fo.SetFailuresPreprocessor(new FmcFailures()); t.SetFailureHandlingOptions(fo); t.Start();
try{
 // ---- 1 FAN-1 at the centre general-light position (where the pendant is)
 var pend=document.GetElement(new ElementId(1698489L)) as FamilyInstance; var cpt=pend!=null?((LocationPoint)pend.Location).Point:P(7.28,4.67,3000);
 double cx=FmcScript.ToMm(cpt.X)/1000, cy=-FmcScript.ToMm(cpt.Y)/1000;
 var ceil=(Ceiling)document.GetElement(new ElementId(1698461L)); Reference cref=null; double cz=0;
 foreach(var rf in HostObjectUtils.GetBottomFaces(ceil)){ var f=ceil.GetGeometryObjectFromReference(rf) as PlanarFace; if(f!=null){ cref=rf; cz=f.Origin.Z; } }
 foreach(var old in new FilteredElementCollector(document).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>().Where(f=>f.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString()=="FAN-1").Select(f=>f.Id).ToList()) document.Delete(old);
 var fs=new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().First(s=>s.FamilyName=="FMC_M_MechEq_CeilingFan"&&s.Name=="1400_3Blade"); if(!fs.IsActive) fs.Activate();
 var fan=document.Create.NewFamilyInstance(cref,new XYZ(cpt.X,cpt.Y,cz),XYZ.BasisX,fs);
 fan.get_Parameter(BuiltInParameter.ALL_MODEL_MARK).Set("FAN-1"); fan.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("FAN-1 ceiling fan 1400 with LED light kit FL1 (lobby general light) · motor on SW-L2 regulator, light kit on L1 · circuit P1");
 document.Regenerate();
 double bottom=double.MaxValue; var opt=new Options{DetailLevel=ViewDetailLevel.Fine};
 foreach(var go in fan.get_Geometry(opt)){ var gi=go as GeometryInstance; if(gi==null) continue; foreach(var g in gi.GetInstanceGeometry()){ var so=g as Solid; if(so==null||so.Volume<=0) continue; var gs=document.GetElement(so.GraphicsStyleId) as GraphicsStyle; var gn=gs?.GraphicsStyleCategory?.Name??"";
   if(gn.Contains("Clearance")||gn.Contains("Envelope")||gn.Contains("Connector")) continue; var bb=so.GetBoundingBox(); var z0=Math.Min(bb.Transform.OfPoint(bb.Min).Z,bb.Transform.OfPoint(bb.Max).Z); if(z0<bottom) bottom=z0; } }
 log.Append($"fan at ({cx:0.00},{cy:0.00}) bottom {FmcScript.ToMm(bottom):0}; ");
 // light kit: duplicate the 200 downlight as FL1, on a downward plane at the motor bottom
 var d200=new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().First(s=>s.FamilyName=="FMC_E_LightFixture_Downlight_LED"&&s.Name=="200_Downlight");
 var kitT=new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().FirstOrDefault(s=>s.FamilyName=="FMC_E_LightFixture_Downlight_LED"&&s.Name=="200_FanLightKit_18W_3000K")??(FamilySymbol)d200.Duplicate("200_FanLightKit_18W_3000K");
 if(!kitT.IsActive) kitT.Activate(); kitT.get_Parameter(BuiltInParameter.ALL_MODEL_TYPE_MARK).Set("FL1"); kitT.get_Parameter(BuiltInParameter.ALL_MODEL_DESCRIPTION)?.Set("LED light kit on ceiling fan FAN-1, 18 W, 3000 K, opal bowl (lobby general light)");
 foreach(var old in new FilteredElementCollector(document).OfClass(typeof(ReferencePlane)).Cast<ReferencePlane>().Where(r=>r.Name=="KISIC FAN-1 light kit").Select(r=>r.Id).ToList()) document.Delete(old);
 var v3d=new FilteredElementCollector(document).OfClass(typeof(View3D)).Cast<View3D>().First(v=>!v.IsTemplate);
 double zb=bottom<double.MaxValue?bottom:M(2600);
 var rp=document.Create.NewReferencePlane(new XYZ(cpt.X+1,cpt.Y,zb),new XYZ(cpt.X,cpt.Y,zb),new XYZ(0,1,0),v3d); if(rp.Normal.Z>0){ document.Delete(rp.Id); rp=document.Create.NewReferencePlane(new XYZ(cpt.X,cpt.Y,zb),new XYZ(cpt.X+1,cpt.Y,zb),new XYZ(0,1,0),v3d); }
 rp.Name="KISIC FAN-1 light kit";
 var kit=document.Create.NewFamilyInstance(rp.GetReference(),new XYZ(cpt.X,cpt.Y,zb),XYZ.BasisX,kitT);
 kit.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("L1 fan light kit FL1 on FAN-1 (lobby general light)"); kit.LookupParameter("FMC Switch")?.Set("L1");
 lp.SetElementOverrides(kit.Id,lp.GetElementOverrides(new ElementId(1698491L)));
 // remove the centre pendant and the old stand-alone fan-light downlight
 if(pend!=null) document.Delete(pend.Id); var oldKit=document.GetElement(new ElementId(1698491L)); if(oldKit!=null) document.Delete(oldKit.Id);
 foreach(var tn in new FilteredElementCollector(document,lp.Id).OfClass(typeof(TextNote)).Cast<TextNote>()){ if(tn.Text.StartsWith("FAN")){ tn.Text="FAN-1 1400 (L2) + LIGHT KIT FL1 (L1)"; tn.Coord=P(cx+0.35,cy+0.75,0); } }
 // ---- 2 colour-swatch keys
 var solid=new FilteredElementCollector(document).OfClass(typeof(FillPatternElement)).Cast<FillPatternElement>().First(f=>f.GetFillPattern().IsSolidFill);
 var frt0=new FilteredElementCollector(document).OfClass(typeof(FilledRegionType)).Cast<FilledRegionType>().First();
 var tts=new FilteredElementCollector(document).OfClass(typeof(TextNoteType)).Cast<TextNoteType>().ToList(); var tB=tts.First(x=>x.Name=="FMC 2.5 Bold"); var tN=tts.FirstOrDefault(x=>x.Name.Contains("2.5")&&!x.Name.Contains("Bold"))??tB;
 FilledRegionType FR(string nm,int r,int g,int b){ var n="FMC Key "+nm; var ex=new FilteredElementCollector(document).OfClass(typeof(FilledRegionType)).Cast<FilledRegionType>().FirstOrDefault(x=>x.Name==n); var ft=ex??(FilledRegionType)frt0.Duplicate(n);
  ft.ForegroundPatternId=solid.Id; ft.ForegroundPatternColor=new Color((byte)r,(byte)g,(byte)b); ft.BackgroundPatternId=ElementId.InvalidElementId; return ft; }
 var vft=new FilteredElementCollector(document).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().First(x=>x.ViewFamily==ViewFamily.Drafting);
 View Key(string name,string title,(string code,int r,int g,int b,string txt)[] rows,int perCol){
  foreach(var old in new FilteredElementCollector(document).OfClass(typeof(ViewDrafting)).Cast<View>().Where(v=>v.Name==name).Select(v=>v.Id).ToList()) document.Delete(old);
  var kv=ViewDrafting.Create(document,vft.Id); kv.Name=name; kv.Scale=1;
  TextNote.Create(document,kv.Id,new XYZ(0,M(8),0),title,tB.Id);
  for(int i=0;i<rows.Length;i++){ var rw=rows[i]; int col=i/perCol, row=i%perCol; double x0=col*95, y0=-row*8;
   var lpL=new CurveLoop(); var a=new XYZ(M(x0),M(y0),0); var b=new XYZ(M(x0+12),M(y0),0); var c=new XYZ(M(x0+12),M(y0-5),0); var d=new XYZ(M(x0),M(y0-5),0);
   lpL.Append(Line.CreateBound(a,b)); lpL.Append(Line.CreateBound(b,c)); lpL.Append(Line.CreateBound(c,d)); lpL.Append(Line.CreateBound(d,a));
   FilledRegion.Create(document,FR(rw.code,rw.r,rw.g,rw.b).Id,kv.Id,new List<CurveLoop>{lpL});
   var tn=TextNote.Create(document,kv.Id,new XYZ(M(x0+15),M(y0+0.3),0),rw.code+"  "+rw.txt,tN.Id); tn.Width=M(78); }
  return kv; }
 var kL=Key("E-KEY-01 Lighting circuit key","LIGHTING CIRCUITS (colour key)",new[]{("P1",0,90,200,"waiting area, reception, fan light"),("P2",210,30,40,"X-ray, Control, Scan, X-ray lobby"),("P3",20,150,60,"Laboratory"),("P4",240,130,0,"veranda + SIGN-1 (RCD 30 mA)"),("P8",140,40,170,"X-ray in-use light (interlock)")},5);
 var kP=Key("E-KEY-02 Power circuit key","POWER CIRCUITS (colour key)",new[]{("P5",0,140,140,"general sockets: lobby, TV, X-ray, Scan"),("P6",20,150,60,"Lab bench sockets"),("P7",240,130,0,"veranda socket IP66 (RCD)"),("P9",200,0,160,"ultrasound (dedicated, UPS)"),("P10",150,60,200,"Lab analyser (dedicated, UPS)"),("P11",90,60,160,"Lab fridge (unswitched FCU)"),("P12",0,90,200,"reception + control console (IT)"),
  ("P13-15",0,170,230,"AC indoor units + roof isolators"),("P17-19",210,30,40,"instant water heaters, 20 A DP"),("P2/P3",120,120,120,"extract fans (FCU + isolator)"),("XR",230,0,0,"X-ray sub-main, 63 A TP+N isolator"),("Data",90,90,90,"Cat6 home-runs to the 6U rack"),("MET",0,130,0,"main earth / bonding (SEB)")},7);
 document.Regenerate();
 void PutKey(long sheetId,View v,double left,double top){ var vp=Viewport.Create(document,new ElementId(sheetId),v.Id,new XYZ(M(500),M(400),0)); document.Regenerate(); var o=vp.GetBoxOutline(); vp.SetBoxCenter(vp.GetBoxCenter()+new XYZ(M(left)-o.MinimumPoint.X,M(top)-o.MaximumPoint.Y,0));
  var noTitle=new FilteredElementCollector(document).OfClass(typeof(ElementType)).Cast<ElementType>().FirstOrDefault(x=>x.FamilyName=="Viewport"&&x.Name.ToLower().Contains("no title")); if(noTitle!=null) vp.ChangeTypeId(noTitle.Id); }
 PutKey(1698381,kL,965,330); PutKey(1699398,kP,640,440);
 log.Append("keys placed; ");
 t.Commit();
}catch(Exception e){ if(t.GetStatus()==TransactionStatus.Started) t.RollBack(); log.Append("FAILED "+e.GetType().Name+" "+e.Message+" @"+e.StackTrace?.Split('\n').FirstOrDefault()); } }
return log.ToString();
