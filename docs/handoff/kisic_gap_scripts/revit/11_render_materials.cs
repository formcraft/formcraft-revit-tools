// KISIC step 11 – render materials: emissive LED diffusers/lenses, TV screen, pendant shade, wall-light body; assigns kit family type material params (were "none"). transactionMode "none", usings ["Autodesk.Revit.DB.Visual"], parameters ["dry"|"real"].
// Method: duplicate a Generic AppearanceAssetElement, edit generic_diffuse (remove texture), glossiness, generic_self_illum_luminance (cd/m2), _color_temperature (K), _filter_map, inside AppearanceAssetEditScope (using) inside a using-transaction.
// Values: strips/downlight opal 2500 cd/m2 3000 K; panels/linear 2200 cd/m2 4000 K; wall-light lens 1800 cd/m2 3000 K; X-ray red lens 600; TV screen 120 cd/m2 6500 K; AC LEDs 150.
// Assignments: StripLED Diffuser=FMC_LED_Diffuser_Opal_3000K, Body=Alu anodised; Linear/Panel Diffuser=FMC_LED_Diffuser_Opal_4000K, Panel Frame=ABS white; Pendant Shade=FMC_Fibre_BananaWoven_Natural, Cord=ABS black;
// WallLight Lens=FMC_LED_Lens_Frosted_3000K, Body=FMC_Metal_Aluminium_DieCast_Bronze; Xray_Warning Lens=FMC_LED_Lens_Red_InUse, Body=ABS white; TV Screen=FMC_Glass_TV_Screen_On, Arm=ABS black.
// Code below is the exact run of 19 Oct.
bool dry=(string)parameters[0]=="dry"; var log=new StringBuilder();
AppearanceAssetElement baseAe=null;
foreach(var ae in new FilteredElementCollector(document).OfClass(typeof(AppearanceAssetElement)).Cast<AppearanceAssetElement>()){ try{ var a=ae.GetRenderingAsset(); if(a!=null&&a.FindByName("generic_diffuse")!=null&&a.FindByName("generic_self_illum_luminance")!=null){ baseAe=ae; break; } }catch{} }
if(baseAe==null) return "no generic asset";
using(var t=new Transaction(document,"KISIC render materials")){ t.Start();
try{
 Material Mk(string name,Color col,double lum,double kelvin,double gloss){
  var m=new FilteredElementCollector(document).OfClass(typeof(Material)).Cast<Material>().FirstOrDefault(x=>x.Name==name);
  if(m==null) m=(Material)document.GetElement(Material.Create(document,name));
  m.Color=col;
  var ae=new FilteredElementCollector(document).OfClass(typeof(AppearanceAssetElement)).Cast<AppearanceAssetElement>().FirstOrDefault(x=>x.Name==name+"_App") ?? baseAe.Duplicate(name+"_App");
  m.AppearanceAssetId=ae.Id; document.Regenerate();
  using(var es=new AppearanceAssetEditScope(document)){
   var a=es.Start(ae.Id);
   var d=a.FindByName("generic_diffuse") as AssetPropertyDoubleArray4d; if(d!=null){ if(d.GetSingleConnectedAsset()!=null) d.RemoveConnectedAsset(); d.SetValueAsColor(col); }
   var fade=a.FindByName("generic_diffuse_image_fade") as AssetPropertyDouble; if(fade!=null&&fade.IsValidValue(0)) fade.Value=0;
   var gl=a.FindByName("generic_glossiness") as AssetPropertyDouble; if(gl!=null) gl.Value=gloss;
   var tr=a.FindByName("generic_transparency") as AssetPropertyDouble; if(tr!=null) tr.Value=0;
   var L=a.FindByName("generic_self_illum_luminance") as AssetPropertyDouble; if(L!=null) L.Value=lum;
   var K=a.FindByName("generic_self_illum_color_temperature") as AssetPropertyDouble; if(K!=null&&kelvin>0) K.Value=kelvin;
   var F=a.FindByName("generic_self_illum_filter_map") as AssetPropertyDoubleArray4d; if(F!=null){ if(F.GetSingleConnectedAsset()!=null) F.RemoveConnectedAsset(); F.SetValueAsColor(lum>0?col:new Color(255,255,255)); }
   es.Commit(true); }
  return m; }
 Material Get(string n)=>new FilteredElementCollector(document).OfClass(typeof(Material)).Cast<Material>().First(x=>x.Name==n);
 var led30=Mk("FMC_LED_Diffuser_Opal_3000K",new Color(255,236,205),2500,3000,0.3);
 var led40=Mk("FMC_LED_Diffuser_Opal_4000K",new Color(255,248,235),2200,4000,0.3);
 var lens30=Mk("FMC_LED_Lens_Frosted_3000K",new Color(255,230,190),1800,3000,0.5);
 var red=Mk("FMC_LED_Lens_Red_InUse",new Color(230,30,25),600,0,0.6);
 var tv=Mk("FMC_Glass_TV_Screen_On",new Color(70,110,160),120,6500,0.95);
 var bronze=Mk("FMC_Metal_Aluminium_DieCast_Bronze",new Color(72,58,46),0,0,0.4);
 var fibre=Mk("FMC_Fibre_BananaWoven_Natural",new Color(196,160,112),0,0,0.05);
 Mk("FMC_Plastic_Diffuser_Opal",new Color(255,240,220),2500,3000,0.3);
 Mk("FMC_Plastic_LED_Green",new Color(40,220,90),150,0,0.6); Mk("FMC_Plastic_LED_Blue",new Color(40,120,255),150,0,0.6);
 var alu=Get("FMC_Metal_Aluminium_Anodised_Silver"); var white=Get("FMC_Plastic_ABS_White"); var blk=Get("FMC_Plastic_ABS_Black");
 int n=0;
 void S(string fam,string prm,Material m){ foreach(var s in new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().Where(f=>f.FamilyName==fam)){ var p=s.LookupParameter(prm); if(p!=null&&!p.IsReadOnly){ p.Set(m.Id); n++; } } }
 S("FMC_E_LightFixture_StripLED","Diffuser Material",led30); S("FMC_E_LightFixture_StripLED","Body Material",alu);
 S("FMC_E_LightFixture_Linear_LED","Diffuser Material",led40); S("FMC_E_LightFixture_Linear_LED","Body Material",alu);
 S("FMC_E_LightFixture_Panel_LED","Diffuser Material",led40); S("FMC_E_LightFixture_Panel_LED","Frame Material",white);
 S("FMC_E_LightFixture_Pendant_Woven","Shade Material",fibre); S("FMC_E_LightFixture_Pendant_Woven","Cord Material",blk);
 S("FMC_E_LightFixture_WallLight","Lens Material",lens30); S("FMC_E_LightFixture_WallLight","Body Material",bronze);
 S("FMC_E_LightFixture_Xray_Warning","Lens Material",red); S("FMC_E_LightFixture_Xray_Warning","Body Material",white);
 S("FMC_E_ICT_TV_WallArm","Screen Material",tv); S("FMC_E_ICT_TV_WallArm","Arm Material",blk);
 log.Append("materials set on "+n+" type params");
 if(dry){t.RollBack(); log.Insert(0,"DRY: ");} else log.Insert(0,"BUILT "+t.Commit()+": ");
}catch(Exception ex){ if(t.GetStatus()==TransactionStatus.Started) t.RollBack(); return "FAILED "+ex.GetType().Name+": "+ex.Message+" | "+log; }
}
return log.ToString();
