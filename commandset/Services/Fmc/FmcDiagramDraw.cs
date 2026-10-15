using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.ExtensibleStorage;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_diagram_draw (track LD): drafting views from a DRAW_SPEC (server/src/fmc/diagram/contract.ts), answered with a
    /// DRAW_RESULT. Everything runs in one transaction group, rolled back on a dry run. Each item this tool draws keeps a
    /// source key in extensible storage ("view|source_id or index|t"), so a second run deletes and redraws only those and
    /// keeps what a person added. Symbols come only from families already loaded (never from disk); the document is never
    /// saved (rule 6). Revit's warnings are collected instead of shown, because a dialog would block the bridge.
    /// </summary>
    public static class FmcDiagramDraw
    {
        private static readonly Guid SourceSchemaId = new Guid("a9d9490d-63e7-4081-82bd-1ebf5b80654f");
        private const string SourceField = "Key";

        private static double Mm(double v) => UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters);

        private sealed class Collector : IFailuresPreprocessor
        {
            public readonly List<string> Warnings = new List<string>();
            public FailureProcessingResult PreprocessFailures(FailuresAccessor a)
            {
                foreach (FailureMessageAccessor f in a.GetFailureMessages())
                {
                    if (f.GetSeverity() == FailureSeverity.Warning) { Warnings.Add(f.GetDescriptionText()); a.DeleteWarning(f); }
                }
                return FailureProcessingResult.Continue;
            }
        }

        // ---------- source key (extensible storage) ----------

        private static Schema SourceSchema()
        {
            Schema s = Schema.Lookup(SourceSchemaId);
            if (s != null) return s;
            var b = new SchemaBuilder(SourceSchemaId);
            b.SetSchemaName("FMC_DiagramSource");
            b.SetReadAccessLevel(AccessLevel.Public);
            b.SetWriteAccessLevel(AccessLevel.Public);
            b.SetVendorId("Formcraft");
            b.AddSimpleField(SourceField, typeof(string));
            return b.Finish();
        }

        /// <summary>The source key this tool stored on an element, or "" for anything a person drew.</summary>
        public static string SourceOf(Element e)
        {
            Schema s = Schema.Lookup(SourceSchemaId);
            if (s == null) return "";
            try
            {
                Entity en = e.GetEntity(s);
                return en.IsValid() ? en.Get<string>(SourceField) ?? "" : "";
            }
            catch (Exception) { return ""; }
        }

        private static void MarkSource(Element e, string key)
        {
            var en = new Entity(SourceSchema());
            en.Set(SourceField, key);
            e.SetEntity(en);
        }

        // ---------- draw ----------

        private sealed class Kit
        {
            public Dictionary<string, FamilySymbol> Symbols;
            public Dictionary<string, GraphicsStyle> LineStyles;
            public Dictionary<string, ElementId> TextTypes;
            public ElementId DefaultText;
            public ElementId DraftingType;
        }

        public static JObject Draw(Document doc, JObject p)
        {
            JObject spec = p["spec"] as JObject ?? p;
            var views = (spec["views"] as JArray ?? new JArray()).OfType<JObject>().ToList();
            if (views.Count == 0) throw new InvalidOperationException("The draw spec has no views.");
            bool dry = spec.Value<bool?>("dry_run") ?? p.Value<bool?>("dry_run") ?? true;

            var warnings = new List<string>();
            void Warn(string w) { if (!warnings.Contains(w)) warnings.Add(w); }

            var kit = LoadKit(doc);
            var results = new JArray();
            using (var group = new TransactionGroup(doc, "Formcraft: line diagrams"))
            {
                group.Start();
                foreach (JObject v in views)
                {
                    string name = (v.Value<string>("name") ?? "").Trim();
                    int scale = Math.Max(1, v.Value<int?>("scale") ?? 50);
                    var row = new JObject
                    {
                        ["name"] = name, ["result"] = "skip", ["view_id"] = JValue.CreateNull(),
                        ["symbols"] = 0, ["lines"] = 0, ["texts"] = 0, ["kept_by_hand"] = 0,
                    };
                    results.Add(row);
                    if (name.Length == 0) { Warn("A view has no name; skipped."); continue; }

                    var collector = new Collector();
                    using (var t = new Transaction(doc, "Diagram " + name))
                    {
                        var fho = t.GetFailureHandlingOptions();
                        fho.SetFailuresPreprocessor(collector);
                        t.SetFailureHandlingOptions(fho);
                        t.Start();
                        try
                        {
                            var counts = DrawView(doc, kit, v, name, scale, dry, row, Warn);
                            if (counts == null) { t.RollBack(); continue; }
                            TransactionStatus status = t.Commit();
                            if (status != TransactionStatus.Committed)
                            {
                                Warn($"{name}: Revit did not accept the drawing ({status}); nothing was changed in this view.");
                                row["result"] = "skip";
                                row["view_id"] = JValue.CreateNull();
                                row["symbols"] = 0; row["lines"] = 0; row["texts"] = 0;
                            }
                        }
                        catch (Exception ex)
                        {
                            if (t.GetStatus() == TransactionStatus.Started) t.RollBack();
                            Warn($"{name}: {ex.Message}");
                            row["result"] = "skip";
                            row["view_id"] = JValue.CreateNull();
                            row["symbols"] = 0; row["lines"] = 0; row["texts"] = 0;
                        }
                    }
                    foreach (string w in collector.Warnings) Warn($"{name}: Revit: {w}");
                }
                if (dry) group.RollBack();
                else group.Assimilate();
            }
            // A view made in a dry run was rolled back, so it has no id.
            if (dry) foreach (JObject r in results.OfType<JObject>()) if (r.Value<string>("result") == "create") r["view_id"] = JValue.CreateNull();

            return new JObject { ["dry_run"] = dry, ["views"] = results, ["warnings"] = new JArray(warnings) };
        }

        private static Kit LoadKit(Document doc)
        {
            var kit = new Kit
            {
                Symbols = new Dictionary<string, FamilySymbol>(),
                LineStyles = new Dictionary<string, GraphicsStyle>(StringComparer.OrdinalIgnoreCase),
                TextTypes = new Dictionary<string, ElementId>(StringComparer.OrdinalIgnoreCase),
            };
            foreach (FamilySymbol s in new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>())
            {
                Category cat = s.Family?.FamilyCategory;
                if (cat == null) continue;
                long id = cat.Id.Value;
                if (id != (long)BuiltInCategory.OST_GenericAnnotation && id != (long)BuiltInCategory.OST_DetailComponents) continue;
                string key = (s.FamilyName ?? "") + ":" + s.Name;
                if (!kit.Symbols.ContainsKey(key)) kit.Symbols[key] = s;
            }
            Category lines = doc.Settings.Categories.get_Item(BuiltInCategory.OST_Lines);
            if (lines != null)
                foreach (Category sub in lines.SubCategories)
                {
                    GraphicsStyle gs = sub.GetGraphicsStyle(GraphicsStyleType.Projection);
                    if (gs != null && !kit.LineStyles.ContainsKey(sub.Name)) kit.LineStyles[sub.Name] = gs;
                }
            foreach (TextNoteType tt in new FilteredElementCollector(doc).OfClass(typeof(TextNoteType)).Cast<TextNoteType>())
                if (!kit.TextTypes.ContainsKey(tt.Name)) kit.TextTypes[tt.Name] = tt.Id;
            kit.DefaultText = doc.GetDefaultElementTypeId(ElementTypeGroup.TextNoteType);
            if (kit.DefaultText == null || kit.DefaultText == ElementId.InvalidElementId) kit.DefaultText = kit.TextTypes.Values.FirstOrDefault();
            kit.DraftingType = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>()
                .FirstOrDefault(x => x.ViewFamily == ViewFamily.Drafting)?.Id;
            return kit;
        }

        /// <summary>Draws one view inside an open transaction. Null when the view can't be used (the caller rolls back).</summary>
        private static JObject DrawView(Document doc, Kit kit, JObject v, string name, int scale, bool dry, JObject row, Action<string> warn)
        {
            ViewDrafting view = new FilteredElementCollector(doc).OfClass(typeof(ViewDrafting)).Cast<ViewDrafting>()
                .FirstOrDefault(x => !x.IsTemplate && x.Name == name);
            bool created = false;
            if (view == null)
            {
                bool taken = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Any(x => !x.IsTemplate && x.Name == name);
                if (taken) { warn($"{name}: another view (not a drafting view) already has this name; skipped."); return null; }
                if (kit.DraftingType == null) { warn("The model has no drafting view type; no diagrams can be drawn."); return null; }
                view = ViewDrafting.Create(doc, kit.DraftingType);
                view.Name = name;
                created = true;
            }
            try { if (view.Scale != scale) view.Scale = scale; }
            catch (Exception) { warn($"{name}: the scale is set by its view template; kept 1:{view.Scale}."); }

            // Items this tool drew before are deleted and redrawn; a person's notes are kept and counted.
            int kept = 0;
            var ours = new List<ElementId>();
            if (!created)
                foreach (Element e in new FilteredElementCollector(doc, view.Id).WhereElementIsNotElementType())
                {
                    if (e.Id == view.Id || e.OwnerViewId != view.Id) continue;
                    if (SourceOf(e).Length > 0) ours.Add(e.Id);
                    else if (e is TextNote || e is CurveElement || e is FamilyInstance || e is Dimension || e is FilledRegion
                             || e is IndependentTag || e is Group) kept++;
                }
            if (ours.Count > 0) doc.Delete(ours);

            int symbols = 0, lines = 0, texts = 0, index = 0;
            double shortest = doc.Application.ShortCurveTolerance;
            XYZ At(JToken xy)
            {
                var a = xy as JArray;
                if (a == null || a.Count != 2) throw new InvalidOperationException("a point must be [x, y] in paper mm");
                return new XYZ(Mm(a[0].Value<double>() * scale), Mm(a[1].Value<double>() * scale), 0);
            }

            foreach (JObject item in (v["items"] as JArray ?? new JArray()).OfType<JObject>())
            {
                int i = index++;
                string t = item.Value<string>("t") ?? "";
                string src = item.Value<string>("source_id");
                string key = name + "|" + (string.IsNullOrEmpty(src) ? i.ToString(CultureInfo.InvariantCulture) : src) + "|" + t;
                try
                {
                    switch (t)
                    {
                        case "symbol":
                        {
                            string fam = item.Value<string>("family") ?? "", typ = item.Value<string>("type") ?? "";
                            if (!kit.Symbols.TryGetValue(fam + ":" + typ, out FamilySymbol sym))
                            {
                                warn($"symbol {fam}:{typ} isn't loaded (load the released family)");
                                break;
                            }
                            if (!sym.IsActive) { sym.Activate(); doc.Regenerate(); }
                            XYZ pt = At(item["at"]);
                            FamilyInstance inst = doc.Create.NewFamilyInstance(pt, sym, view);
                            double deg = item.Value<double?>("rotation_deg") ?? 0;
                            if (Math.Abs(deg) > 1e-9)
                                ElementTransformUtils.RotateElement(doc, inst.Id, Line.CreateBound(pt, pt + XYZ.BasisZ), deg * Math.PI / 180);
                            if (item["params"] is JObject prms)
                                foreach (var kv in prms)
                                    SetParam(inst, kv.Key, kv.Value?.Type == JTokenType.Null ? "" : kv.Value?.ToString() ?? "", fam + ":" + typ, warn);
                            MarkSource(inst, key);
                            symbols++;
                            break;
                        }
                        case "line":
                        {
                            var pts = (item["points"] as JArray ?? new JArray()).Select(At).ToList();
                            string styleName = item.Value<string>("style") ?? "";
                            if (!kit.LineStyles.TryGetValue(styleName, out GraphicsStyle gs))
                            {
                                kit.LineStyles.TryGetValue("Thin Lines", out gs);
                                warn($"line style {styleName} isn't in the model; drawn with Thin Lines");
                            }
                            for (int k = 0; k + 1 < pts.Count; k++)
                            {
                                if (pts[k].DistanceTo(pts[k + 1]) <= shortest) { warn($"{name}: a line segment is too short to draw; skipped."); continue; }
                                DetailCurve dc = doc.Create.NewDetailCurve(view, Line.CreateBound(pts[k], pts[k + 1]));
                                if (gs != null) dc.LineStyle = gs;
                                MarkSource(dc, key);
                                lines++;
                            }
                            break;
                        }
                        case "text":
                        {
                            string text = item.Value<string>("text") ?? "";
                            if (text.Trim().Length == 0) { warn($"{name}: an empty text was skipped."); break; }
                            string styleName = item.Value<string>("style") ?? "";
                            if (!kit.TextTypes.TryGetValue(styleName, out ElementId typeId))
                            {
                                typeId = kit.DefaultText;
                                warn($"text type {styleName} isn't in the model; drawn with the default text type");
                            }
                            if (typeId == null) { warn("The model has no text type; texts were skipped."); break; }
                            var opts = new TextNoteOptions(typeId);
                            switch ((item.Value<string>("align") ?? "left").ToLowerInvariant())
                            {
                                case "center": opts.HorizontalAlignment = HorizontalTextAlignment.Center; break;
                                case "right": opts.HorizontalAlignment = HorizontalTextAlignment.Right; break;
                                default: opts.HorizontalAlignment = HorizontalTextAlignment.Left; break;
                            }
                            // DRAW_CONVENTIONS: `at` is the top of the text box at its alignment side, and rotation_deg
                            // turns the note counter-clockwise about that point (Revit's rotation is counter-clockwise too).
                            opts.VerticalAlignment = VerticalTextAlignment.Top;
                            double textDeg = item.Value<double?>("rotation_deg") ?? 0;
                            if (Math.Abs(textDeg) > 1e-9)
                            {
                                opts.Rotation = textDeg * Math.PI / 180;
                                opts.KeepRotatedTextReadable = false;
                            }
                            TextNote note = TextNote.Create(doc, view.Id, At(item["at"]), text.Replace("\r\n", "\n").Replace("\n", "\r"), opts);
                            MarkSource(note, key);
                            texts++;
                            break;
                        }
                        default:
                            warn($"{name}: item {i} has an unknown kind '{t}'; skipped.");
                            break;
                    }
                }
                catch (Exception ex)
                {
                    warn($"{name}: item {i} ({t}) was not drawn: {ex.Message}");
                }
            }

            row["result"] = created ? "create" : "update";
            row["view_id"] = view.Id.ToString();
            row["symbols"] = symbols;
            row["lines"] = lines;
            row["texts"] = texts;
            row["kept_by_hand"] = kept;
            return row;
        }

        /// <summary>Sets an instance parameter (a label) from text: strings as they are, numbers in the project's units.</summary>
        private static void SetParam(FamilyInstance inst, string name, string value, string symbol, Action<string> warn)
        {
            Parameter par = inst.LookupParameter(name);
            if (par == null) { warn($"{symbol} has no instance parameter {name}"); return; }
            if (par.IsReadOnly) { warn($"{symbol}: {name} is read-only"); return; }
            bool ok;
            switch (par.StorageType)
            {
                case StorageType.String:
                    ok = par.Set(value);
                    break;
                case StorageType.Integer:
                    string low = value.Trim().ToLowerInvariant();
                    if (low == "yes" || low == "true") ok = par.Set(1);
                    else if (low == "no" || low == "false") ok = par.Set(0);
                    else ok = int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out int n) && par.Set(n);
                    break;
                case StorageType.Double:
                    ok = value.Trim().Length > 0 && par.SetValueString(value);
                    break;
                default:
                    ok = false;
                    break;
            }
            if (!ok) warn($"{symbol}: {name} could not be set to \"{value}\"");
        }
    }
}
