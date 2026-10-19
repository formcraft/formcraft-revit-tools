using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Line diagram sheets and Gate D's read (LD5, step E2 of docs/PLAN_ENGINEERING_SERVICES.md).
    ///
    /// Sheets (fmc_diagram_sheet): the Sheet Register sheets the server planned (server/src/fmc/diagram/sheets.ts), each
    /// found by number or created with the kit's title block (FMC_TitleBlock : A1 from the sheets rulebook; any loaded
    /// FMC_TB_* or the first title block until it is loaded, reported), and the diagram drafting views already drawn placed
    /// at the centres the server gives, in mm from the sheet's lower-left corner. A view already on this sheet stays where a
    /// person put it; a view on another sheet is left there and reported. All in one transaction group: a dry run is the
    /// real run rolled back, a real run is one Undo. Never saves (rule 6).
    ///
    /// Drawn (fmc_diagram_drawn, read-only): every drafting view holding items fmc_diagram drew, with their FMC_DiagramSource
    /// keys, the tool's texts that print TBC, the person's own items and the sheets the view is on.
    /// </summary>
    public static class FmcDiagramSheet
    {
        private static double Ft(double mm) => mm / 304.8;

        public static JObject Sheets(Document doc, JObject p)
        {
            bool dry = p.Value<bool?>("dry_run") != false;
            var warnings = new List<string>();
            void Warn(string w) { if (!warnings.Contains(w)) warnings.Add(w); }
            var kcr = new JArray();
            void Request(string r) { if (!kcr.Any(x => x.Value<string>() == r)) kcr.Add(r); }
            var results = new JArray();
            var sheets = (p["sheets"] as JArray ?? new JArray()).OfType<JObject>().ToList();
            if (sheets.Count == 0) throw new InvalidOperationException("No sheets to make: the server sends the register sheets with their views.");

            using (var group = new TransactionGroup(doc, "Formcraft: line diagram sheets"))
            {
                group.Start();
                try
                {
                    foreach (JObject s in sheets)
                    {
                        string number = (s.Value<string>("number") ?? "").Trim();
                        using (var t = new Transaction(doc, "Formcraft: diagram sheet " + number))
                        {
                            var collector = FmcWarningCollector.On(t);
                            t.Start();
                            JObject row;
                            try { row = Sheet(doc, s, Warn, Request); }
                            catch (Exception e)
                            {
                                if (t.GetStatus() == TransactionStatus.Started) t.RollBack();
                                Warn($"sheet {number}: {e.Message}");
                                results.Add(new JObject { ["number"] = number, ["result"] = "skip", ["why"] = e.Message });
                                continue;
                            }
                            TransactionStatus status = t.Commit();
                            foreach (string w in collector.Warnings) Warn($"sheet {number}: Revit: {w}");
                            if (status != TransactionStatus.Committed)
                            {
                                Warn($"sheet {number}: Revit did not accept it ({status}); nothing was changed for it");
                                row = new JObject { ["number"] = number, ["result"] = "skip" };
                            }
                            results.Add(row);
                        }
                    }
                }
                finally
                {
                    if (dry) group.RollBack(); else group.Assimilate();
                }
            }
            if (dry) foreach (JObject r in results.OfType<JObject>()) r["sheet_id"] = JValue.CreateNull();
            return new JObject
            {
                ["dry_run"] = dry,
                ["result"] = dry ? "would place (rolled back)" : "placed",
                ["sheets"] = results,
                ["warnings"] = new JArray(warnings),
                ["kit_change_requests"] = kcr,
                ["note"] = "Viewports go where the server packed them in the kit's drawing area; a person arranges them before issue",
            };
        }

        private static JObject Sheet(Document doc, JObject s, Action<string> warn, Action<string> request)
        {
            string number = (s.Value<string>("number") ?? "").Trim();
            if (number.Length == 0) throw new InvalidOperationException("A sheet has no number.");
            string sheetName = (s.Value<string>("name") ?? "").Trim();
            ViewSheet sheet = new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>()
                .FirstOrDefault(x => !x.IsPlaceholder && string.Equals(x.SheetNumber, number, StringComparison.OrdinalIgnoreCase));
            bool created = false;
            string block = "kept";
            if (sheet == null)
            {
                var blocks = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_TitleBlocks).WhereElementIsElementType().Cast<FamilySymbol>().ToList();
                string wanted = (s.Value<string>("title_block") ?? "").Trim();
                FamilySymbol tb = wanted.Length == 0 ? null
                    : blocks.FirstOrDefault(b => $"{b.FamilyName} : {b.Name}" == wanted) ?? blocks.FirstOrDefault(b => b.FamilyName == wanted || b.Name == wanted);
                if (tb == null)
                {
                    request(wanted.Length > 0 ? $"Title block {wanted} isn't loaded in {doc.Title}: load it from the kit (04_Families, Z)" : $"No title block named for {number}");
                    tb = blocks.Where(b => b.FamilyName.StartsWith("FMC_TB_", StringComparison.Ordinal) || b.FamilyName.StartsWith("FMC_TitleBlock", StringComparison.Ordinal))
                        .OrderBy(b => b.FamilyName).FirstOrDefault() ?? blocks.FirstOrDefault();
                    if (tb != null) warn($"sheet {number}: made with {tb.FamilyName} : {tb.Name} until {wanted} is loaded; the viewport positions assume the kit's A1 sheet");
                }
                if (tb != null && !tb.IsActive) { tb.Activate(); doc.Regenerate(); }
                sheet = ViewSheet.Create(doc, tb?.Id ?? ElementId.InvalidElementId);
                sheet.SheetNumber = number;
                if (sheetName.Length > 0) sheet.Name = sheetName;
                block = tb != null ? $"{tb.FamilyName} : {tb.Name}" : "none";
                created = true;
                doc.Regenerate();
            }
            else if (sheetName.Length > 0 && sheet.Name != sheetName)
                warn($"sheet {number} is called \"{sheet.Name}\" in the model and \"{sheetName}\" in the register; the name is kept (fmc_sheets rename fixes it)");

            BoundingBoxUV o = sheet.Outline;
            var viewports = new FilteredElementCollector(doc).OfClass(typeof(Viewport)).Cast<Viewport>().ToList();
            var drafting = new FilteredElementCollector(doc).OfClass(typeof(ViewDrafting)).Cast<ViewDrafting>().Where(v => !v.IsTemplate).ToList();
            var placed = new JArray();
            foreach (JObject v in (s["views"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string vn = v.Value<string>("name") ?? "";
                ViewDrafting view = drafting.FirstOrDefault(x => x.Name == vn);
                if (view == null) { placed.Add(new JObject { ["view"] = vn, ["result"] = "not found: draw it first" }); continue; }
                Viewport existing = viewports.FirstOrDefault(x => x.ViewId == view.Id);
                if (existing != null)
                {
                    var on = doc.GetElement(existing.SheetId) as ViewSheet;
                    placed.Add(new JObject { ["view"] = vn, ["result"] = on != null && on.Id == sheet.Id ? "already on this sheet (kept where it is)" : $"already on {on?.SheetNumber}" });
                    continue;
                }
                if (!Viewport.CanAddViewToSheet(doc, sheet.Id, view.Id)) { placed.Add(new JObject { ["view"] = vn, ["result"] = "can't be placed" }); continue; }
                var c = v["center_mm"] as JArray;
                double cx = c != null && c.Count == 2 ? c[0].Value<double>() : 360, cy = c != null && c.Count == 2 ? c[1].Value<double>() : 300;
                Viewport.Create(doc, sheet.Id, view.Id, new XYZ(o.Min.U + Ft(cx), o.Min.V + Ft(cy), 0));
                placed.Add(new JObject { ["view"] = vn, ["result"] = "placed" });
            }
            return new JObject
            {
                ["number"] = sheet.SheetNumber, ["name"] = sheet.Name, ["sheet_id"] = sheet.Id.ToString(), ["result"] = created ? "create" : "update",
                ["title_block"] = block, ["views"] = placed,
            };
        }

        // ---------- Gate D: what is drawn (read-only) ----------

        private static readonly Regex Tbc = new Regex(@"\bTBC\b", RegexOptions.Compiled);

        public static JObject Drawn(Document doc, JObject p)
        {
            var only = new HashSet<string>((p["views"] as JArray ?? new JArray()).Select(x => x.Value<string>() ?? ""), StringComparer.OrdinalIgnoreCase);
            var onSheets = new Dictionary<ElementId, List<string>>();
            foreach (Viewport vp in new FilteredElementCollector(doc).OfClass(typeof(Viewport)).Cast<Viewport>())
            {
                if (!(doc.GetElement(vp.SheetId) is ViewSheet sh)) continue;
                if (!onSheets.TryGetValue(vp.ViewId, out var list)) onSheets[vp.ViewId] = list = new List<string>();
                if (!list.Contains(sh.SheetNumber)) list.Add(sh.SheetNumber);
            }
            var views = new JArray();
            foreach (ViewDrafting view in new FilteredElementCollector(doc).OfClass(typeof(ViewDrafting)).Cast<ViewDrafting>())
            {
                if (view.IsTemplate) continue;
                if (only.Count > 0 && !only.Contains(view.Name)) continue;
                var keys = new SortedSet<string>(StringComparer.Ordinal);
                int symbols = 0, lines = 0, texts = 0, tbc = 0, kept = 0;
                foreach (Element e in new FilteredElementCollector(doc, view.Id).WhereElementIsNotElementType())
                {
                    if (e.Id == view.Id || e.OwnerViewId != view.Id) continue;
                    string key = FmcDiagramDraw.SourceOf(e);
                    if (key.Length == 0)
                    {
                        if (e is TextNote || e is CurveElement || e is FamilyInstance || e is Dimension || e is FilledRegion || e is IndependentTag || e is Autodesk.Revit.DB.Group) kept++;
                        continue;
                    }
                    keys.Add(key);
                    if (e is FamilyInstance) symbols++;
                    else if (e is CurveElement) lines++;
                    else if (e is TextNote tn) { texts++; if (Tbc.IsMatch(tn.Text ?? "")) tbc++; }
                }
                if (keys.Count == 0) continue;
                views.Add(new JObject
                {
                    ["name"] = view.Name, ["view_id"] = view.Id.ToString(), ["keys"] = new JArray(keys),
                    ["symbols"] = symbols, ["lines"] = lines, ["texts"] = texts, ["tbc_texts"] = tbc, ["kept_by_hand"] = kept,
                    ["sheets"] = new JArray(onSheets.TryGetValue(view.Id, out var nums) ? nums : new List<string>()),
                });
            }
            return new JObject { ["model"] = doc.Title, ["views"] = views };
        }
    }
}
