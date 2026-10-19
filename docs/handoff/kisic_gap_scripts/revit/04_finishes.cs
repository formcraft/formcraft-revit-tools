// KISIC step 04 – finishes (L1). Three parts, run in order:
//  (a) fmc_material assign (plugin, brings kit materials with textures):
//      Ceilings rule "Gypsum 9" -> FMC_Paint_Plascon_VinylSilk ; Ceilings rule "Bamboo" -> FMC_Vernacular_Bamboo_Ceiling ; Walls rule "Soffit" -> FMC_Paint_Plascon_VinylSilk
//      Floors rule "Porcelain"/"Quarry" -> FMC_Tile_Porcelain_600 / FMC_Ceramic_QuarryTile_UC_200 (creates the materials; the single-layer types report "no finish layer", part c sets them)
//  (b) finish floors (this script, part B) ; (c) layer materials + wall paint + colours (part C).
// transactionMode "none", usings ["Autodesk.Revit.DB.Architecture","Autodesk.Revit.DB.Visual"]
var log=new StringBuilder();
var L0=new FilteredElementCollector(document).OfClass(typeof(Level)).Cast<Level>().First(l=>l.Name=="L00 FFL");
Func<double,double,XYZ> P=(x,y)=>FmcScript.PointMm(x*1000,-y*1000,0);
Material M(string n)=>new FilteredElementCollector(document).OfClass(typeof(Material)).Cast<Material>().FirstOrDefault(m=>m.Name==n);
using(var t=new Transaction(document,"KISIC finishes")){ var fo=t.GetFailureHandlingOptions(); fo.SetFailuresPreprocessor(new FmcFailures()); t.SetFailureHandlingOptions(fo); t.Start();
try{
 // B: finish floor types + floors
 var src=new FilteredElementCollector(document).OfClass(typeof(FloorType)).Cast<FloorType>().First(f=>f.Name=="Concrete 100mm");
 FloorType FT(string n,double mm){ var f=new FilteredElementCollector(document).OfClass(typeof(FloorType)).Cast<FloorType>().FirstOrDefault(x=>x.Name==n); if(f!=null) return f;
  f=(FloorType)src.Duplicate(n); var cs=src.GetCompoundStructure(); cs.SetLayers(new List<CompoundStructureLayer>{ new CompoundStructureLayer(FmcScript.Mm(mm),MaterialFunctionAssignment.Structure,ElementId.InvalidElementId) }); cs.StructuralMaterialIndex=0; f.SetCompoundStructure(cs); return f; }
 var tileT=FT("FMC Finish - Porcelain 600 warm grey 10",10); var quarryT=FT("FMC Finish - Quarry tile UC 200 terracotta 15",15);
 var opt=new SpatialElementBoundaryOptions{SpatialElementBoundaryLocation=SpatialElementBoundaryLocation.Finish};
 foreach(Room r in new FilteredElementCollector(document).OfCategory(BuiltInCategory.OST_Rooms)){ var cl=new CurveLoop(); foreach(var bs in r.GetBoundarySegments(opt)[0]) cl.Append(bs.GetCurve());
  var f=Floor.Create(document,new List<CurveLoop>{cl},tileT.Id,L0.Id); f.get_Parameter(BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM).Set(FmcScript.Mm(10)); f.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("Finish floor "+r.Number); }
 var ver=new CurveLoop(); var v=new[]{new[]{-0.15,6.85},new[]{9.75,6.85},new[]{9.92,8.25},new[]{-0.15,8.25}}; for(int i=0;i<4;i++) ver.Append(Line.CreateBound(P(v[i][0],v[i][1]),P(v[(i+1)%4][0],v[(i+1)%4][1])));
 var fv=Floor.Create(document,new List<CurveLoop>{ver},quarryT.Id,L0.Id); fv.get_Parameter(BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM).Set(FmcScript.Mm(-35)); fv.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set("Finish floor veranda");
 // C: layer materials, terracotta paint, wall paint
 var paint=M("FMC_Paint_Plascon_VinylSilk"); var tile=M("FMC_Tile_Porcelain_600"); var quarry=M("FMC_Ceramic_QuarryTile_UC_200");
 foreach(var pair in new[]{(tileT,tile),(quarryT,quarry)}) if(pair.Item2!=null){ var cs=pair.Item1.GetCompoundStructure(); cs.SetMaterialId(0,pair.Item2.Id); pair.Item1.SetCompoundStructure(cs); }
 var terra=M("FMC_Paint_Plascon_VinylSilk_ClayTerracotta");
 if(terra==null && paint!=null){ terra=paint.Duplicate("FMC_Paint_Plascon_VinylSilk_ClayTerracotta"); terra.Color=new Color(181,101,62);
  if(paint.AppearanceAssetId!=ElementId.InvalidElementId){ var ae=((AppearanceAssetElement)document.GetElement(paint.AppearanceAssetId)).Duplicate("FMC Clay Terracotta asset"); terra.AppearanceAssetId=ae.Id; document.Regenerate();
   using(var es=new AppearanceAssetEditScope(document)){ var a=es.Start(ae.Id); var dif=a.FindByName("generic_diffuse") as AssetPropertyDoubleArray4d; if(dif!=null&&dif.IsEditable()) dif.SetValueAsColor(new Color(181,101,62)); var fd=a.FindByName("generic_diffuse_image_fade") as AssetPropertyDouble; if(fd!=null&&fd.IsEditable()) fd.Value=0; es.Commit(true);} } }
 if(paint!=null){ paint.Color=new Color(243,238,230); using(var es=new AppearanceAssetEditScope(document)){ var a=es.Start(paint.AppearanceAssetId); var dif=a.FindByName("generic_diffuse") as AssetPropertyDoubleArray4d; if(dif!=null&&dif.IsEditable()) dif.SetValueAsColor(new Color(243,238,230)); var fd=a.FindByName("generic_diffuse_image_fade") as AssetPropertyDouble; if(fd!=null&&fd.IsEditable()) fd.Value=0; es.Commit(true);} }
 int pf=0; foreach(Wall w in new FilteredElementCollector(document).OfClass(typeof(Wall))){ var id=w.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).AsString()??""; if(!id.StartsWith("W-")) continue;
  foreach(var side in new[]{ShellLayerType.Interior,ShellLayerType.Exterior}) foreach(var r in HostObjectUtils.GetSideFaces(w,side)){ var f=w.GetGeometryObjectFromReference(r) as Face; if(f==null) continue;
   var mat=paint; if(id=="W-SCN-S" && f is PlanarFace pfc && pfc.FaceNormal.Y<-0.5) mat=terra; if(mat!=null && !document.IsPainted(w.Id,f)){ document.Paint(w.Id,f,mat.Id); pf++; } } }
 log.Append("finish floors + paint "+pf+" faces");
 log.Insert(0,"BUILT "+t.Commit()+": ");
}catch(Exception ex){ if(t.GetStatus()==TransactionStatus.Started) t.RollBack(); return "FAILED "+ex.GetType().Name+": "+ex.Message+" | "+log; }
}
return log.ToString();
