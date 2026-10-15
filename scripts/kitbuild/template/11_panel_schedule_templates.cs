// Step 11: four panel schedule templates (kit PANEL_SCHEDULES, owner-approved 15 Oct). Creates each by name (skips existing), sets
// every cell to the font of FMC_Arial_2.5, adds an FMC_Ways header row where the API accepts it, then compares each section with the
// kit and prints what a person must finish in Revit's panel schedule template editor ("by hand"). Never touches demand factors or
// load classifications (CLAUDE.md rule 5): Total Demand Load only shows what the engineer sets.
// API limits: PanelScheduleTemplate.Create has one overload (type, configuration, name), so Switchboard and Data Panel take the
// first configuration Revit accepts for them; TableCellStyle.TextSize has no documented unit, so text size is left to the editor.
var app = document.Application; var p = @"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\06_Templates\_Staging\FMC_Base_Template_v2.2.rte";
var b = app.Documents.Cast<Document>().FirstOrDefault(x => x.PathName == p) ?? app.OpenDocumentFile(p);
var sw = System.Diagnostics.Stopwatch.StartNew(); var r = new System.Text.StringBuilder(); var hand = new System.Text.StringBuilder();
// name | type | configuration | header | circuit columns | footer. FMC_ names in brackets are the parameter that carries the item.
var spec = new[]{
 new[]{"FMC_DB_SPN","Branch","OneColumn","Panel Name (FMC_Panel_ID),Supply From,Distribution System,Mains,Ways (FMC_Ways),Location",
  "Circuit Number,Load Name,Rating,Poles,FMC_Cable_Spec,Apparent Load","Total Connected Load,Total Demand Load,Total Current"},
 new[]{"FMC_DB_TPN","Branch","TwoColumnsCircuitsAcross","Panel Name (FMC_Panel_ID),Supply From,Distribution System,Mains,Ways (FMC_Ways),Location",
  "Circuit Number,Load Name,Rating,Poles,FMC_Cable_Spec,Apparent Load per phase","Connected Load per phase L1 L2 L3,Demand Load per phase L1 L2 L3,Total Connected Load,Total Demand Load,Total Current"},
 new[]{"FMC_MDB_Switchboard","Switchboard","OneColumn","Panel Name (FMC_Panel_ID),Supply From,Distribution System,Mains,Location",
  "Circuit Number,Load Name (fed board),Rating,Frame,Poles,FMC_Cable_Spec,Apparent Load","Total Connected Load,Total Demand Load,Total Current"},
 new[]{"FMC_Data_Panel","Data","OneColumn","Panel Name (FMC_Panel_ID),Supply From,Location","Circuit Number,Load Name,Device","Device count"} };
var have = new FilteredElementCollector(b).OfClass(typeof(Autodesk.Revit.DB.Electrical.PanelScheduleTemplate)).Cast<Autodesk.Revit.DB.Electrical.PanelScheduleTemplate>().ToDictionary(x => x.Name, x => x);
var spe = new FilteredElementCollector(b).OfClass(typeof(SharedParameterElement)).Cast<SharedParameterElement>().GroupBy(x => x.Name).ToDictionary(g => g.Key, g => g.First().Id);
var tt = new FilteredElementCollector(b).OfClass(typeof(TextNoteType)).Cast<TextNoteType>().FirstOrDefault(x => x.Name == "FMC_Arial_2.5");
var font = tt == null ? null : tt.get_Parameter(BuiltInParameter.TEXT_FONT).AsString(); if (font == null) r.Append("no FMC_Arial_2.5 (run step 2): fonts left; ");
var eq = new ElementId(BuiltInCategory.OST_ElectricalEquipment);
System.Func<ElementId, string> Lbl = id => { if (id == null || id == ElementId.InvalidElementId) return null;
 if (id.Value < 0) { try { return LabelUtils.GetLabelFor((BuiltInParameter)id.Value); } catch { return null; } } var e = b.GetElement(id); return e == null ? null : e.Name; };
System.Func<TableSectionData, List<string>> Seen = s => { var l = new List<string>(); if (s == null) return l;
 for (int i = s.FirstRowNumber; i <= s.LastRowNumber; i++) for (int j = s.FirstColumnNumber; j <= s.LastColumnNumber; j++) {
  try { var n = Lbl(s.GetCellParamId(i, j)); if (n != null) l.Add(n); var x = s.GetCellText(i, j); if (!string.IsNullOrWhiteSpace(x)) l.Add(x.Trim().TrimEnd(':')); } catch { } } return l; };
// An item is there when its words (without the bracket) or its FMC_ parameter appear in the section.
System.Func<string, string> Base = it => (it.Contains("(") ? it.Substring(0, it.IndexOf('(')) : it).Trim();
System.Func<string, string> Fmc = it => { var m = System.Text.RegularExpressions.Regex.Match(it, @"FMC_\w+"); return m.Success ? m.Value : null; };
System.Func<List<string>, string, bool> Has = (seen, it) => { var w = Base(it).ToLowerInvariant(); var f = Fmc(it);
 return seen.Any(s => { var q = s.ToLowerInvariant(); return q == w || q.Contains(w) || (f != null && s == f); }); };
