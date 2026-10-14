// Step 8: the 12 role templates as copies of Base (06_Templates README). Existing files are kept, never overwritten.
var dir = @"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\06_Templates\_Staging\"; var src = dir + "FMC_Base_Template_v2.2.rte"; var r = "";
foreach (var role in new[]{"A","I","S","M","E","P","FP","LP","C","L","Z","W"}) { var dst = dir + "FMC_" + role + "_Template_v2.2.rte"; if (System.IO.File.Exists(dst)) { r += role + " exists; "; continue; } System.IO.File.Copy(src, dst); r += role + " "; }
return "copied " + r;
