// Step 0: create the Base template in staging from Revit's multi-discipline metric template.
var app = document.Application; var dst = @"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\06_Templates\_Staging\FMC_Base_Template_v2.2.rte";
if (System.IO.File.Exists(dst)) return "exists";
var d = app.NewProjectTemplateDocument(@"C:\ProgramData\Autodesk\RVT 2025\Templates\English\Default-Multi-Discipline_Metric.rte");
var so = new SaveAsOptions(); so.MaximumBackups = 1; d.SaveAs(dst, so); d.Close(false);
return "created " + dst;
