// KISIC step 16 – post-build light source for a staged lighting family, then load it into the open project.
// parameters: [rfa path, lumens (or "type:lm,type:lm"), kelvin, shape point|line|rect|circle, distribution spherical|hemi|spot, source z mm (family coords), spot beam deg, spot field deg]
// Lesson: setting the family's "Light Source" by API creates NO light types until a family type is created -> each type is recreated under its own name (values kept), then photometry is set per light type.
string path=(string)parameters[0]; string lmArg=(string)parameters[1]; double K=double.Parse((string)parameters[2]); string shape=(string)parameters[3], dist=(string)parameters[4];
double zmm=double.Parse((string)parameters[5]); double beam=parameters.Length>6?double.Parse((string)parameters[6]):60, field=parameters.Length>7?double.Parse((string)parameters[7]):90;
var log=new StringBuilder(); var app=document.Application; var fd=app.OpenDocumentFile(path);
double LmFor(string type){ if(!lmArg.Contains(":")) return double.Parse(lmArg); foreach(var kv in lmArg.Split(',')){ var p=kv.Split(':'); if(type.StartsWith(p[0])) return double.Parse(p[1]); } return double.Parse(lmArg.Split(',')[0].Split(':')[1]); }
try{
 using(var t=new Transaction(fd,"KISIC light source")){ t.Start(); try{
  var ls=fd.OwnerFamily.LookupParameter("Light Source"); if(ls!=null&&!ls.IsReadOnly) ls.Set(1); fd.Regenerate();
  var fm=fd.FamilyManager; var names=fm.Types.Cast<FamilyType>().Select(x=>x.Name).ToList();
  var lf0=LightFamily.GetLightFamily(fd);
  if(lf0.GetNumberOfLightTypes()<names.Count){
   foreach(var n in names){ var ft=fm.Types.Cast<FamilyType>().First(x=>x.Name==n); fm.CurrentType=ft; var nt=fm.NewType(n+"__lt"); fm.CurrentType=ft; fm.DeleteCurrentType(); fm.CurrentType=nt; fm.RenameCurrentType(n); } }
  fd.Regenerate(); var lf=LightFamily.GetLightFamily(fd); log.Append("light types "+lf.GetNumberOfLightTypes()+"; ");
  lf.SetLightShapeStyle(shape=="line"?LightShapeStyle.Line:shape=="rect"?LightShapeStyle.Rectangle:shape=="circle"?LightShapeStyle.Circle:LightShapeStyle.Point);
  lf.SetLightDistributionStyle(dist=="spot"?LightDistributionStyle.Spot:dist=="hemi"?LightDistributionStyle.Hemispherical:LightDistributionStyle.Spherical);
  for(int i=0;i<lf.GetNumberOfLightTypes();i++){ var nm=lf.GetLightTypeName(i); var lt=lf.GetLightType(i); lt.SetInitialIntensity(new InitialFluxIntensity(LmFor(nm))); lt.SetInitialColor(new CustomInitialColor(K));
   if(dist=="spot"&&lt.GetLightDistribution() is SpotLightDistribution sd){ sd.SpotBeamAngle=beam*Math.PI/180; sd.SpotFieldAngle=field*Math.PI/180; lt.SetLightDistribution(sd); }
   log.Append(nm+" "+LmFor(nm)+"lm; "); }
  var src=new FilteredElementCollector(fd).OfCategory(BuiltInCategory.OST_LightingFixtureSource).WhereElementIsNotElementType().FirstElement();
  if(src!=null&&zmm>-9000){ var bb=src.get_BoundingBox(null); var cz=bb==null?0:(bb.Min.Z+bb.Max.Z)/2; ElementTransformUtils.MoveElement(fd,src.Id,new XYZ(0,0,FmcScript.Mm(zmm)-cz)); log.Append("source z "+zmm+"; "); }
  t.Commit(); }catch(Exception ex){ if(t.GetStatus()==TransactionStatus.Started) t.RollBack(); return "FAILED "+ex.Message+" | "+log; } }
 fd.Save(); fd.LoadFamily(document); log.Append("saved + loaded");
}finally{ fd.Close(false); }
return log.ToString();
