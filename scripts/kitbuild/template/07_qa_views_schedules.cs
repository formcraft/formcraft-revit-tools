// Step 7: model, QA and export views (TPL-014/015/016) and schedules 00–09 (TPL-017). Gaps: 07 amount formula, 05 finish keys,
// 09 OR filter, 00_QA_and_Precon folder (kit change request items 30–33).
var app = document.Application; var p = @"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\06_Templates\_Staging\FMC_Base_Template_v2.2.rte";
var d = app.Documents.Cast<Document>().FirstOrDefault(x => x.PathName == p) ?? app.OpenDocumentFile(p);
var r = new System.Text.StringBuilder();
var views = new FilteredElementCollector(d).OfClass(typeof(View)).Cast<View>().ToList();
System.Func<string, View> VT = n => views.First(v => v.IsTemplate && v.Name == n);
var v3 = new FilteredElementCollector(d).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().First(x => x.ViewFamily == ViewFamily.ThreeDimensional).Id;
var vfp = new FilteredElementCollector(d).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().First(x => x.ViewFamily == ViewFamily.FloorPlan).Id;
using (var t = new Transaction(d, "FMC base: QA views and schedules")) { t.Start();
 foreach (var s in new[]{ new[]{"Z_3D_Model_Review","VT_Z_3D_ModelReview"}, new[]{"Z_3D_Warnings","VT_Z_3D_ModelReview"}, new[]{"Z_3D_QA_NoCode","VT_Z_3D_QA"}, new[]{"Z_3D_QA_Unpriced","VT_Z_3D_QA"}, new[]{"Z_3D_QA_NoStage","VT_Z_3D_QA"}, new[]{"Z_3D_NWC_Export","VT_Z_3D_Export"}, new[]{"Z_3D_IFC_Export","VT_Z_3D_Export"} }) {
  if (views.Any(v => !v.IsTemplate && v.Name == s[0])) continue; var v = View3D.CreateIsometric(d, v3); v.Name = s[0]; v.ViewTemplateId = VT(s[1]).Id; r.Append("+" + s[0] + " "); }
 int i = 0; foreach (var l in new FilteredElementCollector(d).OfClass(typeof(Level)).Cast<Level>().OrderBy(x => x.Elevation)) { var nm = "A_FP_L" + (i++).ToString("00") + "_Model"; if (views.Any(v => v.Name == nm)) continue; var v = ViewPlan.Create(d, vfp, l.Id); v.Name = nm; v.ViewTemplateId = VT("VT_A_FloorPlan_Construction").Id; r.Append("+" + nm + " "); }
 var sch = new[]{
  new[]{"00_Codes_Used","*","FMC_Keynote_Code,FMC_Code_Description,Count","g:FMC_Keynote_Code"},
  new[]{"01_Types_Without_Code","*","Family and Type,Count","none:FMC_Keynote_Code;g:Family and Type"},
  new[]{"02_Walls","OST_Walls","Type,FMC_Keynote_Code,Length,Area,Volume,Base Constraint","g:Type;g:Base Constraint"},
  new[]{"03_Doors","OST_Doors","Mark,Width,Height,Type,FMC_Frame_Spec,FMC_Fire_Resistance_Min,FMC_Ironmongery_Set","s:Mark"},
  new[]{"04_Windows","OST_Windows","Mark,Width,Height,Type,FMC_Glazing_Spec,FMC_Glazed_Area_m2,FMC_Openable_Area_m2","s:Mark"},
  new[]{"05_Room_Finishes","OST_Rooms","Number,Name,Area,FMC_Finish_Set","s:Number"},
  new[]{"06_Floors","OST_Floors","Type,FMC_Keynote_Code,Area,Volume,Level","g:Type;g:Level"},
  new[]{"07_Cost_Estimate","*","FMC_Keynote_Code,FMC_Cost_Unit,FMC_Unit_Rate,Count","g:FMC_Keynote_Code"},
  new[]{"08_Procurement_Status","*","FMC_Trade_Package,FMC_Procurement_Status,FMC_Lead_Time_Weeks,FMC_PO_Reference","g:FMC_Trade_Package"},
  new[]{"09_QA_MissingData","*","Family and Type,FMC_Keynote_Code,FMC_Geometry_Stage,FMC_Role_Code","s:Family and Type"} };
 foreach (var s in sch) { if (views.Any(v => v.Name == s[0])) continue;
  try { var cid = s[1] == "*" ? ElementId.InvalidElementId : new ElementId((BuiltInCategory)System.Enum.Parse(typeof(BuiltInCategory), s[1]));
   var vs = ViewSchedule.CreateSchedule(d, cid); vs.Name = s[0]; var def = vs.Definition; var sf = def.GetSchedulableFields(); var fid = new Dictionary<string, ScheduleFieldId>(); var miss = new List<string>();
   foreach (var fn in s[2].Split(',')) { var f = sf.FirstOrDefault(x => x.GetName(d) == fn); if (f == null) { miss.Add(fn); continue; } fid[fn] = def.AddField(f).FieldId; }
   foreach (var op in s[3].Split(';')) { var o = op.Split(':'); ScheduleFieldId id; if (!fid.TryGetValue(o[1], out id)) continue;
    if (o[0] == "g") { var g = new ScheduleSortGroupField(id); g.ShowHeader = true; def.AddSortGroupField(g); }
    else if (o[0] == "s") def.AddSortGroupField(new ScheduleSortGroupField(id));
    else if (o[0] == "none") def.AddFilter(new ScheduleFilter(id, ScheduleFilterType.HasNoValue)); }
   if (s[0].StartsWith("00") || s[0].StartsWith("01") || s[0].StartsWith("07") || s[0].StartsWith("08")) def.IsItemized = false;
   r.Append("+" + s[0] + (miss.Count > 0 ? "(no " + string.Join("/", miss) + ")" : "") + " ");
  } catch (System.Exception e) { r.Append(s[0] + " FAIL " + e.Message.Split('.')[0] + "; "); } }
 t.Commit(); }
d.Save(); return r.ToString();
