// KISIC 24 - check exports: PNG of views/sheets (for an AI or a person to look at) and PDF of sheets (for issue). usings ["System.IO"].
// parameters: [mode "png"|"pdf", out folder, comma-separated element ids of views/sheets, name prefix]. A >50 s export returns as a job (fmc_job).
string mode=(string)parameters[0], dir=(string)parameters[1], prefix=parameters.Length>3?(string)parameters[3]:"chk"; Directory.CreateDirectory(dir);
var ids=((string)parameters[2]).Split(',').Select(s=>new ElementId(long.Parse(s.Trim()))).ToList(); var res=new List<string>();
if(mode=="png"){ var o=new ImageExportOptions{ExportRange=ExportRange.SetOfViews,FilePath=Path.Combine(dir,prefix),ImageResolution=ImageResolution.DPI_150,PixelSize=6000,FitDirection=FitDirectionType.Horizontal,HLRandWFViewsFileType=ImageFileType.PNG,ShadowViewsFileType=ImageFileType.PNG,ZoomType=ZoomFitType.FitToPage};
 o.SetViewsAndSheets(ids); document.ExportImage(o); res.AddRange(Directory.GetFiles(dir,prefix+"*.png")); }
else foreach(var id in ids){ var sh=document.GetElement(id) as ViewSheet; if(sh==null) continue; var name=$"{prefix}_{sh.SheetNumber}_{sh.Name}".Replace(" ","_").Replace(",","").Replace("&","and");
 var o=new PDFExportOptions{FileName=name,Combine=true,PaperFormat=ExportPaperFormat.Default,ZoomType=ZoomType.Zoom,ZoomPercentage=100,HideCropBoundaries=true,HideScopeBoxes=true,HideReferencePlane=true,HideUnreferencedViewTags=true};
 document.Export(dir,new List<ElementId>{id},o); var f=Path.Combine(dir,name+".pdf"); res.Add(f+" "+(File.Exists(f)?new FileInfo(f).Length:0)); }
return string.Join("\n",res);
