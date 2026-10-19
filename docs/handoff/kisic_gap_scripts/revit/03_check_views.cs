// KISIC step 03 – check views + PNG export. transactionMode "none", usings ["System.IO"]. parameters ["<tag>"] names the export, e.g. ["after_01"].
string tag=parameters!=null&&parameters.Length>0?(string)parameters[0]:"check";
var L0=new FilteredElementCollector(document).OfClass(typeof(Level)).Cast<Level>().First(l=>l.Name=="L00 FFL");
var pv=new FilteredElementCollector(document).OfClass(typeof(ViewPlan)).Cast<ViewPlan>().FirstOrDefault(v=>v.Name=="FMC Check - Plan");
var v3=new FilteredElementCollector(document).OfClass(typeof(View3D)).Cast<View3D>().FirstOrDefault(v=>v.Name=="FMC Check - 3D");
FmcScript.Run(document,"check views",()=>{
 if(pv==null){ var vft=new FilteredElementCollector(document).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().First(x=>x.ViewFamily==ViewFamily.FloorPlan);
  pv=ViewPlan.Create(document,vft.Id,L0.Id); pv.Name="FMC Check - Plan"; pv.ViewTemplateId=ElementId.InvalidElementId; pv.Scale=50; pv.DetailLevel=ViewDetailLevel.Fine;
  pv.CropBoxActive=true; var cb=pv.CropBox; cb.Min=new XYZ(FmcScript.Mm(-600),FmcScript.Mm(-8600),cb.Min.Z); cb.Max=new XYZ(FmcScript.Mm(10400),FmcScript.Mm(600),cb.Max.Z); pv.CropBox=cb; }
 // tag untagged rooms
 var tagged=new FilteredElementCollector(document,pv.Id).OfCategory(BuiltInCategory.OST_RoomTags).Cast<Autodesk.Revit.DB.Architecture.RoomTag>().Select(x=>x.TaggedLocalRoomId).ToHashSet();
 foreach(Autodesk.Revit.DB.Architecture.Room r in new FilteredElementCollector(document).OfCategory(BuiltInCategory.OST_Rooms)){ if(tagged.Contains(r.Id)||r.Location==null) continue; var lp=(LocationPoint)r.Location; document.Create.NewRoomTag(new LinkElementId(r.Id),new UV(lp.Point.X,lp.Point.Y),pv.Id);}
 if(v3==null){ var vft3=new FilteredElementCollector(document).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().First(x=>x.ViewFamily==ViewFamily.ThreeDimensional);
  v3=View3D.CreateIsometric(document,vft3.Id); v3.Name="FMC Check - 3D"; v3.DisplayStyle=DisplayStyle.ShadingWithEdges; v3.DetailLevel=ViewDetailLevel.Fine;
  foreach(var bic in new[]{BuiltInCategory.OST_Levels,BuiltInCategory.OST_Grids,BuiltInCategory.OST_SectionBox}){var c=Category.GetCategory(document,bic); if(c!=null&&v3.CanCategoryBeHidden(c.Id)) v3.SetCategoryHidden(c.Id,true);}
  var eye=new XYZ(FmcScript.Mm(20000),FmcScript.Mm(-22000),FmcScript.Mm(14000)); var target=new XYZ(FmcScript.Mm(4800),FmcScript.Mm(-3800),0); var fwd=(target-eye).Normalize(); var right=fwd.CrossProduct(XYZ.BasisZ).Normalize(); var up=right.CrossProduct(fwd).Normalize(); v3.SetOrientation(new ViewOrientation3D(eye,up,fwd));
  v3.IsSectionBoxActive=true; v3.SetSectionBox(new BoundingBoxXYZ{Min=FmcScript.PointMm(-500,-8700,-300),Max=FmcScript.PointMm(10400,500,3300)}); }
 // hide roof + canopy slabs and ceilings each run (new ones may exist)
 var hide=new List<ElementId>(new FilteredElementCollector(document).OfClass(typeof(Ceiling)).ToElementIds());
 foreach(Floor f in new FilteredElementCollector(document).OfClass(typeof(Floor))){var c=f.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).AsString()??""; if(c.StartsWith("Roof")||c.StartsWith("Veranda canopy")) hide.Add(f.Id);}
 hide=hide.Where(id=>!document.GetElement(id).IsHidden(v3)).ToList(); if(hide.Count>0) v3.HideElements(hide);
 var cb3=v3.CropBox; var inv=cb3.Transform.Inverse; var sb=v3.GetSectionBox(); var pts=new List<XYZ>();
 foreach(var x in new[]{sb.Min.X,sb.Max.X}) foreach(var y in new[]{sb.Min.Y,sb.Max.Y}) foreach(var z in new[]{sb.Min.Z,sb.Max.Z}) pts.Add(inv.OfPoint(sb.Transform.OfPoint(new XYZ(x,y,z))));
 v3.CropBox=new BoundingBoxXYZ{Transform=cb3.Transform,Min=new XYZ(pts.Min(p=>p.X),pts.Min(p=>p.Y),cb3.Min.Z),Max=new XYZ(pts.Max(p=>p.X),pts.Max(p=>p.Y),cb3.Max.Z)}; v3.CropBoxActive=true; v3.CropBoxVisible=false;
});
string dir=@"D:\Fomcraft\FMC_PROJECTS_27\KISASI IMAGING CENTRE\01_WIP\A\_check"; Directory.CreateDirectory(dir);
var o=new ImageExportOptions{ExportRange=ExportRange.SetOfViews,FilePath=Path.Combine(dir,tag),HLRandWFViewsFileType=ImageFileType.PNG,ShadowViewsFileType=ImageFileType.PNG,ZoomType=ZoomFitType.FitToPage,PixelSize=2000};
o.SetViewsAndSheets(new List<ElementId>{pv.Id,v3.Id}); document.ExportImage(o);
return string.Join("\n",Directory.GetFiles(dir,tag+"*"));
