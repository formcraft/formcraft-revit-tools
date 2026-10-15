// Step 12: nine discipline schedules added to the kit's Schedules tab (owner-approved 15 Oct): A11, A12, A13, E16, E17, FP12, M14,
// LP12, C13. Same field matching as steps 7 and 9; a field the template doesn't have is left out and reported "(no X)". A kit word
// Revit spells differently is matched to its Revit name and reported "(X=Y)". Fields that only narrow the rows (Family contains
// Lintel, Sign, Hose) are added hidden. Schedules can't take several chosen categories (multi-category means all, and filters are
// AND only), so E17 is three schedules and FP12 two; each keeps the kit name as its prefix.
var app = document.Application; var p = @"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\06_Templates\_Staging\FMC_Base_Template_v2.2.rte";
var b = app.Documents.Cast<Document>().FirstOrDefault(x => x.PathName == p) ?? app.OpenDocumentFile(p);
var sw = System.Diagnostics.Stopwatch.StartNew(); var r = new System.Text.StringBuilder();
var have = new HashSet<string>(new FilteredElementCollector(b).OfClass(typeof(View)).Cast<View>().Select(v => v.Name));
// name | category | fields | ops: g: group (header), s: sort, fam: hidden Family filter "contains"; a|b = first field found; i = itemized
var spec = new[]{
 new[]{"A11_Ironmongery_Sets","OST_Doors","FMC_Ironmongery_Set,Mark,Type,Width,FMC_Fire_Resistance_Min,Count","g:FMC_Ironmongery_Set;s:Mark;i"},
 new[]{"A12_Lintels","OST_GenericModel","Mark,Type,Length,Level,Count","fam:Lintel;g:Type;s:Mark;i"},
 new[]{"A13_Signage","OST_SpecialityEquipment","Type,Room,Level,Count","fam:Sign;g:Type;s:Level;s:Room"},
 new[]{"E16_Fire_Alarm_Devices","OST_FireAlarmDevices","Type,Level,FMC_Fire_Compartment,Panel,Circuit Number,Count","g:FMC_Fire_Compartment;g:Type;s:Level;i"},
 new[]{"E17_ELV_Security_Devices_Data","OST_DataDevices","Type,Level,Room,Count","g:Level;s:Type;s:Room"},
 new[]{"E17_ELV_Security_Devices_Security","OST_SecurityDevices","Type,Level,Room,Count","g:Level;s:Type;s:Room"},
 new[]{"E17_ELV_Security_Devices_Comms","OST_CommunicationDevices","Type,Level,Room,Count","g:Level;s:Type;s:Room"},
 new[]{"FP12_Sprinklers_HoseReels_Sprinklers","OST_Sprinklers","Type,FMC_Sprinkler_K_Factor,FMC_Sprinkler_Temp_C,Level,Count","g:Type;g:Level"},
 new[]{"FP12_Sprinklers_HoseReels_HoseReels","OST_SpecialityEquipment","Type,FMC_Hose_Length_m,Level,Count","fam:Hose;g:Type;g:Level"},
 new[]{"M14_Refrigerant_Pairs","OST_MechanicalEquipment","Mark,Type,System Name,FMC_Cooling_Capacity_kW,FMC_Refrigerant,Room","g:System Name;s:Mark;i"},
 new[]{"LP12_SPD_Register","OST_SpecialityEquipment","Mark,Type,Panel,FMC_LPS_Class,Count","s:Panel;s:Mark;i"},
 new[]{"C13_Storm_Runs","OST_PipeCurves","Size,Length,Slope,FMC_Invert_In_m,FMC_Invert_Out_m,From,To","s:From|Size;i"} };
// Revit's names for kit words that differ by category (first found wins).
var alias = new Dictionary<string, string[]>{ {"Level", new[]{"Level","Reference Level","Schedule Level","Base Level"}}, {"Room", new[]{"Room","Room: Name","Room: Number"}} };
int made = 0;
using (var t = new Transaction(b, "FMC base: new discipline schedules")) { t.Start();
 foreach (var s in spec) { if (have.Contains(s[0])) continue; if (sw.Elapsed.TotalSeconds > 30) { r.Append("STOP time; "); break; }
  try { var vs = ViewSchedule.CreateSchedule(b, new ElementId((BuiltInCategory)System.Enum.Parse(typeof(BuiltInCategory), s[1]))); vs.Name = s[0];
   var def = vs.Definition; var sf = def.GetSchedulableFields(); var miss = new List<string>(); var note = new List<string>(); var ids = new Dictionary<string, ScheduleFieldId>();
   foreach (var fn in s[2].Split(',')) { SchedulableField f = null;
    foreach (var a in alias.ContainsKey(fn) ? alias[fn] : new[]{ fn }) { f = sf.FirstOrDefault(x => x.GetName(b) == a); if (f != null) { if (a != fn) note.Add(fn + "=" + a); break; } }
    if (f == null) { miss.Add(fn); continue; } ids[fn] = def.AddField(f).FieldId; }
   foreach (var op in s[3].Split(';')) { var o = op.Split(':');
    if (o[0] == "i") continue;
    if (o[0] == "fam") { bool ok = false;
     foreach (var fn in new[]{"Family","Family and Type"}) { var f = sf.FirstOrDefault(x => x.GetName(b) == fn); if (f == null) continue;
      var fld = def.AddField(f); fld.IsHidden = true;
      try { def.AddFilter(new ScheduleFilter(fld.FieldId, ScheduleFilterType.Contains, o[1])); ok = true; if (fn != "Family") note.Add("filter on " + fn); break; }
      catch (System.Exception) { def.RemoveField(fld.FieldId); /* try the next field */ } }
     if (!ok) note.Add("no filter " + o[1] + ": shows all"); continue; }
    ScheduleFieldId id = null; foreach (var fn in o[1].Split('|')) if (ids.TryGetValue(fn, out id)) { if (fn != o[1].Split('|')[0]) note.Add("sort " + fn); break; }
    if (id == null) { note.Add("can't " + (o[0] == "g" ? "group" : "sort") + " by " + o[1]); continue; }
    if (o[0] == "g") { var g = new ScheduleSortGroupField(id); g.ShowHeader = true; def.AddSortGroupField(g); }
    else if (o[0] == "s") def.AddSortGroupField(new ScheduleSortGroupField(id)); }
   if (!s[3].Split(';').Contains("i")) def.IsItemized = false;
   made++; have.Add(s[0]);
   r.Append("+" + s[0] + (miss.Count > 0 ? "(no " + string.Join("/", miss) + ")" : "") + (note.Count > 0 ? "(" + string.Join("; ", note) + ")" : "") + " ");
  } catch (System.Exception e) { r.Append(s[0] + " FAIL " + e.Message.Split('.')[0] + "; "); } }
 t.Commit(); }
b.Save(); return "made " + made + " | " + r;
