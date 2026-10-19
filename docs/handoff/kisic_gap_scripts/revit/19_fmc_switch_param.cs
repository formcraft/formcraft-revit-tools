// KISIC 19 - bind a shared text parameter "FMC Switch" (switch group per fitting/plate) to Lighting Fixtures, Lighting Devices, Generic Models.
// Why: Revit's built-in Switch ID (RBS_ELEC_SWITCH_ID_PARAM) is read-only on fittings unless a lighting switch system exists.
// usings ["System.IO"], transactionMode "none". The shared-parameter file is restored afterwards.
var app=document.Application; string orig=app.SharedParametersFilename; string path=@"D:\Fomcraft\FMC_PROJECTS_27\KISASI IMAGING CENTRE\01_WIP\A\_recipe\KISIC_SharedParams.txt";
var it=document.ParameterBindings.ForwardIterator(); while(it.MoveNext()) if(it.Key.Name=="FMC Switch") return "exists";
if(!File.Exists(path)) File.WriteAllText(path,"");
try{ app.SharedParametersFilename=path; var df=app.OpenSharedParameterFile(); var g=df.Groups.get_Item("KISIC")??df.Groups.Create("KISIC");
 var d=g.Definitions.get_Item("FMC Switch") ?? g.Definitions.Create(new ExternalDefinitionCreationOptions("FMC Switch",SpecTypeId.String.Text){Description="Switch / control group that operates this fitting (one layer = one switch)"});
 var cs=app.Create.NewCategorySet(); foreach(var bic in new[]{BuiltInCategory.OST_LightingFixtures,BuiltInCategory.OST_LightingDevices,BuiltInCategory.OST_GenericModel}) cs.Insert(Category.GetCategory(document,bic));
 bool ok=false; FmcScript.Run(document,"KISIC FMC Switch parameter",()=>{ ok=document.ParameterBindings.Insert(d,app.Create.NewInstanceBinding(cs),GroupTypeId.ElectricalLighting); });
 return "bound "+ok; } finally { app.SharedParametersFilename=orig; }
