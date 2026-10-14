// Step 9: 21 type legend schedules, one row per type (not itemized), sorted by Type Mark then Type. Proposed to the kit
// (kit change request item 38). Every column is built in; hiding by issue purpose waits for the kit's Column_Sets (item 39).
var app = document.Application; var p = @"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\06_Templates\_Staging\FMC_Base_Template_v2.2.rte";
var b = app.Documents.Cast<Document>().FirstOrDefault(x => x.PathName == p) ?? app.OpenDocumentFile(p);
var sw = System.Diagnostics.Stopwatch.StartNew(); var r = new System.Text.StringBuilder();
var have = new HashSet<string>(new FilteredElementCollector(b).OfClass(typeof(ViewSchedule)).Cast<ViewSchedule>().Select(v => v.Name));
var spec = new[]{
 new[]{"A20_Door_Types","OST_Doors","Type Mark,Family,Type,Width,Height,Description,FMC_Frame_Spec,FMC_Fire_Resistance_Min,FMC_Ironmongery_Set,FMC_Keynote_Code,Count"},
 new[]{"A21_Window_Types","OST_Windows","Type Mark,Family,Type,Width,Height,Description,FMC_Glazing_Spec,FMC_Glazed_Area_m2,FMC_Openable_Area_m2,FMC_Keynote_Code,Count"},
 new[]{"A22_Wall_Types","OST_Walls","Type Mark,Type,Width,Function,Fire Rating,FMC_Code_Description,FMC_Keynote_Code,Count"},
 new[]{"A23_Floor_Types","OST_Floors","Type Mark,Type,Default Thickness,FMC_Screed_mm,FMC_DPM_Spec,FMC_Keynote_Code,Count"},
 new[]{"A24_Roof_Types","OST_Roofs","Type Mark,Type,FMC_Roof_Covering,FMC_Roof_Insulation,FMC_Keynote_Code,Count"},
 new[]{"A25_Ceiling_Types","OST_Ceilings","Type Mark,Type,FMC_Ceiling_System,FMC_Roof_Insulation,FMC_Keynote_Code,Count"},
 new[]{"I20_Furniture_Types","OST_Furniture","Type Mark,Family,Type,Description,Manufacturer,FMC_Keynote_Code,Count"},
 new[]{"I21_Casework_Types","OST_Casework","Type Mark,Family,Type,Width,Depth,Height,FMC_Carcass_Spec,FMC_Worktop_Spec,FMC_Keynote_Code,Count"},
 new[]{"S20_Column_Types","OST_StructuralColumns","Type Mark,Family,Type,FMC_Concrete_Grade,FMC_Keynote_Code,Count"},
 new[]{"S21_Framing_Types","OST_StructuralFraming","Type Mark,Family,Type,FMC_Concrete_Grade,FMC_Steel_Grade,FMC_Keynote_Code,Count"},
 new[]{"S22_Foundation_Types","OST_StructuralFoundation","Type Mark,Family,Type,FMC_Bearing_Capacity_kPa,FMC_Keynote_Code,Count"},
 new[]{"E20_Light_Fitting_Types","OST_LightingFixtures","Type Mark,Family,Type,Description,FMC_Power_W,FMC_IP_Rating,FMC_Keynote_Code,Count"},
 new[]{"E21_Device_Types","OST_ElectricalFixtures","Type Mark,Family,Type,Description,FMC_Keynote_Code,Count"},
 new[]{"E22_Equipment_Types","OST_ElectricalEquipment","Type Mark,Family,Type,FMC_Manufacturer,FMC_Model_Number,FMC_Keynote_Code,Count"},
 new[]{"M20_Equipment_Types","OST_MechanicalEquipment","Type Mark,Family,Type,FMC_Cooling_Capacity_kW,FMC_Cooling_Capacity_BTUh,FMC_Airflow_Ls,FMC_Refrigerant,FMC_Keynote_Code,Count"},
 new[]{"M21_Air_Terminal_Types","OST_DuctTerminal","Type Mark,Family,Type,Description,FMC_Keynote_Code,Count"},
 new[]{"P20_Fixture_Types","OST_PlumbingFixtures","Type Mark,Family,Type,Description,FMC_Discharge_Units,FMC_Keynote_Code,Count"},
 new[]{"P21_Equipment_Types","OST_PlumbingEquipment","Type Mark,Family,Type,FMC_Tank_Capacity_L,FMC_Power_W,FMC_Keynote_Code,Count"},
 new[]{"FP20_Fire_Equipment_Types","OST_SpecialityEquipment","Type Mark,Family,Type,FMC_Extinguisher_Rating,FMC_Keynote_Code,Count"},
 new[]{"L20_Planting_Types","OST_Planting","Type Mark,Type,FMC_Botanical_Name,FMC_Local_Name,FMC_Planting_Size,FMC_Plant_Spacing_mm,FMC_Keynote_Code,Count"},
 new[]{"C20_Drainage_Structure_Types","OST_GenericModel","Type Mark,Family,Type,Description,FMC_Keynote_Code,Count"} };
int made = 0;
using (var t = new Transaction(b, "FMC base: type legend schedules")) { t.Start();
 foreach (var s in spec) { if (have.Contains(s[0])) continue; if (sw.Elapsed.TotalSeconds > 30) { r.Append("STOP time; "); break; }
  try { var vs = ViewSchedule.CreateSchedule(b, new ElementId((BuiltInCategory)System.Enum.Parse(typeof(BuiltInCategory), s[1]))); vs.Name = s[0];
   var def = vs.Definition; var sf = def.GetSchedulableFields(); var miss = new List<string>(); var ids = new Dictionary<string, ScheduleFieldId>();
   foreach (var fn in s[2].Split(',')) { var f = sf.FirstOrDefault(x => x.GetName(b) == fn); if (f == null) { miss.Add(fn); continue; } ids[fn] = def.AddField(f).FieldId; }
   foreach (var g in new[]{"Type Mark","Type"}) { ScheduleFieldId id; if (ids.TryGetValue(g, out id)) def.AddSortGroupField(new ScheduleSortGroupField(id)); }
   def.IsItemized = false; def.ShowGrandTotal = false; made++;
   r.Append("+" + s[0] + (miss.Count > 0 ? "(no " + string.Join("/", miss) + ")" : "") + " ");
  } catch (System.Exception e) { r.Append(s[0] + " FAIL " + e.Message.Split('.')[0] + "; "); } }
 t.Commit(); }
b.Save(); return "made " + made + " | " + r;
