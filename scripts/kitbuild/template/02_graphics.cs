// Step 2: text types, line patterns, fill patterns (Revit kit › Graphics). Gaps of 1.5 mm and stand-in fills: kit change request items 13–15.
var app = document.Application; var p = @"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\06_Templates\_Staging\FMC_Base_Template_v2.2.rte";
var doc = app.Documents.Cast<Document>().FirstOrDefault(x => x.PathName == p) ?? app.OpenDocumentFile(p);
var r = new System.Text.StringBuilder(); double mm = 1/304.8; var ci = System.Globalization.CultureInfo.InvariantCulture;
using (var t = new Transaction(doc, "FMC base: graphics")) { t.Start();
 var t0 = new FilteredElementCollector(doc).OfClass(typeof(TextNoteType)).Cast<TextNoteType>().First();
 foreach (var s in new[]{"1.8","2.5","2.5_Bold","3.5","3.5_Bold","5.0_Bold","7.0_Bold"}) { var nm = "FMC_Arial_" + s; var tt = new FilteredElementCollector(doc).OfClass(typeof(TextNoteType)).Cast<TextNoteType>().FirstOrDefault(x => x.Name == nm) ?? (TextNoteType)t0.Duplicate(nm);
  tt.get_Parameter(BuiltInParameter.TEXT_FONT).Set("Arial"); tt.get_Parameter(BuiltInParameter.TEXT_SIZE).Set(double.Parse(s.Split('_')[0], ci) * mm); tt.get_Parameter(BuiltInParameter.TEXT_WIDTH_SCALE).Set(1.0); tt.get_Parameter(BuiltInParameter.TEXT_STYLE_BOLD).Set(s.EndsWith("Bold") ? 1 : 0); }
 System.Func<string, LinePatternSegment> SG = q => { var k = q[0]; var v = q.Length > 1 ? double.Parse(q.Substring(1), ci) * mm : 0; return k == 'D' ? new LinePatternSegment(LinePatternSegmentType.Dash, v) : k == 'S' ? new LinePatternSegment(LinePatternSegmentType.Space, v) : new LinePatternSegment(LinePatternSegmentType.Dot, 0); };
 var lps = new Dictionary<string,string>{ {"FMC_Dash","D3 S1.5"}, {"FMC_DashDot","D6 S1.5 . S1.5"}, {"FMC_DashDotDot","D6 S1.5 . S1.5 . S1.5"}, {"FMC_Dot",". S1.5"}, {"FMC_CentreLine","D12 S1.5 D3 S1.5"}, {"FMC_Boundary","D12 S1.5 . S1.5 . S1.5 . S1.5"} };
 foreach (var kv in lps) { var lp = new LinePattern(kv.Key); lp.SetSegments(kv.Value.Split(' ').Select(SG).ToList()); var ex = LinePatternElement.GetLinePatternElementByName(doc, kv.Key); if (ex == null) LinePatternElement.Create(doc, lp); else ex.SetLinePattern(lp); }
 System.Action<string, FillPattern> FP = (nm, fp) => { var ex = new FilteredElementCollector(doc).OfClass(typeof(FillPatternElement)).Cast<FillPatternElement>().FirstOrDefault(x => x.Name == nm); if (ex == null) FillPatternElement.Create(doc, fp); else ex.SetFillPattern(fp); r.Append(nm.Replace("FMC_","") + " "); };
 System.Action<string, string> CP = (nm, src) => { var s = new FilteredElementCollector(doc).OfClass(typeof(FillPatternElement)).Cast<FillPatternElement>().FirstOrDefault(x => x.Name == src); if (s == null) { r.Append("nosrc " + src + "; "); return; } var fp = s.GetFillPattern(); fp.Name = nm; FP(nm, fp); };
 FP("FMC_Blockwork", new FillPattern("FMC_Blockwork", FillPatternTarget.Drafting, FillPatternHostOrientation.ToView, System.Math.PI/4, 3*mm));
 var gd = new FillPattern("FMC_Brickwork", FillPatternTarget.Drafting, FillPatternHostOrientation.ToView); var g1 = new FillGrid(); g1.Angle = System.Math.PI/4; g1.Offset = 1.5*mm; var g2 = new FillGrid(); g2.Angle = 3*System.Math.PI/4; g2.Offset = 1.5*mm; gd.SetFillGrids(new List<FillGrid>{g1, g2}); FP(gd.Name, gd);
 foreach (var sz in new[]{300, 600}) { var tp = new FillPattern("FMC_Tile_" + sz, FillPatternTarget.Model, FillPatternHostOrientation.ToHost); var a = new FillGrid(); a.Angle = 0; a.Offset = sz*mm; var b = new FillGrid(); b.Angle = System.Math.PI/2; b.Offset = sz*mm; tp.SetFillGrids(new List<FillGrid>{a, b}); FP(tp.Name, tp); }
 CP("FMC_Concrete", "Concrete"); CP("FMC_Earth", "Earth"); CP("FMC_Sand", "Sand"); CP("FMC_Insulation", "Insulation - Rigid"); CP("FMC_Timber", "Wood 1"); CP("FMC_Screed", "Sand - Dense"); CP("FMC_Hardcore", "Masonry - Concrete  Block");
 // FMC_Solid: Revit allows one solid fill pattern only, so the built-in <Solid fill> stands in (kit change request item 12).
 t.Commit(); }
doc.Save(); return "text 7; lines 6; fills " + r;