int made = 0;
using (var t = new Transaction(b, "FMC base: panel schedule templates")) { t.Start();
 foreach (var s in spec) { if (sw.Elapsed.TotalSeconds > 40) { r.Append("STOP time; "); break; }
  var type = (Autodesk.Revit.DB.Electrical.PanelScheduleType)System.Enum.Parse(typeof(Autodesk.Revit.DB.Electrical.PanelScheduleType), s[1]);
  Autodesk.Revit.DB.Electrical.PanelScheduleTemplate tpl; bool isNew = !have.TryGetValue(s[0], out tpl);
  if (isNew) { try {
    var cfgs = new[]{ s[2], "OneColumn", "TwoColumnsCircuitsAcross", "TwoColumnsCircuitsDown" }.Select(c => (Autodesk.Revit.DB.Electrical.PanelConfiguration)System.Enum.Parse(typeof(Autodesk.Revit.DB.Electrical.PanelConfiguration), c));
    var cfg = cfgs.First(c => Autodesk.Revit.DB.Electrical.PanelScheduleTemplate.IsValidPanelConfiguration(type, c));
    tpl = Autodesk.Revit.DB.Electrical.PanelScheduleTemplate.Create(b, type, cfg, s[0]);
    if (tpl.Name != s[0]) tpl.Name = s[0]; made++; r.Append("+" + s[0] + "(" + cfg + ") ");
   } catch (System.Exception e) { r.Append(s[0] + " FAIL " + e.Message.Split('.')[0] + "; "); continue; } }
  else r.Append("=" + s[0] + " ");
  var todo = new List<string>();
  // Font: every cell that takes an override, as FMC_Arial_2.5. Only on new templates, so hand edits are never undone.
  if (isNew && font != null) { var st = new SubTransaction(b); st.Start();
   try { var data = tpl.GetTableData(); int n = 0;
    foreach (var sec in new[]{ SectionType.Header, SectionType.Body, SectionType.Summary, SectionType.Footer }) { var sd = data.GetSectionData(sec); if (sd == null) continue;
     for (int i = sd.FirstRowNumber; i <= sd.LastRowNumber; i++) for (int j = sd.FirstColumnNumber; j <= sd.LastColumnNumber; j++) {
      if (!sd.AllowOverrideCellStyle(i, j)) continue; var cs = sd.GetTableCellStyle(i, j); cs.FontName = font;
      var o = cs.GetCellStyleOverrideOptions(); o.Font = true; cs.SetCellStyleOverrideOptions(o); sd.SetCellStyle(i, j, cs); n++; } }
    tpl.SetTableData(data); st.Commit(); r.Append("font " + n + " cells; ");
   } catch (System.Exception e) { st.RollBack(); todo.Add("font " + font + " on all cells (API: " + e.Message.Split('.')[0] + ")"); } }
  todo.Add("text size 2.5 mm (FMC_Arial_2.5) on all cells");
  // Header: a label row plus the FMC_ parameter for each kit header item that isn't there yet (only FMC_Ways today).
  var seenH = Seen(tpl.GetTableData().GetSectionData(SectionType.Header));
  foreach (var it in s[3].Split(',')) { if (Has(seenH, it)) continue; var f = Fmc(it); ElementId pid;
   if (f == null || !spe.TryGetValue(f, out pid)) { todo.Add("header: add " + it + (f != null ? " (parameter " + f + " isn't bound; run step 1)" : "")); continue; }
   var st = new SubTransaction(b); st.Start();
   try { var data = tpl.GetTableData(); var h = data.GetSectionData(SectionType.Header); int row = h.LastRowNumber + 1, c0 = h.FirstColumnNumber;
    if (h.NumberOfColumns < 2 || !h.CanInsertRow(row) || !h.IsAcceptableParamIdAndCategoryId(pid, eq)) throw new System.InvalidOperationException("not accepted");
    h.InsertRow(row); h.SetCellText(row, c0, Base(it) + ":"); h.SetCellParamIdAndCategoryId(row, c0 + 1, pid, eq);
    tpl.SetTableData(data); st.Commit(); r.Append(s[0] + " header +" + f + "; ");
   } catch (System.Exception e) { st.RollBack(); todo.Add("header: add " + Base(it) + " as " + f + " (Electrical Equipment) [" + e.Message.Split('.')[0] + "]"); } }
  // Circuit table and footer: compared only. The API can't place circuit-table columns or load-summary totals safely.
  var seenB = Seen(tpl.GetTableData().GetSectionData(SectionType.Body));
  foreach (var it in s[4].Split(',')) if (!Has(seenB, it)) todo.Add("circuit table: add column " + it + (Fmc(it) != null ? " (Electrical Circuits)" : ""));
  var dd = tpl.GetTableData(); var seenF = Seen(dd.GetSectionData(SectionType.Footer)); seenF.AddRange(Seen(dd.GetSectionData(SectionType.Summary)));
  foreach (var it in s[5].Split(',')) if (!Has(seenF, it)) todo.Add("footer/summary: add " + it);
  if (s[0] == "FMC_DB_TPN") todo.Add("circuit table: phase loads per circuit (Apparent Load per phase L1 L2 L3)");
  if (s[0] == "FMC_MDB_Switchboard") todo.Add("check one row per feeder; Load Name shows the fed board");
  hand.Append("\n" + s[0] + ": " + string.Join("; ", todo)); }
 t.Commit(); }
b.Save(); return "made " + made + " | " + r + "\nBY HAND in Manage > Panel Schedule Templates > Edit a Template (demand factors stay with the engineer):" + hand;
