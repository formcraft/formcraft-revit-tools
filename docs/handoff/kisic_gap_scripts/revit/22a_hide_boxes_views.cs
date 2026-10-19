// KISIC 22a - hide clearance / coarse-envelope / connector-pad / light-source subcategories in every plan, RCP, 3D, elevation, section and legend view
// (applied to the view template when a view has one). NOTE: legend views ignore this for legend components -> family fix in 23.
var sb=new StringBuilder(); var bad=new List<Category>();
foreach(Category c in document.Settings.Categories) foreach(Category s in c.SubCategories){ var nm=s.Name.ToLower(); if(nm.Contains("clearance")||nm.Contains("envelope")||nm.Contains("connector pad")||nm.Contains("service zone")||nm.Contains("swing zone")) bad.Add(s); }
var ls=Category.GetCategory(document,BuiltInCategory.OST_LightingFixtureSource); if(ls!=null) bad.Add(ls);
var views=new FilteredElementCollector(document).OfClass(typeof(View)).Cast<View>().Where(v=>!v.IsTemplate&&(v.ViewType==ViewType.Legend||v.ViewType==ViewType.FloorPlan||v.ViewType==ViewType.CeilingPlan||v.ViewType==ViewType.ThreeD||v.ViewType==ViewType.Elevation||v.ViewType==ViewType.Section)).ToList();
int cnt=0;
FmcScript.Run(document,"KISIC hide clearance/envelope boxes",()=>{ foreach(var v in views){ View tv=v.ViewTemplateId!=ElementId.InvalidElementId?document.GetElement(v.ViewTemplateId) as View:v;
  foreach(var s in bad){ try{ if(tv.CanCategoryBeHidden(s.Id)&&!tv.GetCategoryHidden(s.Id)){ tv.SetCategoryHidden(s.Id,true); cnt++; } }catch{} } } });
return "hidden "+cnt+" view/subcategory pairs in "+views.Count+" views";
