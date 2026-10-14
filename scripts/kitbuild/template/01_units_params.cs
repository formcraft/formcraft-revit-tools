// Step 1: units (TPL-004), P/C revision sequences (TPL-010), bind every FMC_Master_Data.json parameter, TBC in Group 01 (TPL-007).
// Needs the kit shared parameter file set in Revit (restore the user's file afterwards).
var app = document.Application; var p = @"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\06_Templates\_Staging\FMC_Base_Template_v2.2.rte";
var doc = app.Documents.Cast<Document>().FirstOrDefault(x => x.PathName == p) ?? app.OpenDocumentFile(p); var r = new System.Text.StringBuilder();
var js = System.Text.Json.JsonDocument.Parse(System.IO.File.ReadAllText(@"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\03_Master_Data\FMC_Master_Data.json"));
var pars = js.RootElement.GetProperty("params");
var spf = app.OpenSharedParameterFile(); var defs = spf.Groups.SelectMany(g => g.Definitions.Cast<Definition>()).OfType<ExternalDefinition>().ToDictionary(d => d.Name, d => d);
int bound = 0, total = 0; var miss = new List<string>(); var badcat = new HashSet<string>();
using (var t = new Transaction(doc, "FMC base: units, revisions, parameters")) { t.Start();
 var u = doc.GetUnits();
 System.Action<ForgeTypeId, ForgeTypeId, double, ForgeTypeId> SU = (spec, unit, acc, sym) => { var fo = new FormatOptions(unit); fo.Accuracy = acc; if (sym != null) fo.SetSymbolTypeId(sym); u.SetFormatOptions(spec, fo); };
 SU(SpecTypeId.Length, UnitTypeId.Millimeters, 1, null); SU(SpecTypeId.Area, UnitTypeId.SquareMeters, 0.01, SymbolTypeId.MSup2); SU(SpecTypeId.Volume, UnitTypeId.CubicMeters, 0.001, SymbolTypeId.MSup3); SU(SpecTypeId.Angle, UnitTypeId.Degrees, 0.01, SymbolTypeId.Degree); SU(SpecTypeId.Slope, UnitTypeId.Percentage, 0.01, SymbolTypeId.Percent);
 try { var fc = new FormatOptions(UnitTypeId.Currency); fc.Accuracy = 1; u.SetFormatOptions(SpecTypeId.Currency, fc); } catch (System.Exception ex) { r.Append("currency: " + ex.Message + "; "); }
 doc.SetUnits(u);
 foreach (var pfx in new[]{"P","C"}) { var nm = "FMC_" + pfx + "_Sequence"; if (!new FilteredElementCollector(doc).OfClass(typeof(RevisionNumberingSequence)).Any(e => e.Name == nm)) { var ns = new NumericRevisionSettings(); ns.Prefix = pfx; ns.MinimumDigits = 2; ns.StartNumber = 1; RevisionNumberingSequence.CreateNumericSequence(doc, nm, ns); } }
 foreach (var pp in pars.EnumerateObject()) { total++;
  ExternalDefinition def; if (!defs.TryGetValue(pp.Name, out def)) { miss.Add(pp.Name); continue; }
  var cs = app.Create.NewCategorySet();
  foreach (var c in pp.Value.GetProperty("categories").EnumerateArray()) { BuiltInCategory bic; if (System.Enum.TryParse(c.GetString(), out bic)) { var cat = Category.GetCategory(doc, bic); if (cat != null && cat.AllowsBoundParameters) cs.Insert(cat); else badcat.Add(c.GetString()); } else badcat.Add(c.GetString()); }
  var bt = pp.Value.GetProperty("binding").GetString(); ElementBinding b = bt == "Type" ? (ElementBinding)app.Create.NewTypeBinding(cs) : app.Create.NewInstanceBinding(cs);
  if (doc.ParameterBindings.Insert(def, b, GroupTypeId.Data) || doc.ParameterBindings.ReInsert(def, b, GroupTypeId.Data)) bound++; }
 t.Commit(); }
using (var t = new Transaction(doc, "FMC base: TBC")) { t.Start(); int n = 0;
 foreach (var pp in pars.EnumerateObject().Where(x => x.Value.GetProperty("group").GetString() == "FMC_01_Project_Governance")) { var q = doc.ProjectInformation.LookupParameter(pp.Name); if (q != null && q.StorageType == StorageType.String && string.IsNullOrEmpty(q.AsString())) { q.Set("TBC"); n++; } }
 t.Commit(); r.Append("TBC " + n + "; "); }
doc.Save();
return "bound " + bound + "/" + total + " missing " + string.Join(",", miss) + " badcat " + string.Join(",", badcat) + " | " + r;
