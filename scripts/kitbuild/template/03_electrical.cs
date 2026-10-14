// Step 3: voltages, distribution systems, load classifications (Electrical_Settings). Demand factors are never set (CLAUDE.md rule 5, TPL-025).
var app = document.Application; var p = @"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\06_Templates\_Staging\FMC_Base_Template_v2.2.rte";
var doc = app.Documents.Cast<Document>().FirstOrDefault(x => x.PathName == p) ?? app.OpenDocumentFile(p); var r = new System.Text.StringBuilder();
System.Func<double,double> V = v => UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Volts);
using (var t = new Transaction(doc, "FMC base: electrical settings")) { t.Start();
 var es = Autodesk.Revit.DB.Electrical.ElectricalSetting.GetElectricalSettings(doc);
 var vt = new Dictionary<string, Autodesk.Revit.DB.Electrical.VoltageType>();
 foreach (var v in new[]{ new object[]{"240 V",240.0,216.0,264.0}, new object[]{"415 V",415.0,374.0,457.0}, new object[]{"11 kV",11000.0,9900.0,12100.0}, new object[]{"33 kV",33000.0,29700.0,36300.0} }) {
  var nm = (string)v[0]; var ex = es.VoltageTypes.Cast<Autodesk.Revit.DB.Electrical.VoltageType>().FirstOrDefault(x => x.Name == nm);
  vt[nm] = ex ?? es.AddVoltageType(nm, V((double)v[1]), V((double)v[2]), V((double)v[3])); }
 var P3 = Autodesk.Revit.DB.Electrical.ElectricalPhase.ThreePhase; var P1 = Autodesk.Revit.DB.Electrical.ElectricalPhase.SinglePhase;
 var DL = Autodesk.Revit.DB.Electrical.ElectricalPhaseConfiguration.Delta; var WY = Autodesk.Revit.DB.Electrical.ElectricalPhaseConfiguration.Wye; var UN = Autodesk.Revit.DB.Electrical.ElectricalPhaseConfiguration.Undefined;
 System.Action<string, Autodesk.Revit.DB.Electrical.ElectricalPhase, Autodesk.Revit.DB.Electrical.ElectricalPhaseConfiguration, int, string, string> DS = (nm, ph, cf, w, ll, lg) => { if (es.DistributionSysTypes.Cast<Autodesk.Revit.DB.Electrical.DistributionSysType>().Any(x => x.Name == nm)) return; es.AddDistributionSysType(nm, ph, cf, w, ll == null ? null : vt[ll], lg == null ? null : vt[lg]); };
 DS("DS_33kV_3Ph_3W", P3, DL, 3, "33 kV", null); DS("DS_11kV_3Ph_3W", P3, DL, 3, "11 kV", null); DS("DS_415-240V_3Ph_4W", P3, WY, 4, "415 V", "240 V"); DS("DS_240V_1Ph_2W", P1, UN, 2, null, "240 V");
 var have = new FilteredElementCollector(doc).OfClass(typeof(Autodesk.Revit.DB.Electrical.ElectricalLoadClassification)).Select(x => x.Name).ToList(); int made = 0;
 foreach (var n in new[]{"Lighting","Power","Water Heater","Motor","HVAC","Emergency Lighting","Site Lighting","Other"}) if (!have.Contains(n)) { Autodesk.Revit.DB.Electrical.ElectricalLoadClassification.Create(doc, n); made++; }
 r.Append("voltages 4; systems 4; load classes made " + made + "; unlisted kept: " + (have.Count - 5));
 t.Commit(); }
doc.Save(); return r.ToString();
