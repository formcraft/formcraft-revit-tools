using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_ceiling_sheet (CL4, docs/PLAN_CEILINGS.md): the ceiling drawings, all in one transaction group (a dry run is the
    /// real run rolled back; a real run is one Undo).
    ///  1. drafting: the board set-out and the schematic section as drafting views, drawn by FmcDiagramDraw from the
    ///     server's items (server/src/fmc/ceiling/drawings.ts), each item with a source key so a second run redraws only
    ///     its own items and keeps a person's notes;
    ///  2. rcp: the room's reflected ceiling plan on its level with the kit's view template (VT_I_RCP) and scale, cropped
    ///     to the room, with the kit's FMC_SYM_* symbols at the marks, height symbols and texts, and the key;
    ///  3. sheet: the RCP sheet (number and name from the kit's sheet register) with a loaded FMC_TB_* title block, and the
    ///     three views placed on it if they aren't on a sheet yet.
    /// Symbols, templates and title blocks come only from what the model has loaded; a missing one is reported.
    /// </summary>
    public static class FmcCeilingSheet
    {
        private static double Ft(double mm) => mm / 304.8;

        public static JObject Run(Document doc, JObject p)
        {
            bool dry = p.Value<bool?>("dry_run") != false;
            string room = p.Value<string>("room") ?? "Room";
            var warnings = new List<string>();
            void Warn(string w) { if (!warnings.Contains(w)) warnings.Add(w); }
            var kcr = new JArray();
            void Request(string r) { if (!kcr.Any(x => x.Value<string>() == r)) kcr.Add(r); }
            JObject drafting = null, rcp = null, sheet = null;

            using (var group = new TransactionGroup(doc, "Formcraft: ceiling drawings " + room))
            {
                group.Start();
                try
                {
                    if (p["drafting"] is JObject spec && (spec["views"] as JArray)?.Count > 0)
                    {
                        // drawn for real inside this group; the group decides whether it stays
                        var inner = (JObject)spec.DeepClone();
                        inner["dry_run"] = false;
                        drafting = FmcDiagramDraw.Draw(doc, new JObject { ["spec"] = inner });
                        foreach (string w in (drafting["warnings"] as JArray ?? new JArray()).Select(x => x.Value<string>())) Warn(w);
                    }
                    if (p["rcp"] is JObject r) rcp = InTransaction(doc, "Formcraft: RCP " + room, Warn, () => Rcp(doc, r, Warn, Request));
                    if (p["sheet"] is JObject s) sheet = InTransaction(doc, "Formcraft: RCP sheet " + room, Warn, () => Sheet(doc, s, Warn, Request));
                }
                finally
                {
                    if (dry) group.RollBack(); else group.Assimilate();
                }
            }
            if (dry && drafting?["views"] is JArray dv) foreach (JObject v in dv.OfType<JObject>()) v["view_id"] = JValue.CreateNull();
            if (dry && rcp != null) rcp["view_id"] = JValue.CreateNull();
            return new JObject
            {
                ["dry_run"] = dry,
                ["result"] = dry ? "would draw (rolled back)" : "drawn",
                ["drafting"] = drafting ?? new JObject(),
                ["rcp"] = rcp ?? new JObject(),
                ["sheet"] = sheet ?? new JObject(),
                ["warnings"] = new JArray(warnings),
                ["kit_change_requests"] = kcr,
            };
        }

        private static JObject InTransaction(Document doc, string name, Action<string> warn, Func<JObject> body)
        {
            using (var t = new Transaction(doc, name))
            {
                var collector = FmcWarningCollector.On(t);
                t.Start();
                JObject result;
                try { result = body(); }
                catch (Exception e)
                {
                    if (t.GetStatus() == TransactionStatus.Started) t.RollBack();
                    warn($"{name}: {e.Message}");
                    return new JObject { ["result"] = "skip", ["why"] = e.Message };
                }
                TransactionStatus status = t.Commit();
                foreach (string w in collector.Warnings) warn($"{name}: Revit: {w}");
                if (status != TransactionStatus.Committed) { warn($"{name}: Revit did not accept it ({status})"); return new JObject { ["result"] = "skip" }; }
                return result;
            }
        }

        // ---------- the reflected ceiling plan ----------

        private static JObject Rcp(Document doc, JObject r, Action<string> warn, Action<string> request)
        {
            string name = (r.Value<string>("view_name") ?? "").Trim();
            if (name.Length == 0) throw new InvalidOperationException("The RCP has no view name.");
            string levelName = r.Value<string>("level") ?? "";
            Level level = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>()
                .FirstOrDefault(l => string.Equals(l.Name, levelName, StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException($"No level {levelName} in {doc.Title}");
            ViewPlan view = new FilteredElementCollector(doc).OfClass(typeof(ViewPlan)).Cast<ViewPlan>()
                .FirstOrDefault(v => !v.IsTemplate && v.ViewType == ViewType.CeilingPlan && v.Name == name);
            bool created = false;
            if (view == null)
            {
                if (new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Any(v => !v.IsTemplate && v.Name == name))
                    throw new InvalidOperationException($"another view (not a ceiling plan) is called {name}");
                ViewFamilyType vft = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>()
                    .FirstOrDefault(x => x.ViewFamily == ViewFamily.CeilingPlan)
                    ?? throw new InvalidOperationException("The model has no ceiling plan view type");
                view = ViewPlan.Create(doc, vft.Id, level.Id);
                view.Name = name;
                created = true;
            }
            string templateName = r.Value<string>("template") ?? "";
            View template = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().FirstOrDefault(v => v.IsTemplate && v.Name == templateName);
            string templateResult;
            if (template == null)
            {
                templateResult = "not in the model";
                request($"View template {templateName} isn't in {doc.Title}: start the model from the kit's I template (FMC_I_Template_v2.2.rte) or transfer it");
            }
            else
            {
                try { view.ViewTemplateId = template.Id; templateResult = template.Name; }
                catch (Exception e) { templateResult = "not applied"; warn($"{name}: {templateName} could not be applied: {e.Message}"); }
            }
            int scale = Math.Max(1, r.Value<int?>("scale") ?? 50);
            try { if (view.Scale != scale) view.Scale = scale; }
            catch (Exception) { warn($"{name}: the scale is set by its view template; kept 1:{view.Scale}."); }
            if (r["crop_mm"] is JArray crop && crop.Count == 4)
            {
                try
                {
                    BoundingBoxXYZ bb = view.CropBox;
                    bb.Min = new XYZ(Ft(crop[0].Value<double>()), Ft(crop[1].Value<double>()), bb.Min.Z);
                    bb.Max = new XYZ(Ft(crop[2].Value<double>()), Ft(crop[3].Value<double>()), bb.Max.Z);
                    view.CropBox = bb;
                    view.CropBoxActive = true;
                }
                catch (Exception e) { warn($"{name}: crop not set: {e.Message}"); }
            }

            // what this tool drew before in the view is redrawn; a person's annotation stays
            int kept = 0;
            var ours = new List<ElementId>();
            if (!created)
                foreach (Element e in new FilteredElementCollector(doc, view.Id).WhereElementIsNotElementType())
                {
                    if (e.OwnerViewId != view.Id) continue;
                    if (FmcDiagramDraw.SourceOf(e).StartsWith("rcp:", StringComparison.Ordinal)) ours.Add(e.Id);
                    else if (e is TextNote || e is FamilyInstance || e is IndependentTag) kept++;
                }
            if (ours.Count > 0) doc.Delete(ours);

            var loaded = new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>()
                .Where(s => s.Family?.FamilyCategory != null && s.Family.FamilyCategory.Id.Value == (long)BuiltInCategory.OST_GenericAnnotation).ToList();
            var missing = new SortedSet<string>();
            int symbols = 0, texts = 0;
            foreach (JObject s in (r["symbols"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string fam = s.Value<string>("family") ?? "", typ = s.Value<string>("type") ?? "";
                var ofFamily = loaded.Where(x => x.FamilyName == fam).ToList();
                FamilySymbol sym = ofFamily.FirstOrDefault(x => x.Name == typ) ?? (ofFamily.Count == 1 ? ofFamily[0] : null);
                if (sym == null) { missing.Add(fam); continue; }
                try
                {
                    if (!sym.IsActive) { sym.Activate(); doc.Regenerate(); }
                    var at = s["at"] as JArray;
                    FamilyInstance fi = doc.Create.NewFamilyInstance(new XYZ(Ft(at[0].Value<double>()), Ft(at[1].Value<double>()), level.Elevation), sym, view);
                    FmcDiagramDraw.MarkSource(fi, s.Value<string>("key") ?? "rcp:symbol");
                    symbols++;
                }
                catch (Exception e) { warn($"{name}: {fam} not placed: {e.Message}"); }
            }
            foreach (string fam in missing)
                request($"{fam} isn't loaded in {doc.Title}: load it from the kit (04_Families; it is still in _Staging until a person releases it). The RCP has no symbol for it yet");

            var textTypes = new FilteredElementCollector(doc).OfClass(typeof(TextNoteType)).Cast<TextNoteType>().ToList();
            ElementId defaultText = doc.GetDefaultElementTypeId(ElementTypeGroup.TextNoteType);
            foreach (JObject tx in (r["texts"] as JArray ?? new JArray()).OfType<JObject>())
            {
                string text = tx.Value<string>("text") ?? "";
                if (text.Trim().Length == 0) continue;
                string style = tx.Value<string>("style") ?? "";
                ElementId typeId = textTypes.FirstOrDefault(x => x.Name == style)?.Id;
                if (typeId == null) { typeId = defaultText; warn($"text type {style} isn't in the model; the default text type is used"); }
                if (typeId == null || typeId == ElementId.InvalidElementId) { warn("The model has no text type; texts were skipped."); break; }
                var at = tx["at"] as JArray;
                var opts = new TextNoteOptions(typeId) { HorizontalAlignment = HorizontalTextAlignment.Left, VerticalAlignment = VerticalTextAlignment.Top };
                TextNote note = TextNote.Create(doc, view.Id, new XYZ(Ft(at[0].Value<double>()), Ft(at[1].Value<double>()), level.Elevation),
                    text.Replace("\r\n", "\n").Replace("\n", "\r"), opts);
                FmcDiagramDraw.MarkSource(note, tx.Value<string>("key") ?? "rcp:text");
                texts++;
            }
            return new JObject
            {
                ["name"] = name, ["result"] = created ? "create" : "update", ["view_id"] = view.Id.ToString(), ["template"] = templateResult,
                ["scale"] = view.Scale, ["symbols"] = symbols, ["texts"] = texts, ["symbols_not_loaded"] = new JArray(missing), ["kept_by_hand"] = kept,
            };
        }

        // ---------- the sheet ----------

        private static JObject Sheet(Document doc, JObject s, Action<string> warn, Action<string> request)
        {
            string number = (s.Value<string>("number") ?? "").Trim();
            if (number.Length == 0) throw new InvalidOperationException("The sheet has no number.");
            string sheetName = s.Value<string>("name") ?? "";
            ViewSheet sheet = new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>()
                .FirstOrDefault(x => !x.IsPlaceholder && string.Equals(x.SheetNumber, number, StringComparison.OrdinalIgnoreCase));
            bool created = false;
            string block = "";
            if (sheet == null)
            {
                var blocks = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_TitleBlocks).WhereElementIsElementType().Cast<FamilySymbol>().ToList();
                string wanted = (s.Value<string>("title_block") ?? "").Trim();
                FamilySymbol tb = wanted.Length > 0
                    ? blocks.FirstOrDefault(b => b.FamilyName == wanted || b.Name == wanted || $"{b.FamilyName} : {b.Name}" == wanted)
                    : blocks.Where(b => b.FamilyName.StartsWith("FMC_TB_", StringComparison.Ordinal)).OrderBy(b => b.FamilyName).FirstOrDefault();
                if (tb == null)
                {
                    request(wanted.Length > 0 ? $"Title block {wanted} isn't loaded in {doc.Title}" : $"No FMC_TB_* title block is loaded in {doc.Title}: load one from the kit (04_Families, Z)");
                    tb = blocks.FirstOrDefault();
                    if (tb != null) warn($"sheet {number}: drawn with {tb.FamilyName} : {tb.Name} until the kit's title block is loaded");
                }
                if (tb != null && !tb.IsActive) { tb.Activate(); doc.Regenerate(); }
                sheet = ViewSheet.Create(doc, tb?.Id ?? ElementId.InvalidElementId);
                sheet.SheetNumber = number;
                if (sheetName.Length > 0) sheet.Name = sheetName;
                block = tb != null ? $"{tb.FamilyName} : {tb.Name}" : "none";
                created = true;
                doc.Regenerate();
            }
            BoundingBoxUV o = sheet.Outline;
            double w = o.Max.U - o.Min.U, h = o.Max.V - o.Min.V;
            if (w <= 0 || h <= 0) { w = Ft(420); h = Ft(297); }
            var spots = new[] { new UV(0.33, 0.55), new UV(0.76, 0.66), new UV(0.76, 0.27) };
            var placed = new JArray();
            var viewNames = (s["views"] as JArray ?? new JArray()).Select(x => x.Value<string>()).ToList();
            var viewports = new FilteredElementCollector(doc).OfClass(typeof(Viewport)).Cast<Viewport>().ToList();
            for (int i = 0; i < viewNames.Count; i++)
            {
                string vn = viewNames[i];
                View v = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().FirstOrDefault(x => !x.IsTemplate && x.Name == vn && !(x is ViewSheet));
                if (v == null) { placed.Add(new JObject { ["view"] = vn, ["result"] = "not found" }); continue; }
                Viewport existing = viewports.FirstOrDefault(x => x.ViewId == v.Id);
                if (existing != null)
                {
                    var on = doc.GetElement(existing.SheetId) as ViewSheet;
                    placed.Add(new JObject { ["view"] = vn, ["result"] = $"already on {on?.SheetNumber}" });
                    continue;
                }
                if (!Viewport.CanAddViewToSheet(doc, sheet.Id, v.Id)) { placed.Add(new JObject { ["view"] = vn, ["result"] = "can't be placed" }); continue; }
                UV f = spots[Math.Min(i, spots.Length - 1)];
                Viewport.Create(doc, sheet.Id, v.Id, new XYZ(o.Min.U + f.U * w, o.Min.V + f.V * h, 0));
                placed.Add(new JObject { ["view"] = vn, ["result"] = "placed" });
            }
            return new JObject
            {
                ["number"] = sheet.SheetNumber, ["name"] = sheet.Name, ["result"] = created ? "create" : "update", ["title_block"] = created ? block : "kept",
                ["views"] = placed, ["note"] = "Viewports are placed roughly; a person arranges them on the sheet",
            };
        }
    }
}
