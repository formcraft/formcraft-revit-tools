// Step 5: 42 rule filters from FMC_Filters_build.txt (name|categories or 5D|rule). Rule DSL: noval, hasval, eq, begins,
// notbegins, contains, ieq, gt, sys (piping system type), phase, or:/and: joined by ';'. "B.X" = built-in parameter X.
// Categories that lack a rule parameter are dropped and reported (kit change request item 27).
var app = document.Application; var p = @"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\06_Templates\_Staging\FMC_Base_Template_v2.2.rte";
var SPEC = System.IO.File.ReadAllText(@"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\06_Templates\_Staging\_Build\FMC_Filters_build.txt");
var d = app.Documents.Cast<Document>().FirstOrDefault(x => x.PathName == p) ?? app.OpenDocumentFile(p);
var r = new System.Text.StringBuilder(); int ok = 0, catOnly = 0;
var sp = new FilteredElementCollector(d).OfClass(typeof(SharedParameterElement)).Cast<SharedParameterElement>().GroupBy(x => x.Name).ToDictionary(g => g.Key, g => g.First());
var kb = (ElementBinding)d.ParameterBindings.get_Item(sp["FMC_Keynote_Code"].GetDefinition());
var cat5D = kb.Categories.Cast<Category>().Select(c => c.Id).ToList();
System.Func<string, ElementId> PID = s => s.StartsWith("B.") ? new ElementId((BuiltInParameter)System.Enum.Parse(typeof(BuiltInParameter), s.Substring(2))) : sp[s].Id;
var ids = new List<ElementId>();
System.Func<string, FilterRule> RULE = s => { var a = s.Split(':');
 if (a[0] == "sys") { var st = new FilteredElementCollector(d).OfClass(typeof(Autodesk.Revit.DB.Plumbing.PipingSystemType)).First(x => x.Name == a[1]); var bid = new ElementId(BuiltInParameter.RBS_PIPING_SYSTEM_TYPE_PARAM); ids.Add(bid); return ParameterFilterRuleFactory.CreateEqualsRule(bid, st.Id); }
 var id = PID(a[1]); ids.Add(id);
 switch (a[0]) {
  case "noval": return ParameterFilterRuleFactory.CreateHasNoValueParameterRule(id);
  case "hasval": return ParameterFilterRuleFactory.CreateHasValueParameterRule(id);
  case "eq": return ParameterFilterRuleFactory.CreateEqualsRule(id, a[2]);
  case "begins": return ParameterFilterRuleFactory.CreateBeginsWithRule(id, a[2]);
  case "notbegins": return ParameterFilterRuleFactory.CreateNotBeginsWithRule(id, a[2]);
  case "contains": return ParameterFilterRuleFactory.CreateContainsRule(id, a[2]);
  case "ieq": return ParameterFilterRuleFactory.CreateEqualsRule(id, int.Parse(a[2]));
  case "gt": { var dt = sp[a[1]].GetDefinition().GetDataType(); return dt == SpecTypeId.Int.Integer ? ParameterFilterRuleFactory.CreateGreaterRule(id, int.Parse(a[2])) : ParameterFilterRuleFactory.CreateGreaterRule(id, double.Parse(a[2]), 1e-6); }
  case "phase": { var ph = d.Phases.Cast<Phase>().First(x => x.Name == a[2]); return ParameterFilterRuleFactory.CreateEqualsRule(id, ph.Id); }
 } throw new System.Exception("bad rule " + s); };
using (var t = new Transaction(d, "FMC base: filters")) { t.Start();
 foreach (var line in SPEC.Split('\n')) { var f = line.Trim().Split('|'); if (f.Length < 3) continue;
  try { ids.Clear(); ElementFilter ef = null; var rs = f[2];
   if (rs.StartsWith("or:") || rs.StartsWith("and:")) { var parts = rs.Substring(rs.IndexOf(':') + 1).Split(';').Select(x => (ElementFilter)new ElementParameterFilter(RULE(x))).ToList(); ef = rs.StartsWith("or:") ? (ElementFilter)new LogicalOrFilter(parts) : new LogicalAndFilter(parts); }
   else if (rs != "none") ef = new ElementParameterFilter(RULE(rs));
   var cats = f[1] == "5D" ? cat5D.ToList() : f[1].Split(',').Select(c => Category.GetCategory(d, (BuiltInCategory)System.Enum.Parse(typeof(BuiltInCategory), c))).Where(c => c != null).Select(c => c.Id).ToList();
   var dropped = new List<string>();
   if (ids.Count > 0) cats = cats.Where(c => { var fp = ParameterFilterUtilities.GetFilterableParametersInCommon(d, new List<ElementId>{ c }); bool all = ids.All(i => fp.Contains(i)); if (!all) dropped.Add(Category.GetCategory(d, c).Name); return all; }).ToList();
   if (cats.Count == 0) { r.Append(f[0] + " NO CATS; "); continue; }
   var ex = new FilteredElementCollector(d).OfClass(typeof(ParameterFilterElement)).Cast<ParameterFilterElement>().FirstOrDefault(x => x.Name == f[0]);
   if (ex == null) ex = ParameterFilterElement.Create(d, f[0], cats); else ex.SetCategories(cats);
   if (ef != null) ex.SetElementFilter(ef); else catOnly++;
   ok++; if (dropped.Count > 0) r.Append(f[0] + " -" + string.Join("/", dropped) + "; ");
  } catch (System.Exception e) { r.Append(f[0] + " FAIL " + e.Message.Split('.')[0] + "; "); }
 }
 t.Commit(); }
d.Save(); return "filters " + ok + " (category-only " + catOnly + ") | " + r;
