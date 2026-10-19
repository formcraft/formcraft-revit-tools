// KISIC 23 (NOT RUN - stopped by the owner before it ran; prototype for a kit rule / fmc_family action)
// For every FMC family used in the model or in a legend: Coarse Envelope solids -> Coarse only; Clearance* and Connector Pads solids -> 3D only
// (not shown in plan/RCP, front/back, left/right). Then reload into the project. Also shortens the downlight light-source symbol (3048 mm drew a 10 m box).
// transactionMode "none" (EditFamily needs no open project transaction).
var log=new StringBuilder();
var used=new HashSet<long>(); foreach(FamilyInstance f in new FilteredElementCollector(document).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>()) used.Add(f.Symbol.Family.Id.Value);
foreach(var lc in new FilteredElementCollector(document).OfCategory(BuiltInCategory.OST_LegendComponents).WhereElementIsNotElementType()){ var s=document.GetElement(lc.get_Parameter(BuiltInParameter.LEGEND_COMPONENT)?.AsElementId()??ElementId.InvalidElementId) as FamilySymbol; if(s!=null) used.Add(s.Family.Id.Value); }
var fams=used.Select(i=>document.GetElement(new ElementId(i)) as Family).Where(f=>f!=null&&f.Name.StartsWith("FMC_")&&f.IsEditable).OrderBy(f=>f.Name).ToList();
int famFixed=0;
foreach(var fam in fams){
 Document fd=null; try{ fd=document.EditFamily(fam); int n=0;
  using(var t=new Transaction(fd,"KISIC hide boxes")){ t.Start();
   foreach(var el in new FilteredElementCollector(fd).WhereElementIsNotElementType().Where(e=>e is GenericForm||e is FreeFormElement)){
    var sc=(el as GenericForm)?.Subcategory ?? (el as FreeFormElement)?.Subcategory; var lnm=(sc?.Name??"").ToLower(); if(lnm=="") continue;
    var gf=el as GenericForm; var ff=el as FreeFormElement; FamilyElementVisibility cur=gf!=null?gf.GetVisibility():ff?.GetVisibility(); if(cur==null) continue;
    FamilyElementVisibility v=null;
    if(lnm.Contains("coarse envelope")) v=new FamilyElementVisibility(FamilyElementVisibilityType.Model){IsShownInCoarse=true,IsShownInMedium=false,IsShownInFine=false,IsShownInFrontBack=cur.IsShownInFrontBack,IsShownInLeftRight=cur.IsShownInLeftRight,IsShownInPlanRCPCut=cur.IsShownInPlanRCPCut,IsShownInTopBottom=cur.IsShownInTopBottom};
    else if(lnm.Contains("clearance")||lnm.Contains("connector pad")) v=new FamilyElementVisibility(FamilyElementVisibilityType.Model){IsShownInCoarse=cur.IsShownInCoarse,IsShownInMedium=cur.IsShownInMedium,IsShownInFine=cur.IsShownInFine,IsShownInFrontBack=false,IsShownInLeftRight=false,IsShownInPlanRCPCut=false,IsShownInTopBottom=false};
    if(v==null) continue; if(gf!=null) gf.SetVisibility(v); else ff.SetVisibility(v); n++; }
   t.Commit(); }
  if(n>0){ fd.LoadFamily(document); famFixed++; log.Append($"{fam.Name}:{n}; "); }
 }catch(Exception e){ log.Append($"{fam.Name} ERR {e.Message}; "); } finally{ fd?.Close(false); } }
FmcScript.Run(document,"KISIC downlight light-source symbol",()=>{ foreach(var s in new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>().Where(x=>x.FamilyName=="FMC_E_LightFixture_Downlight_LED")){
 s.LookupParameter("Light Source Symbol Length")?.Set(FmcScript.Mm(50)); s.LookupParameter("Emit from Circle Diameter")?.Set(FmcScript.Mm(s.Name.StartsWith("200")?160:120)); } });
return $"families checked {fams.Count}, fixed {famFixed}: "+log;
