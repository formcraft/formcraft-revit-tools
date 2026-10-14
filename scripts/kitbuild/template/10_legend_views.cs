// Step 10: legend views. 22 from the Sheet Register (LG_<Role>_Symbols plus each role's key; headings only until the kit
// gives values, items 40-41) and one notes legend per "=== LG_x: HEADING ===" block in 10_Notes\FMC_Notes_*.txt.
// Revit's API can't create a legend view, so each one duplicates the seed legend "Symbols". Scale 1:50 (item 42).
var app = document.Application; var kit = @"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\";
var p = kit + @"06_Templates\_Staging\FMC_Base_Template_v2.2.rte";
var b = app.Documents.Cast<Document>().FirstOrDefault(x => x.PathName == p) ?? app.OpenDocumentFile(p);
var sw = System.Diagnostics.Stopwatch.StartNew(); var r = new System.Text.StringBuilder();
var todo = new List<Tuple<string,string,string>>();
foreach (var role in new[]{"A","I","S","E","M","P","FP","LP","C","L","W"}) todo.Add(Tuple.Create("LG_" + role + "_Symbols", "SYMBOLS", ""));
foreach (var k in new[]{"A_WallTypes|WALL TYPES","I_FinishCodes|FINISH CODES","S_ConcreteKey|CONCRETE GRADES AND COVERS","E_MountingHeights|MOUNTING HEIGHTS","M_SystemColours|SYSTEM COLOURS","P_PipeMaterials|PIPE MATERIALS","LP_ClassTable|LPS CLASS AND DATA","C_Pavements|PAVEMENT BUILD-UPS","L_PlantPalette|PLANT PALETTE","W_ZoneKey|ZONE KEY"}) { var a = k.Split('|'); todo.Add(Tuple.Create("LG_" + a[0], a[1], "")); }
foreach (var f in System.IO.Directory.GetFiles(kit + "10_Notes", "FMC_Notes_*.txt").OrderBy(x => x)) {
 string name = null, head = null; var body = new List<string>();
 System.Action flush = () => { if (name != null) todo.Add(Tuple.Create(name, head, string.Join("\n", body))); };
 foreach (var raw in System.IO.File.ReadAllLines(f)) { var l = raw.Trim();
  if (l.StartsWith("=== ") && l.EndsWith(" ===")) { flush(); var x = l.Substring(4, l.Length - 8); var c = x.IndexOf(':'); name = x.Substring(0, c).Trim(); head = x.Substring(c + 1).Trim(); body = new List<string>(); }
  else if (name != null && l.Length > 0) body.Add(l); }
 flush(); }
var views = new FilteredElementCollector(b).OfClass(typeof(View)).Cast<View>().ToList();
var have = new HashSet<string>(views.Select(v => v.Name));
var seed = views.First(v => v.ViewType == ViewType.Legend && !v.IsTemplate && v.Name == "Symbols");
var tt = new FilteredElementCollector(b).OfClass(typeof(TextNoteType)).Cast<TextNoteType>().ToDictionary(t => t.Name, t => t.Id);
int made = 0; double w = 170.0 / 304.8; // text width on paper
using (var t = new Transaction(b, "FMC base: legend views")) { t.Start();
 foreach (var it in todo) { if (have.Contains(it.Item1)) continue; if (sw.Elapsed.TotalSeconds > 30) { r.Append("STOP time; "); break; }
  try { var v = b.GetElement(seed.Duplicate(ViewDuplicateOption.Duplicate)) as View; v.Name = it.Item1; v.Scale = 50;
   TextNote.Create(b, v.Id, XYZ.Zero, w, it.Item2, new TextNoteOptions(tt["FMC_Arial_3.5_Bold"]));
   if (it.Item3 != "") TextNote.Create(b, v.Id, new XYZ(0, -8.0 * 50 / 304.8, 0), w, it.Item3, new TextNoteOptions(tt["FMC_Arial_2.5"]));
   made++; have.Add(it.Item1);
  } catch (System.Exception e) { r.Append(it.Item1 + " FAIL " + e.Message.Split('.')[0] + "; "); } }
 t.Commit(); }
b.Save(); return "planned " + todo.Count + " made " + made + " | " + r;
