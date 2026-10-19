bool dry=(string)parameters[0]=="dry"; var log=new StringBuilder(); var fails=new List<string>();
string TX=@"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\07_Materials\Textures\";
AppearanceAssetElement baseAe=null;
foreach(var ae in new FilteredElementCollector(document).OfClass(typeof(AppearanceAssetElement)).Cast<AppearanceAssetElement>()){ try{ var a=ae.GetRenderingAsset(); if(a!=null&&a.FindByName("generic_diffuse")!=null&&a.FindByName("generic_bump_map")!=null){ baseAe=ae; break; } }catch{} }
if(baseAe==null) return "no generic asset";
using(var t=new Transaction(document,"KISIC 13 materials finish pass")){ var fo=t.GetFailureHandlingOptions(); fo.SetFailuresPreprocessor(new FmcFailures()); t.SetFailureHandlingOptions(fo); t.Start();
try{
 Material Find(string n)=>new FilteredElementCollector(document).OfClass(typeof(Material)).Cast<Material>().FirstOrDefault(x=>x.Name==n);
 void Bitmap(AssetPropertyDoubleArray4d prop,string file,double sizeMm){
  if(prop.GetSingleConnectedAsset()!=null) prop.RemoveConnectedAsset();
  prop.AddConnectedAsset("UnifiedBitmapSchema"); var ub=prop.GetSingleConnectedAsset();
  var bp=ub.FindByName(UnifiedBitmap.UnifiedbitmapBitmap) as AssetPropertyString; bp.Value=file;
  foreach(var k in new[]{UnifiedBitmap.TextureRealWorldScaleX,UnifiedBitmap.TextureRealWorldScaleY}){ var d=ub.FindByName(k) as AssetPropertyDistance; if(d!=null) d.Value=UnitUtils.Convert(sizeMm,UnitTypeId.Millimeters,d.GetUnitTypeId()); } }
 Material Mk(string name,Color col,double gloss,string tex,double sizeMm,double bump,double lum=0,double kelvin=0){
  var m=Find(name)??(Material)document.GetElement(Material.Create(document,name));
  m.Color=col; m.UseRenderAppearanceForShading=false;
  var ae=new FilteredElementCollector(document).OfClass(typeof(AppearanceAssetElement)).Cast<AppearanceAssetElement>().FirstOrDefault(x=>x.Name==name+"_KISIC") ?? baseAe.Duplicate(name+"_KISIC");
  m.AppearanceAssetId=ae.Id; document.Regenerate();
  using(var es=new AppearanceAssetEditScope(document)){
   var a=es.Start(ae.Id);
   var d=a.FindByName("generic_diffuse") as AssetPropertyDoubleArray4d; d.SetValueAsColor(col);
   if(tex!=null&&System.IO.File.Exists(TX+tex+"_albedo.jpg")) Bitmap(d,TX+tex+"_albedo.jpg",sizeMm); else if(d.GetSingleConnectedAsset()!=null) d.RemoveConnectedAsset();
   var fade=a.FindByName("generic_diffuse_image_fade") as AssetPropertyDouble; if(fade!=null) fade.Value=1;
   var gl=a.FindByName("generic_glossiness") as AssetPropertyDouble; if(gl!=null) gl.Value=gloss;
   var tr=a.FindByName("generic_transparency") as AssetPropertyDouble; if(tr!=null) tr.Value=0;
   var bm=a.FindByName("generic_bump_map") as AssetPropertyDoubleArray4d; var ba=a.FindByName("generic_bump_amount") as AssetPropertyDouble;
   if(bm!=null){ if(tex!=null&&bump>0&&System.IO.File.Exists(TX+tex+"_bump.jpg")){ Bitmap(bm,TX+tex+"_bump.jpg",sizeMm); if(ba!=null) ba.Value=bump; } else if(bm.GetSingleConnectedAsset()!=null) bm.RemoveConnectedAsset(); }
   var L=a.FindByName("generic_self_illum_luminance") as AssetPropertyDouble; if(L!=null) L.Value=lum;
   var K=a.FindByName("generic_self_illum_color_temperature") as AssetPropertyDouble; if(K!=null&&kelvin>0) K.Value=kelvin;
   es.Commit(true); }
  return m; }
 // --- palette (warm, Ugandan, biophilic)
 var paintIn=Mk("FMC_Paint_Plascon_VinylSilk",new Color(240,234,222),0.15,"FMC_Paint_Plascon_VinylSilk",1000,0.05);
 var paintOut=Mk("FMC_Paint_Plascon_WeatherGuard_Sand",new Color(226,212,186),0.1,"FMC_Finish_Render_External_Painted",1200,0.3);
 var terracotta=Find("FMC_Paint_Plascon_VinylSilk_ClayTerracotta");
 if(terracotta!=null) Mk(terracotta.Name,new Color(176,98,64),0.15,"FMC_Finish_Plaster_Gypsum_Skim",1200,0.15);
 var mvule=Mk("FMC_Timber_Mvule",new Color(128,86,48),0.35,"FMC_Timber_Mvule",800,0.3);
 var mugavu=Mk("FMC_Timber_Mugavu",new Color(110,70,40),0.3,"FMC_Timber_Mugavu",800,0.3);
 var bark=Mk("FMC_Fabric_BarkCloth",new Color(150,92,52),0.05,"FMC_Fabric_BarkCloth",900,0.6);
 var banana=Mk("FMC_Vernacular_BananaFibre",new Color(190,152,100),0.05,"FMC_Vernacular_BananaFibre",400,0.6);
 var kitenge=Mk("FMC_Fabric_Kitenge_Print",new Color(200,120,50),0.05,"FMC_Fabric_Kitenge_Print",500,0);
 var olive=Mk("FMC_Fabric_Linen_Olive",new Color(104,110,74),0.05,"FMC_Fabric_Carpet_Tile",250,0.4);
 var charcoal=Mk("FMC_Paint_Charcoal_Matt",new Color(46,44,41),0.1,null,0,0);
 var soil=Mk("FMC_Plant_Mulch_Bark",new Color(70,48,32),0,"FMC_Plant_Mulch_Bark",500,0.6);
 var leaf=Mk("FMC_Plant_Foliage_Green",new Color(58,104,46),0.35,"FMC_Plant_Hedge_Duranta",600,0.5);
 var terrazzo=Mk("FMC_Finish_Terrazzo_InSitu",new Color(196,190,178),0.45,"FMC_Finish_Terrazzo_InSitu",800,0.1);
 Mk("FMC_Fibre_BananaWoven_Natural",new Color(196,160,112),0.05,"FMC_Vernacular_BananaFibre",300,0.6);
 Mk("FMC_Tile_Porcelain_600",new Color(205,198,186),0.55,"FMC_Tile_Porcelain_600",1200,0.15);
 Mk("FMC_Ceramic_QuarryTile_UC_200",new Color(169,81,47),0.2,"FMC_Ceramic_QuarryTile_UC_200",400,0.4);
 Mk("FMC_Vernacular_Bamboo_Ceiling",new Color(201,166,107),0.15,"FMC_Vernacular_Bamboo_Ceiling",1000,0.5);
 Mk("FMC_Stone_Quartz_Engineered_White",new Color(236,234,230),0.7,"FMC_Stone_Quartz_Engineered_White",800,0.05);
 var led30=Find("FMC_LED_Diffuser_Opal_3000K"); var blk=Find("FMC_Plastic_ABS_Black");
 // --- family type materials that were "none"
 int np=0; void S(string fam,string prm,Material m){ if(m==null) return; foreach(var s in new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().Where(f=>f.FamilyName==fam)){ var p=s.LookupParameter(prm); if(p!=null&&!p.IsReadOnly){ p.Set(m.Id); np++; } } }
 S("FMC_I_Furniture_WallPanel_Slat","Slat Material",mvule); S("FMC_I_Furniture_WallPanel_Slat","Backing Material",charcoal); S("FMC_I_Furniture_WallPanel_Slat","LED Material",led30);
 S("FMC_I_Furniture_Sofa","Upholstery Material",olive); S("FMC_I_Furniture_Sofa","Cushion Material",kitenge); S("FMC_I_Furniture_Sofa","Leg Material",mvule);
 S("FMC_I_Furniture_WallPanel_BarkCloth","Cloth Material",bark); S("FMC_I_Furniture_WallPanel_BarkCloth","Frame Material",mvule);
 S("FMC_I_Furniture_Stool","Timber Material",mugavu);
 S("FMC_I_Furniture_Planter","Pot Material",banana); S("FMC_I_Furniture_Planter","Soil Material",soil); S("FMC_I_Furniture_Planter","Foliage Material",leaf);
 S("FMC_I_Furniture_Bench_Veranda","Seat Material",mvule); S("FMC_I_Furniture_Bench_Veranda","Plinth Material",terrazzo);
 S("FMC_I_Casework_ReceptionDesk","LED Material",led30);
 log.Append("type params "+np+"; ");
 // --- paint every bare wall face: room side -> linen white, outside -> sand WeatherGuard (accent wall + already painted faces kept)
 int pin=0,pout=0;
 foreach(var w in new FilteredElementCollector(document).OfClass(typeof(Wall)).Cast<Wall>().ToList()){
  if((w.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString()??"").ToLower().Contains("fascia")){ foreach(var go in w.get_Geometry(new Options())) if(go is Solid s) foreach(Face f in s.Faces) if(!document.IsPainted(w.Id,f)){ try{document.Paint(w.Id,f,paintIn.Id);pin++;}catch{} } continue; }
  foreach(var go in w.get_Geometry(new Options())) if(go is Solid s) foreach(Face f in s.Faces){
   var pf=f as PlanarFace; if(pf==null||Math.Abs(pf.FaceNormal.Z)>0.1||f.Area<FmcScript.Mm(200)*FmcScript.Mm(200)) continue; if(document.IsPainted(w.Id,f)) continue;
   var bb=f.GetBoundingBox(); var uv=(bb.Min+bb.Max)/2; var c=f.Evaluate(uv); var probe=new XYZ(c.X,c.Y,FmcScript.Mm(1200))+pf.FaceNormal*FmcScript.Mm(300);
   var room=document.GetRoomAtPoint(probe);
   try{ document.Paint(w.Id,f,(room!=null?paintIn:paintOut).Id); if(room!=null) pin++; else pout++; }catch(Exception ex){ fails.Add("paint "+w.Id+": "+ex.Message); } } }
 log.Append("painted inside "+pin+", outside "+pout+(fails.Count>0?"; fails "+string.Join(" | ",fails.Take(5)):""));
 if(dry){t.RollBack(); log.Insert(0,"DRY: ");} else log.Insert(0,"BUILT "+t.Commit()+": ");
}catch(Exception ex){ if(t.GetStatus()==TransactionStatus.Started) t.RollBack(); return "FAILED "+ex.GetType().Name+": "+ex.Message+" | "+log; }
}
return log.ToString();
